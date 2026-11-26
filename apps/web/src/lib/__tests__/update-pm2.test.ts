import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntime } from '../update-pm2.js'

let scratch: string
let web: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vynk8s-pm2-test-'))
  web = join(scratch, 'apps', 'web')
  mkdirSync(join(web, '.next'), { recursive: true })
  writeFileSync(join(web, 'server.mjs'), 'server')
  writeFileSync(join(web, 'package.json'), JSON.stringify({ scripts: { start: 'node server.mjs' } }))
  writeFileSync(join(web, '.next', 'build.txt'), 'old build')
})

afterEach(() => rmSync(scratch, { recursive: true, force: true }))

function fixture(initialPid = 100) {
  let state = 'online'
  let pid = 100
  const invoke = vi.fn((cli: string, args: string[]) => {
    if (cli === 'pm2' && args[0] === 'jlist') {
      return JSON.stringify([{
        pm_id: 0, name: 'vynk8s', pid,
        pm2_env: { status: state, exec_mode: 'fork_mode', pm_cwd: web, pm_exec_path: join(web, 'server.mjs') },
      }])
    }
    if (cli === 'pm2' && args[0] === 'stop') { state = 'stopped'; pid = 0; return '' }
    if (cli === 'pm2' && args[0] === 'restart') { state = 'online'; pid = 200; return '' }
    if (cli === 'npm' && args[0] === 'run') {
      mkdirSync(join(web, '.next'))
      writeFileSync(join(web, '.next', 'build.txt'), 'new build')
      return ''
    }
    throw new Error('Unexpected command')
  })
  const runtime = createRuntime({
    root: scratch, webDir: web, appId: 0, initialPid, port: 4030,
    pm2Cli: 'pm2', npmCli: 'npm', invoke,
    pause: async () => {}, probe: async () => true,
  })
  return { runtime, invoke }
}

// Production launches the app via `npm run start` (PM2's pm_exec_path is the
// npm CLI binary itself), not a direct server.mjs invocation. This fixture
// creates real npm/pm2 CLI stand-in files so realpath-based identity checks work.
function npmLaunchFixture(options: { args?: string[]; startScript?: string } = {}) {
  const npmPath = join(scratch, 'npm-cli-stub.js')
  const pm2Path = join(scratch, 'pm2-cli-stub.js')
  writeFileSync(npmPath, '// npm stub')
  writeFileSync(pm2Path, '// pm2 stub')
  const args = options.args ?? ['run', 'start']
  if (options.startScript !== undefined) {
    writeFileSync(join(web, 'package.json'), JSON.stringify({ scripts: { start: options.startScript } }))
  }
  let state = 'online'
  let pid = 100
  const invoke = vi.fn((cli: string, cliArgs: string[]) => {
    if (cli === pm2Path && cliArgs[0] === 'jlist') {
      return JSON.stringify([{
        pm_id: 0, name: 'vynk8s', pid,
        pm2_env: { status: state, exec_mode: 'fork_mode', pm_cwd: web, pm_exec_path: npmPath, args },
      }])
    }
    if (cli === pm2Path && cliArgs[0] === 'stop') { state = 'stopped'; pid = 0; return '' }
    if (cli === pm2Path && cliArgs[0] === 'restart') { state = 'online'; pid = 200; return '' }
    throw new Error('Unexpected command')
  })
  const runtime = createRuntime({
    root: scratch, webDir: web, appId: 0, initialPid: 100, port: 4030,
    pm2Cli: pm2Path, npmCli: npmPath, invoke,
    pause: async () => {}, probe: async () => true,
  })
  return { runtime }
}

describe('PM2 update adapter', () => {
  it('backs up the build, runs the workspace build and can restore it', async () => {
    const { runtime, invoke } = fixture()
    const backup = join(scratch, 'backup')
    mkdirSync(backup)
    await runtime.check()
    await runtime.stop()
    await runtime.backupBuild(backup)
    await runtime.build()
    await runtime.start()
    expect(await runtime.healthy()).toBe(true)
    await runtime.stop()
    await runtime.restoreBuild(backup)
    expect(readFileSync(join(web, '.next', 'build.txt'), 'utf8')).toBe('old build')
    expect(readFileSync(join(backup, 'failed-build', 'build.txt'), 'utf8')).toBe('new build')
    expect(invoke).toHaveBeenCalledWith('npm', ['run', 'build', '--workspace=@vynk8s/web'], 15 * 60 * 1000)
  })

  it('does not stop a different or restarted application', async () => {
    const { runtime, invoke } = fixture(999)
    await expect(runtime.check()).rejects.toThrow('changed since update approval')
    expect(invoke.mock.calls.some(([, args]) => args[0] === 'stop')).toBe(false)
  })

  it('marks a timed-out build as requiring manual recovery', async () => {
    const { runtime, invoke } = fixture()
    invoke.mockImplementation((cli, args) => {
      if (cli === 'npm' && args[0] === 'run') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
      throw new Error('Unexpected command')
    })
    await expect(runtime.build()).rejects.toMatchObject({ manualRecoveryRequired: true })
  })

  it('recognizes the production `npm run start` launch pattern as matching the installation', async () => {
    const { runtime } = npmLaunchFixture()
    await expect(runtime.check()).resolves.toBeUndefined()
  })

  it('rejects an npm process whose args are not exactly "run start"', async () => {
    const { runtime } = npmLaunchFixture({ args: ['run', 'dev'] })
    await expect(runtime.check()).rejects.toThrow('does not match the installation')
  })

  it('rejects an npm launch whose package.json start script does not run server.mjs', async () => {
    const { runtime } = npmLaunchFixture({ startScript: 'node other-entry.mjs' })
    await expect(runtime.check()).rejects.toThrow('does not match the installation')
  })
})
