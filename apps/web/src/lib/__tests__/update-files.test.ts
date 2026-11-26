import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUpdate, prepareUpdate, recoverUpdate, rollbackUpdate } from '../update-files.js'

const body = 'VYNK8S_DATA_COMPATIBLE: true'
const app = 'apps/web/src/app.ts'
const removed = 'apps/web/src/old.ts'
const added = 'apps/web/src/new.ts'
const data = 'apps/web/data/users.json'
const version = 'apps/web/release-version.json'
let scratch: string
let root: string

function entry(content: string) {
  const buffer = Buffer.from(content)
  return { sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.length, executable: false }
}

function manifest(commit: string, files: Record<string, string>, compatible = true) {
  return {
    commit: commit.repeat(40),
    date: '2026-11-19T10:20:30Z',
    dataCompatible: compatible,
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, entry(content)])),
  }
}

function write(name: string, content: string) {
  const file = join(root, ...name.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function read(name: string) {
  return readFileSync(join(root, ...name.split('/')), 'utf8')
}

function installManifest(files: Record<string, string>) {
  const base = manifest('a', files)
  write(version, JSON.stringify(base) + '\n')
  return base
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vynk8s-update-test-'))
  root = join(scratch, 'install')
  mkdirSync(root)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(scratch, { recursive: true, force: true })
})

describe('changed-file transactions', () => {
  it('updates only changed files and restores them after a simulated build failure', async () => {
    write(app, 'old app')
    write(removed, 'old file')
    write(data, 'client data')
    write('client-custom.txt', 'custom')
    const base = installManifest({ [app]: 'old app', [removed]: 'old file', [data]: 'client data' })
    const target = manifest('b', { [app]: 'new app', [added]: 'new file', [data]: 'client data' })
    const downloaded: Record<string, string> = { [app]: 'new app', [added]: 'new file' }
    const plan = await prepareUpdate(root, base, target, body, async (name: string) => Buffer.from(downloaded[name]))
    const transaction = applyUpdate(plan, join(scratch, 'backup'))

    expect(read(app)).toBe('new app')
    expect(read(added)).toBe('new file')
    expect(() => read(removed)).toThrow()
    expect(read(data)).toBe('client data')
    expect(read('client-custom.txt')).toBe('custom')
    expect(JSON.parse(read(version)).commit).toBe('b'.repeat(40))

    rollbackUpdate(transaction)
    expect(read(app)).toBe('old app')
    expect(read(removed)).toBe('old file')
    expect(() => read(added)).toThrow()
    expect(read(data)).toBe('client data')
    expect(read('client-custom.txt')).toBe('custom')
    expect(JSON.parse(read(version)).commit).toBe('a'.repeat(40))
  })

  it('stops without changing files when the client modified an affected file', async () => {
    write(app, 'client modification')
    const download = vi.fn()
    await expect(prepareUpdate(root, installManifest({ [app]: 'old' }), manifest('b', { [app]: 'new' }), body, download))
      .rejects.toThrow('Client file conflicts')
    expect(download).not.toHaveBeenCalled()
    expect(read(app)).toBe('client modification')
  })

  it('rejects protected paths, dependencies and unconfirmed data compatibility', async () => {
    const empty = manifest('a', {})
    const download = vi.fn()
    for (const name of [data, 'apps/web/.env.local', 'package-lock.json']) {
      await expect(prepareUpdate(root, empty, manifest('b', { [name]: 'new' }), body, download))
        .rejects.toThrow('maintenance')
    }
    await expect(prepareUpdate(root, empty, manifest('b', { [app]: 'new' }, false), body, download))
      .rejects.toThrow('not been confirmed')
    expect(download).not.toHaveBeenCalled()
  })

  it('rejects tampered downloads and changes made after preparation', async () => {
    write(app, 'old')
    const base = installManifest({ [app]: 'old' })
    const target = manifest('b', { [app]: 'new' })
    await expect(prepareUpdate(root, base, target, body, async () => Buffer.from('bad')))
      .rejects.toThrow('integrity verification')
    const plan = await prepareUpdate(root, base, target, body, async () => Buffer.from('new'))
    write(app, 'changed after preparation')
    expect(() => applyUpdate(plan, join(scratch, 'backup'))).toThrow('changed during update preparation')
    expect(read(app)).toBe('changed after preparation')
  })

  it('does not overwrite a client edit made before rollback', async () => {
    write(app, 'old')
    const plan = await prepareUpdate(root, installManifest({ [app]: 'old' }), manifest('b', { [app]: 'new' }), body, async () => Buffer.from('new'))
    const transaction = applyUpdate(plan, join(scratch, 'backup'))
    write(app, 'new client edit')
    expect(() => rollbackUpdate(transaction)).toThrow('rollback was incomplete')
    expect(read(app)).toBe('new client edit')
    expect(JSON.parse(read(version)).commit).toBe('b'.repeat(40))
  })

  it('restores earlier replacements if a later file operation fails', async () => {
    write(app, 'old')
    const plan = await prepareUpdate(root, installManifest({ [app]: 'old' }), manifest('b', { [app]: 'new', [added]: 'added' }), body,
      async (name: string) => Buffer.from(name === app ? 'new' : 'added'))
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('new.ts')) throw new Error('simulated file failure')
      return rename(from, to)
    })
    expect(() => applyUpdate(plan, join(scratch, 'backup'))).toThrow('simulated file failure')
    expect(read(app)).toBe('old')
    expect(() => read(added)).toThrow()
  })

  it('marks recovery as manual when a partial file rollback also fails', async () => {
    write(app, 'old')
    const plan = await prepareUpdate(root, installManifest({ [app]: 'old' }), manifest('b', { [app]: 'new', [added]: 'added' }), body,
      async (name: string) => Buffer.from(name === app ? 'new' : 'added'))
    const rename = fs.renameSync
    let appWrites = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('new.ts')) throw new Error('simulated file failure')
      if (String(to).endsWith('app.ts') && ++appWrites === 2) throw new Error('simulated rollback failure')
      return rename(from, to)
    })
    let failure: unknown
    try {
      applyUpdate(plan, join(scratch, 'backup'))
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ message: 'Update failed and file rollback was incomplete', manualRecoveryRequired: true })
    expect(read(app)).toBe('new')
  })

  it('recovers interrupted replacements from the protected journal', async () => {
    write(app, 'old')
    write(removed, 'removed')
    const base = installManifest({ [app]: 'old', [removed]: 'removed' })
    const target = manifest('b', { [app]: 'new', [added]: 'added' })
    const plan = await prepareUpdate(root, base, target, body,
      async (name: string) => Buffer.from(name === app ? 'new' : 'added'))
    const backup = join(scratch, 'backup')
    applyUpdate(plan, backup)

    rmSync(join(root, ...added.split('/')))
    write(removed, 'removed')
    write(version, JSON.stringify(base) + '\n')
    recoverUpdate(root, backup)
    expect(read(app)).toBe('old')
    expect(read(removed)).toBe('removed')
    expect(() => read(added)).toThrow()
    expect(JSON.parse(read(version)).commit).toBe(base.commit)
  })

  it('does not recover protected paths from a modified journal', async () => {
    write(app, 'old')
    write(data, 'client data')
    const plan = await prepareUpdate(root, installManifest({ [app]: 'old' }), manifest('b', { [app]: 'new' }), body,
      async () => Buffer.from('new'))
    const backup = join(scratch, 'backup')
    applyUpdate(plan, backup)
    const journalFile = join(backup, 'journal.json')
    const journal = JSON.parse(readFileSync(journalFile, 'utf8'))
    journal.changes[0].name = data
    writeFileSync(journalFile, JSON.stringify(journal))
    expect(() => recoverUpdate(root, backup)).toThrow('protected or unsupported paths')
    expect(read(data)).toBe('client data')
  })

  it.skipIf(process.platform === 'win32')('does not follow symbolic links to client files', async () => {
    mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true })
    const outside = join(scratch, 'outside')
    writeFileSync(outside, 'old')
    symlinkSync(outside, join(root, ...app.split('/')))
    await expect(prepareUpdate(root, installManifest({ [app]: 'old' }), manifest('b', { [app]: 'new' }), body, async () => Buffer.from('new')))
      .rejects.toThrow('Symbolic links')
    expect(readFileSync(outside, 'utf8')).toBe('old')
  })
})
