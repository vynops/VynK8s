const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { maintenanceReasons } = require('./update-policy.js')

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_UPDATE_SIZE = 100 * 1024 * 1024
const VERSION_FILE = 'apps/web/release-version.json'

function validatePath(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 1024 ||
      name.startsWith('/') || name.includes('\\') || name.includes(':') || name.includes('\0')) {
    throw new Error('Release contains an invalid path')
  }
  const parts = name.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Release contains an invalid path')
  }
  return parts
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' ||
      typeof manifest.commit !== 'string' || !/^[a-f0-9]{40}$/i.test(manifest.commit) ||
      typeof manifest.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.date) ||
      Number.isNaN(Date.parse(manifest.date)) ||
      typeof manifest.dataCompatible !== 'boolean' || !manifest.files ||
      typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Invalid release manifest')
  }
  const names = Object.keys(manifest.files)
  if (names.length > 10000) throw new Error('Release contains too many files')
  const normalized = new Set()
  for (const name of names) {
    validatePath(name)
    if (name.toLowerCase() === VERSION_FILE) throw new Error('Release contains a reserved metadata path')
    const key = name.toLowerCase()
    if (normalized.has(key)) throw new Error('Release contains conflicting paths')
    normalized.add(key)
    const file = manifest.files[name]
    if (!file || typeof file !== 'object' || typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.executable !== 'boolean') {
      throw new Error('Invalid file metadata in release manifest')
    }
  }
}

function inspect(root, name) {
  const parts = validatePath(name)
  let current = root
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i])
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${name}`)
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Invalid parent directory: ${name}`)
    if (i === parts.length - 1) {
      if (!stat.isFile() || stat.size > MAX_FILE_SIZE) throw new Error(`Invalid or oversized file: ${name}`)
      const content = fs.readFileSync(current)
      return { content, sha256: digest(content), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid }
    }
  }
  return null
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex')
}

function matches(actual, expected) {
  if (!actual || !expected || actual.sha256 !== expected.sha256.toLowerCase()) return false
  return process.platform === 'win32' || Boolean(actual.mode & 0o111) === expected.executable
}

function sameMode(actual, expected) {
  return process.platform === 'win32' ? (actual & 0o200) === (expected & 0o200) : actual === expected
}

function sameOwner(actual, expected) {
  return process.platform === 'win32' || (actual.uid === expected.uid && actual.gid === expected.gid)
}

function targetMode(change) {
  let mode = change.before ? change.before.mode : (change.after.executable ? 0o755 : 0o644)
  if (process.platform !== 'win32') mode = change.after.executable ? mode | 0o100 : mode & ~0o111
  return mode
}

function manifestFile(manifest, name) {
  return Object.prototype.hasOwnProperty.call(manifest.files, name) ? manifest.files[name] : null
}

async function prepareUpdate(root, base, target, releaseBody, download) {
  validateManifest(base)
  validateManifest(target)
  if (!target.dataCompatible) throw new Error('Release has not been confirmed compatible with client data')
  const rootPath = fs.realpathSync(root)
  if (!fs.statSync(rootPath).isDirectory()) throw new Error('Invalid installation directory')
  const names = [...new Set([...Object.keys(base.files), ...Object.keys(target.files)])]
    .filter(name => {
      const before = manifestFile(base, name)
      const after = manifestFile(target, name)
      return !before || !after || before.sha256.toLowerCase() !== after.sha256.toLowerCase() ||
        before.executable !== after.executable
    })
  if (names.length > 300) throw new Error('Update contains too many changed files')
  const folded = new Set()
  for (const name of names) {
    const key = name.toLowerCase()
    if (folded.has(key)) throw new Error('Update contains conflicting paths')
    folded.add(key)
  }
  const reasons = maintenanceReasons(releaseBody, names.map(filename => ({ filename })))
  if (reasons.length) throw new Error(reasons.join(' '))
  const versionBefore = inspect(rootPath, VERSION_FILE)
  if (!versionBefore) throw new Error('Installed release metadata is unavailable')
  let recorded
  try {
    recorded = JSON.parse(versionBefore.content.toString('utf8'))
  } catch {
    throw new Error('Installed release metadata is invalid')
  }
  if (!isDeepStrictEqual(recorded, base)) throw new Error('Installed release metadata changed during preparation')

  let total = 0
  let originalTotal = 0
  const changes = []
  for (const name of names) {
    const before = manifestFile(base, name)
    const after = manifestFile(target, name)
    const actual = inspect(rootPath, name)
    if ((!after && !actual) || matches(actual, after)) continue
    if ((before && !matches(actual, before)) || (!before && actual)) {
      throw new Error(`Client file conflicts with release: ${name}`)
    }
    if (actual && (originalTotal += actual.content.length) > MAX_UPDATE_SIZE) {
      throw new Error('Existing files are too large for automatic installation')
    }
    let content = null
    if (after) {
      if (after.size > MAX_FILE_SIZE || (total += after.size) > MAX_UPDATE_SIZE) {
        throw new Error('Update is too large for automatic installation')
      }
      content = await download(name, after)
      if (!Buffer.isBuffer(content) || content.length !== after.size || digest(content) !== after.sha256.toLowerCase()) {
        throw new Error(`Downloaded file failed integrity verification: ${name}`)
      }
    }
    changes.push({ name, before: actual, after, content })
  }
  if (base.commit !== target.commit) {
    const content = Buffer.from(JSON.stringify(target) + '\n')
    if (content.length > MAX_FILE_SIZE) throw new Error('Release metadata is too large')
    changes.push({
      name: VERSION_FILE,
      before: versionBefore,
      after: { sha256: digest(content), size: content.length, executable: false },
      content,
    })
  }
  return { root: rootPath, changes }
}

function ensureParents(root, name, created) {
  const parts = validatePath(name)
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid parent directory: ${name}`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      fs.mkdirSync(current)
      created.push(current)
    }
  }
  return path.join(current, parts[parts.length - 1])
}

function writeAtomic(destination, content, mode, owner) {
  const temporary = `${destination}.vynk8s-${randomUUID()}.tmp`
  let created = false
  let moved = false
  try {
    const fd = fs.openSync(temporary, 'wx', mode)
    created = true
    try {
      fs.writeFileSync(fd, content)
      if (owner && process.platform !== 'win32') fs.fchownSync(fd, owner.uid, owner.gid)
      fs.fchmodSync(fd, mode)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, destination)
    moved = true
  } finally {
    if (created && !moved) {
      try {
        fs.unlinkSync(temporary)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
}

function rollbackUpdate(transaction) {
  const failures = []
  const backups = new Map()
  for (const change of transaction.applied) {
    try {
      const actual = inspect(transaction.root, change.name)
      if (change.after ? !actual || actual.sha256 !== change.after.sha256.toLowerCase() || !sameMode(actual.mode, targetMode(change)) || (change.before && !sameOwner(actual, change.before)) : Boolean(actual)) {
        throw new Error(`File changed after update; refusing to overwrite: ${change.name}`)
      }
      if (change.before) {
        const backup = path.join(transaction.backupDir, 'files', ...validatePath(change.name))
        const content = fs.readFileSync(backup)
        if (digest(content) !== change.before.sha256) throw new Error(`Backup integrity check failed: ${change.name}`)
        backups.set(change.name, content)
      }
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'File rollback was incomplete')

  const reversed = [...transaction.applied].reverse()
  const ordered = [...reversed.filter(change => change.name !== VERSION_FILE), ...reversed.filter(change => change.name === VERSION_FILE)]
  for (const change of ordered) {
    if (change.name === VERSION_FILE && failures.length) continue
    try {
      const actual = inspect(transaction.root, change.name)
      if (change.after ? !actual || actual.sha256 !== change.after.sha256.toLowerCase() || !sameMode(actual.mode, targetMode(change)) || (change.before && !sameOwner(actual, change.before)) : Boolean(actual)) {
        throw new Error(`File changed after update; refusing to overwrite: ${change.name}`)
      }
      const destination = path.join(transaction.root, ...validatePath(change.name))
      if (change.before) writeAtomic(destination, backups.get(change.name), change.before.mode, change.before)
      else fs.unlinkSync(destination)
    } catch (error) {
      failures.push(error)
    }
  }
  for (const directory of [...transaction.created].reverse()) {
    try {
      fs.rmdirSync(directory)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') failures.push(error)
    }
  }
  if (failures.length) throw new AggregateError(failures, 'File rollback was incomplete')
}

function applyUpdate(prepared, backupDir) {
  fs.mkdirSync(backupDir, { mode: 0o700 })
  const transaction = { root: prepared.root, backupDir: fs.realpathSync(backupDir), applied: [], created: [] }
  for (const change of prepared.changes) {
    const actual = inspect(prepared.root, change.name)
    if (change.before ? !actual || actual.sha256 !== change.before.sha256 || actual.mode !== change.before.mode || !sameOwner(actual, change.before) : Boolean(actual)) {
      throw new Error(`Client file changed during update preparation: ${change.name}`)
    }
    if (actual) {
      const backup = path.join(transaction.backupDir, 'files', ...validatePath(change.name))
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 })
      fs.writeFileSync(backup, actual.content, { flag: 'wx', mode: 0o600 })
    }
  }

  const journal = {
    version: 2,
    root: transaction.root,
    changes: prepared.changes.map(change => ({
      name: change.name,
      before: change.before ? { sha256: change.before.sha256, mode: change.before.mode, uid: change.before.uid, gid: change.before.gid } : null,
      after: change.after ? { sha256: change.after.sha256, executable: change.after.executable } : null,
    })),
  }
  const journalFile = fs.openSync(path.join(transaction.backupDir, 'journal.json'), 'wx', 0o600)
  try {
    fs.writeFileSync(journalFile, JSON.stringify(journal))
    fs.fsyncSync(journalFile)
  } finally {
    fs.closeSync(journalFile)
  }

  try {
    for (const change of prepared.changes) {
      const actual = inspect(prepared.root, change.name)
      if (change.before ? !actual || actual.sha256 !== change.before.sha256 || actual.mode !== change.before.mode || !sameOwner(actual, change.before) : Boolean(actual)) {
        throw new Error(`Client file changed during update: ${change.name}`)
      }
      const destination = ensureParents(prepared.root, change.name, transaction.created)
      if (change.after) {
        writeAtomic(destination, change.content, targetMode(change), change.before)
      } else {
        fs.unlinkSync(destination)
      }
      transaction.applied.push(change)
    }
    return transaction
  } catch (error) {
    try {
      rollbackUpdate(transaction)
    } catch (rollbackError) {
      const failure = new AggregateError([error, rollbackError], 'Update failed and file rollback was incomplete')
      failure.manualRecoveryRequired = true
      throw failure
    }
    throw error
  }
}

function recoverUpdate(root, backupDir) {
  const rootPath = fs.realpathSync(root)
  const backupPath = fs.realpathSync(backupDir)
  const journal = JSON.parse(fs.readFileSync(path.join(backupPath, 'journal.json'), 'utf8'))
  if (!journal || journal.version !== 2 || journal.root !== rootPath ||
      !Array.isArray(journal.changes) || journal.changes.length > 301) {
    throw new Error('Invalid update recovery journal')
  }
  const names = new Set()
  for (const change of journal.changes) {
    if (!change || typeof change !== 'object') throw new Error('Invalid update recovery journal')
    validatePath(change.name)
    if (change.name.toLowerCase() === VERSION_FILE && change.name !== VERSION_FILE) {
      throw new Error('Invalid update recovery journal')
    }
    const key = change.name.toLowerCase()
    if (names.has(key)) throw new Error('Invalid update recovery journal')
    names.add(key)
    if ((!change.before && change.before !== null) || (!change.after && change.after !== null)) {
      throw new Error('Invalid update recovery journal')
    }
    if (change.before && (typeof change.before.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(change.before.sha256) ||
        !Number.isInteger(change.before.mode) || change.before.mode < 0 || change.before.mode > 0o777 ||
        !Number.isInteger(change.before.uid) || change.before.uid < 0 || !Number.isInteger(change.before.gid) || change.before.gid < 0)) {
      throw new Error('Invalid update recovery journal')
    }
    if (change.after && (typeof change.after.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(change.after.sha256) ||
        typeof change.after.executable !== 'boolean')) {
      throw new Error('Invalid update recovery journal')
    }
    if (!change.before && !change.after) throw new Error('Invalid update recovery journal')
  }
  const protectedChanges = journal.changes.filter(change => change.name !== VERSION_FILE).map(change => ({ filename: change.name }))
  if (maintenanceReasons('VYNK8S_DATA_COMPATIBLE: true', protectedChanges).length) {
    throw new Error('Update recovery includes protected or unsupported paths')
  }
  const applied = []
  for (const change of journal.changes) {
    const actual = inspect(rootPath, change.name)
    const original = change.before ? actual && actual.sha256 === change.before.sha256 && sameMode(actual.mode, change.before.mode) && sameOwner(actual, change.before) : !actual
    const updated = change.after ? actual && actual.sha256 === change.after.sha256.toLowerCase() && sameMode(actual.mode, targetMode(change)) && (!change.before || sameOwner(actual, change.before)) : !actual
    if (original) continue
    if (!updated) throw new Error(`Client file conflicts with recovery: ${change.name}`)
    applied.push(change)
  }
  rollbackUpdate({ root: rootPath, backupDir: backupPath, applied, created: [] })
}

module.exports = { prepareUpdate, applyUpdate, rollbackUpdate, recoverUpdate }
