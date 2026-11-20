import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runUpdate } from '../update-runner.js'

const filename = 'apps/web/src/app.ts'
const entry = (value: string) => ({
  sha256: createHash('sha256').update(value).digest('hex'),
  size: Buffer.byteLength(value),
  executable: false,
})
const base = { commit: 'a'.repeat(40), date: '2026-11-19T10:00:00Z', dataCompatible: true, files: { [filename]: entry('old') } }
const target = { commit: 'b'.repeat(40), date: '2026-11-19T11:00:00Z', dataCompatible: true, files: { [filename]: entry('new') } }
let scratch: string
let root: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vynops-runner-test-'))
  root = join(scratch, 'install')
  mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true })
  mkdirSync(join(root, 'apps', 'web', 'data'), { recursive: true })
  writeFileSync(join(root, 'apps', 'web', 'src', 'app.ts'), 'old')
  writeFileSync(join(root, 'apps', 'web', 'release-version.json'), JSON.stringify(base) + '\n')
  writeFileSync(join(root, 'apps', 'web', 'data', 'users.json'), 'client data')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(scratch, { recursive: true, force: true })
})

function fixture() {
  const runtime = {
    check: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    backupBuild: vi.fn(async (_directory: string) => {}),
    build: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    healthy: vi.fn(async () => true),
    restoreBuild: vi.fn(async (_directory: string) => {}),
  }
  const onStatus = vi.fn(async (_phase: string) => {})
  return {
    runtime,
    onStatus,
    options: {
      root, backupDir: join(scratch, 'backup'), base, target,
      releaseBody: 'VYNOPS_DATA_COMPATIBLE: true',
      download: async () => Buffer.from('new'),
      runtime, onStatus,
    },
  }
}

function current() {
  return readFileSync(join(root, 'apps', 'web', 'src', 'app.ts'), 'utf8')
}

function version() {
  return JSON.parse(readFileSync(join(root, 'apps', 'web', 'release-version.json'), 'utf8')).commit
}

describe('update recovery orchestration', () => {
  it('updates, builds and checks health while preserving client data', async () => {
    const { options, runtime, onStatus } = fixture()
    await runUpdate(options)
    expect(current()).toBe('new')
    expect(version()).toBe(target.commit)
    expect(readFileSync(join(root, 'apps', 'web', 'data', 'users.json'), 'utf8')).toBe('client data')
    expect(runtime.build).toHaveBeenCalledOnce()
    expect(runtime.healthy).toHaveBeenCalledWith(target.commit)
    expect(onStatus).toHaveBeenLastCalledWith('completed')
  })

  it('restores files, version metadata and the previous build when the build fails', async () => {
    const { options, runtime, onStatus } = fixture()
    runtime.build.mockRejectedValueOnce(new Error('build failed'))
    await expect(runUpdate(options)).rejects.toThrow('previous application was restored')
    expect(current()).toBe('old')
    expect(version()).toBe(base.commit)
    expect(runtime.restoreBuild).toHaveBeenCalledOnce()
    expect(runtime.start).toHaveBeenCalledOnce()
    expect(runtime.healthy).toHaveBeenCalledWith(base.commit)
    expect(onStatus).toHaveBeenLastCalledWith('rolled-back')
  })

  it('stops a failed new application before restoring the previous version', async () => {
    const { options, runtime } = fixture()
    runtime.healthy.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await expect(runUpdate(options)).rejects.toThrow('previous application was restored')
    expect(runtime.stop).toHaveBeenCalledTimes(2)
    expect(runtime.start).toHaveBeenCalledTimes(2)
    expect(current()).toBe('old')
    expect(version()).toBe(base.commit)
  })

  it('does not replace files under a process that could not be stopped during recovery', async () => {
    const { options, runtime, onStatus } = fixture()
    runtime.healthy.mockResolvedValueOnce(false)
    runtime.stop.mockResolvedValueOnce().mockRejectedValueOnce(new Error('stop failed'))
    await expect(runUpdate(options)).rejects.toThrow('automatic recovery was incomplete')
    expect(current()).toBe('new')
    expect(runtime.restoreBuild).not.toHaveBeenCalled()
    expect(onStatus).toHaveBeenLastCalledWith('manual-recovery-required')
  })

  it('continues recovery even when the progress report fails', async () => {
    const { options, runtime, onStatus } = fixture()
    runtime.build.mockRejectedValueOnce(new Error('build failed'))
    onStatus.mockImplementation(async phase => { if (phase === 'rolling-back') throw new Error('status failed') })
    await expect(runUpdate(options)).rejects.toThrow('previous application was restored')
    expect(current()).toBe('old')
    expect(runtime.start).toHaveBeenCalledOnce()
  })

  it('stops before changing files when the first stop cannot be confirmed', async () => {
    const { options, runtime, onStatus } = fixture()
    runtime.stop.mockRejectedValueOnce(new Error('stop failed'))
    await expect(runUpdate(options)).rejects.toThrow('manual review')
    expect(current()).toBe('old')
    expect(runtime.backupBuild).not.toHaveBeenCalled()
    expect(onStatus).toHaveBeenLastCalledWith('manual-recovery-required')
  })

  it('does not restore files while a timed-out build might still be running', async () => {
    const { options, runtime, onStatus } = fixture()
    runtime.build.mockRejectedValueOnce(Object.assign(new Error('timeout'), { manualRecoveryRequired: true }))
    await expect(runUpdate(options)).rejects.toThrow('timeout')
    expect(current()).toBe('new')
    expect(runtime.restoreBuild).not.toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
    expect(onStatus).toHaveBeenLastCalledWith('manual-recovery-required')
  })

  it('keeps the app stopped when replacement and file rollback both fail', async () => {
    const { options, runtime, onStatus } = fixture()
    const rename = fs.renameSync
    let appWrites = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('release-version.json')) throw new Error('simulated replacement failure')
      if (String(to).endsWith('app.ts') && ++appWrites === 2) throw new Error('simulated rollback failure')
      return rename(from, to)
    })
    await expect(runUpdate(options)).rejects.toThrow('file rollback was incomplete')
    expect(current()).toBe('new')
    expect(runtime.restoreBuild).not.toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
    expect(onStatus).toHaveBeenLastCalledWith('manual-recovery-required')
  })
})
