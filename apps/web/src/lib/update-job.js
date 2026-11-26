const { execFileSync } = require('node:child_process')
const { randomBytes, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { findNodeCli } = require('./update-pm2.js')

function stateDirectory(web, create) {
  let data
  try { data = fs.realpathSync(path.join(web, 'data')) } catch (error) {
    if (!create && error.code === 'ENOENT') return null
    throw error
  }
  const state = path.join(data, '.vynk8s-updater')
  if (create) {
    try { fs.mkdirSync(state, { mode: 0o700 }) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  let stat
  try { stat = fs.lstatSync(state) } catch (error) {
    if (!create && error.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
    throw new Error('Update state directory is not private')
  }
  return state
}

function writeStatus(state, status) {
  const temp = path.join(state, `status-${randomUUID()}.tmp`)
  const file = fs.openSync(temp, 'wx', 0o600)
  try {
    fs.writeFileSync(file, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }))
    fs.fsyncSync(file)
  } finally {
    fs.closeSync(file)
  }
  try {
    fs.renameSync(temp, path.join(state, 'status.json'))
  } catch (error) {
    fs.unlinkSync(temp)
    throw error
  }
}

function readStatus(web) {
  const state = stateDirectory(web, false)
  if (!state) return null
  try {
    const stat = fs.lstatSync(path.join(state, 'status.json'))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Invalid update status file')
    return JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function startJob(web, job, invoke) {
  const pm2 = findNodeCli('pm2')
  const state = stateDirectory(web, true)
  const lock = path.join(state, 'active')
  try {
    fs.mkdirSync(lock, { mode: 0o700 })
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('An update is already active or requires manual recovery')
    throw error
  }
  const id = randomUUID()
  const status = { id, tag: job.tag, commit: job.commit, phase: 'queued' }
  try {
    fs.writeFileSync(path.join(lock, 'job.json'), JSON.stringify({ ...job, id, healthToken: randomBytes(32).toString('hex') }), { flag: 'wx', mode: 0o600 })
    writeStatus(state, status)
  } catch (error) {
    try { fs.unlinkSync(path.join(lock, 'job.json')) } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Unable to initialize update or release its lock')
    }
    fs.rmdirSync(lock)
    throw error
  }
  const worker = path.join(web, 'scripts', 'update-worker.js')
  const run = invoke || ((cli, args) => execFileSync(process.execPath, [cli, ...args], {
    cwd: web, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
  }))
  try {
    run(pm2, ['start', worker, '--name', `vynk8s-update-${id}`, '--cwd', web, '--no-autorestart', '--', id])
  } catch (error) {
    throw new Error('Update worker launch could not be confirmed; manual review is required', { cause: error })
  }
  return status
}

module.exports = { stateDirectory, writeStatus, readStatus, startJob }
