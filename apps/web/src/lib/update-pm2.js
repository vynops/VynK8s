const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function findNodeCli(name, environment = process.env) {
  const search = (environment.PATH || '').split(path.delimiter).filter(Boolean)
  for (const directory of search) {
    const candidate = process.platform === 'win32'
      ? path.join(directory, 'node_modules', name, 'bin', name === 'npm' ? 'npm-cli.js' : 'pm2')
      : path.join(directory, name)
    try {
      const resolved = fs.realpathSync(candidate)
      if (!fs.statSync(resolved).isFile()) continue
      const firstLine = fs.readFileSync(resolved, 'utf8').split('\n', 1)[0]
      if (/^#!.*\bnode(?:\s|$)/.test(firstLine)) return resolved
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  throw new Error(`${name} Node CLI is unavailable`)
}

function createRuntime(options) {
  const root = fs.realpathSync(options.root)
  const web = fs.realpathSync(options.webDir)
  const server = fs.realpathSync(path.join(web, 'server.mjs'))
  const appId = options.appId
  const initialPid = options.initialPid
  const port = options.port
  if (!Number.isSafeInteger(appId) || appId < 0 || !Number.isSafeInteger(initialPid) || initialPid <= 0 ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PM2 application identity')

  const pm2 = options.pm2Cli || findNodeCli('pm2')
  const npm = options.npmCli || findNodeCli('npm')
  let npmReal
  try {
    npmReal = fs.realpathSync(npm)
  } catch {
    npmReal = null
  }
  const invoke = options.invoke || ((cli, args, timeout) => execFileSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 16 * 1024 * 1024,
  }))
  const pause = options.pause || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const probe = options.probe || (async (commit, pid) => {
    if (typeof options.healthToken !== 'string' || !/^[a-f0-9]{64}$/.test(options.healthToken)) {
      throw new Error('Update health token is unavailable')
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/settings/release/health`, {
      headers: { 'X-Vynk8s-Update-Token': options.healthToken },
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return false
    const result = await response.json()
    return result.pid === pid && result.commit === commit
  })

  // PM2 can run the app two ways: directly executing server.mjs, or via
  // `npm run start` (pm_exec_path is the npm CLI). Both are accepted, but the
  // npm path additionally requires the exact args and a package.json "start"
  // script that is known to launch server.mjs, so an unrelated npm process
  // cannot be mistaken for the installed app.
  function matchesInstallation(item) {
    if (!item.pm2_env || item.pm2_env.exec_mode !== 'fork_mode') return false
    let cwd
    try {
      cwd = fs.realpathSync(item.pm2_env.pm_cwd)
    } catch {
      return false
    }
    if (cwd !== web) return false
    let execPath
    try {
      execPath = fs.realpathSync(item.pm2_env.pm_exec_path)
    } catch {
      return false
    }
    if (execPath === server) return true
    if (!npmReal || execPath !== npmReal) return false
    const args = item.pm2_env.args
    if (!Array.isArray(args) || args.length !== 2 || args[0] !== 'run' || args[1] !== 'start') return false
    let packageJson
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8'))
    } catch {
      return false
    }
    return Boolean(packageJson && packageJson.scripts && packageJson.scripts.start === 'node server.mjs')
  }

  function app() {
    let processes
    try {
      processes = JSON.parse(invoke(pm2, ['jlist'], 30000))
    } catch (error) {
      throw new Error('Unable to inspect PM2 processes', { cause: error })
    }
    if (!Array.isArray(processes)) throw new Error('Invalid PM2 process list')
    const matches = processes.filter(item => item && item.pm_id === appId)
    const item = matches[0]
    if (matches.length !== 1 || item.name !== 'vynk8s' || !matchesInstallation(item)) {
      throw new Error('PM2 application identity does not match the installation')
    }
    return item
  }

  async function waitForStatus(expected) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const item = app()
      if (item.pm2_env.status === expected) return item
      await pause(1000)
    }
    throw new Error(`PM2 did not reach ${expected} status`)
  }

  return {
    async check() {
      const item = app()
      if (item.pm2_env.status !== 'online' || item.pid !== initialPid) {
        throw new Error('PM2 application changed since update approval')
      }
      const current = path.join(web, '.next')
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== fs.statSync(web).dev) {
        throw new Error('The existing build cannot be backed up safely')
      }
    },
    async stop() {
      const item = app()
      if (item.pm2_env.status === 'stopped') return
      invoke(pm2, ['stop', String(appId)], 30000)
      await waitForStatus('stopped')
    },
    async backupBuild(backupDir) {
      const current = path.join(web, '.next')
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== fs.statSync(backupDir).dev) {
        throw new Error('The existing build cannot be backed up safely')
      }
      fs.renameSync(current, path.join(backupDir, 'previous-build'))
    },
    async build() {
      try {
        invoke(npm, ['run', 'build', '--workspace=@vynk8s/web'], 15 * 60 * 1000)
      } catch (error) {
        if (error.code === 'ETIMEDOUT' || error.signal) {
          const uncertain = new Error('Build termination could not be confirmed; manual recovery is required', { cause: error })
          uncertain.manualRecoveryRequired = true
          throw uncertain
        }
        throw new Error('Application build failed', { cause: error })
      }
    },
    async start() {
      app()
      try {
        invoke(pm2, ['restart', String(appId)], 30000)
      } catch (error) {
        if (error.code === 'ETIMEDOUT' || error.signal) {
          const uncertain = new Error('PM2 restart could not be confirmed; manual recovery is required', { cause: error })
          uncertain.manualRecoveryRequired = true
          throw uncertain
        }
        throw error
      }
    },
    async healthy(commit) {
      for (let attempt = 0; attempt < 45; attempt++) {
        const item = app()
        if (item.pm2_env.status === 'online' && item.pid > 0) {
          try {
            if (await probe(commit, item.pid)) return true
          } catch {
            // The app may still be starting; the timeout is reported below.
          }
        }
        await pause(1000)
      }
      return false
    },
    async restoreBuild(backupDir) {
      const previous = path.join(backupDir, 'previous-build')
      const oldStat = fs.lstatSync(previous)
      if (!oldStat.isDirectory() || oldStat.isSymbolicLink()) throw new Error('Previous build backup is invalid')
      const current = path.join(web, '.next')
      try {
        const stat = fs.lstatSync(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Failed build directory is invalid')
        fs.renameSync(current, path.join(backupDir, 'failed-build'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      fs.renameSync(previous, current)
    },
  }
}

module.exports = { findNodeCli, createRuntime }
