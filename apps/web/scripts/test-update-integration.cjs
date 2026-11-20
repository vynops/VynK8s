const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

if (process.platform !== 'linux') throw new Error('This isolated integration test requires Linux')
const pm2 = process.env.VYNOPS_TEST_PM2
if (!pm2 || !fs.existsSync(pm2)) throw new Error('Set VYNOPS_TEST_PM2 to an isolated PM2 CLI')
const source = path.resolve(__dirname, '..', '..', '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vynops-update-integration-'))
const root = path.join(scratch, 'install')
const web = path.join(root, 'apps', 'web')
const name = 'apps/web/src/app/(dashboard)/settings/page.tsx'
let cleanupSafe = true
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const entry = value => ({ sha256: createHash('sha256').update(value).digest('hex'), size: value.length, executable: false })

function command(cli, args, cwd = root, timeout = 30000) {
  return execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 16 * 1024 * 1024 })
}
const processes = () => JSON.parse(command(pm2, ['jlist'], web))
async function unusedPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
async function waitReady(port) {
  for (let i = 0; i < 180; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/login`, { signal: AbortSignal.timeout(1000) })).status === 200) return
    } catch {}
    await sleep(500)
  }
  throw new Error('Test application did not become ready')
}
async function waitForJob(readStatus, id) {
  let last
  for (let i = 0; i < 2400; i++) {
    const status = readStatus(web)
    if (status && status.id === id && status.phase !== last) {
      last = status.phase
      console.log(`phase: ${last}`)
    }
    if (status && status.id === id && ['completed', 'rolled-back', 'failed', 'manual-recovery-required'].includes(status.phase)) {
      if (status.phase === 'failed' || status.phase === 'manual-recovery-required') {
        try {
          console.log(`--- update worker logs for vynops-update-${id} ---`)
          console.log(command(pm2, ['logs', `vynops-update-${id}`, '--lines', '200', '--nostream'], web))
        } catch (error) {
          console.log('Unable to fetch worker logs:', error.message)
        }
      }
      return status
    }
    await sleep(500)
  }
  throw new Error('Update did not reach a terminal state')
}
async function waitForUnlock() {
  for (let i = 0; i < 120; i++) {
    if (!fs.existsSync(path.join(web, 'data', '.vynops-updater', 'active'))) return
    await sleep(250)
  }
  throw new Error('Update lock was not released')
}

async function main() {
  fs.mkdirSync(web, { recursive: true })
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, file), path.join(root, file))
  for (const file of ['src', 'scripts']) fs.cpSync(path.join(source, 'apps', 'web', file), path.join(web, file), { recursive: true })
  for (const file of ['package.json', 'next.config.ts', 'tsconfig.json', 'next-env.d.ts', 'postcss.config.mjs', 'tailwind.config.ts', 'server.mjs']) {
    fs.copyFileSync(path.join(source, 'apps', 'web', file), path.join(web, file))
  }
  // node_modules is installed fresh via npm, not copied or symlinked from the
  // source tree: Turbopack rejects a symlink pointing outside the project
  // root, and a copied node_modules can carry stale absolute-path caches from
  // its original location. A fresh install also matches what a real client
  // update actually does.
  console.log('Installing dependencies in the isolated test directory...')
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  })
  fs.mkdirSync(path.join(web, 'data'))
  const userFile = path.join(web, 'data', 'users.json')
  const configFile = path.join(web, '.env.local')
  const users = JSON.stringify([{ id: 'test-admin', role: 'admin', isSuperAdmin: true }])
  const config = 'AUTH_SECRET=isolated-test-secret-not-for-production-123456\n' +
    'NEXTAUTH_URL=http://localhost:3030\n' +
    // Placeholder (non-secret) values only. GROQ_API_KEY/GROQ_MODEL are
    // required for the AI Copilot feature; omitting them entirely can cause
    // its pages to behave differently during static generation.
    'GROQ_API_KEY=gsk_isolated_test_placeholder_not_a_real_key\n' +
    'GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct\n'
  fs.writeFileSync(userFile, users)
  fs.writeFileSync(path.join(web, 'data', 'passwords.json'), '{}')
  fs.writeFileSync(configFile, config)
  const original = fs.readFileSync(path.join(root, ...name.split('/')))
  const originalStat = fs.statSync(path.join(root, ...name.split('/')))
  const updated = Buffer.concat([original, Buffer.from('\n// Isolated updater test\n')])
  const base = { commit: 'a'.repeat(40), date: '2026-11-19T10:00:00Z', dataCompatible: true, files: { [name]: entry(original) } }
  let target = { commit: 'b'.repeat(40), date: '2026-11-19T11:00:00Z', dataCompatible: true, files: { [name]: entry(updated) } }
  fs.writeFileSync(path.join(web, 'release-version.json'), JSON.stringify(base) + '\n')
  process.env.NEXT_TELEMETRY_DISABLED = '1'
  process.env.AUTH_SECRET = 'isolated-test-secret-not-for-production-123456'
  execFileSync('npm', ['run', 'build', '--workspace=@VynOps/web'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  })

  for (const key of Object.keys(process.env)) if (key.startsWith('PM2_')) delete process.env[key]
  process.env.PM2_HOME = path.join(scratch, 'pm2')
  process.env.NODE_OPTIONS = `--require=${path.join(web, 'scripts', 'test-update-source.cjs')}`
  process.env.VYNOPS_TEST_TARGET = path.join(scratch, 'target.json')
  process.env.PORT = String(await unusedPort())
  fs.writeFileSync(process.env.VYNOPS_TEST_TARGET, JSON.stringify({ name, target, content: updated.toString('base64') }))
  const { startJob, readStatus } = require(path.join(web, 'src', 'lib', 'update-job.js'))
  try {
    cleanupSafe = false
    command(pm2, ['start', path.join(web, 'server.mjs'), '--name', 'vynops', '--cwd', web, '--no-autorestart'], web)
    let app = processes().find(item => item.name === 'vynops' && item.pm2_env.pm_cwd === web)
    assert.ok(app)
    await waitReady(Number(process.env.PORT))
    let job = startJob(web, { tag: 'v-test', commit: target.commit, baseCommit: base.commit,
      appId: app.pm_id, pid: app.pid, port: Number(process.env.PORT) })
    assert.equal((await waitForJob(readStatus, job.id)).phase, 'completed')
    await waitForUnlock()
    assert.equal(JSON.parse(fs.readFileSync(path.join(web, 'release-version.json'), 'utf8')).commit, target.commit)
    await waitReady(Number(process.env.PORT))

    app = processes().find(item => item.pm_id === app.pm_id)
    const prior = target
    const invalid = Buffer.concat([updated, Buffer.from('\nthis is invalid typescript !!!\n')])
    target = { ...prior, commit: 'c'.repeat(40), files: { [name]: entry(invalid) } }
    fs.writeFileSync(process.env.VYNOPS_TEST_TARGET, JSON.stringify({ name, target, content: invalid.toString('base64') }))
    job = startJob(web, { tag: 'v-test', commit: target.commit, baseCommit: prior.commit,
      appId: app.pm_id, pid: app.pid, port: Number(process.env.PORT) })
    assert.equal((await waitForJob(readStatus, job.id)).phase, 'rolled-back')
    await waitForUnlock()
    assert.equal(JSON.parse(fs.readFileSync(path.join(web, 'release-version.json'), 'utf8')).commit, prior.commit)
    assert.ok(fs.readFileSync(path.join(root, ...name.split('/'))).equals(updated))
    const restoredStat = fs.statSync(path.join(root, ...name.split('/')))
    assert.equal(restoredStat.uid, originalStat.uid)
    assert.equal(restoredStat.gid, originalStat.gid)
    assert.equal(restoredStat.mode & 0o777, originalStat.mode & 0o777)
    assert.equal(fs.readFileSync(userFile, 'utf8'), users)
    assert.equal(fs.readFileSync(configFile, 'utf8'), config)
    await waitReady(Number(process.env.PORT))
    console.log('Actual-app update and rollback passed')
  } finally {
    command(pm2, ['kill'], web)
    cleanupSafe = true
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  if (cleanupSafe) fs.rmSync(scratch, { recursive: true, force: true })
  else console.error('Test PM2 cleanup failed; the isolated test directory was retained.')
})
