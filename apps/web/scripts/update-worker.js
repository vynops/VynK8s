const fs = require('node:fs')
const path = require('node:path')
const { stateDirectory, writeStatus, readStatus } = require('../src/lib/update-job.js')
const { loadLatestRelease } = require('../src/lib/update-source.js')
const { createRuntime } = require('../src/lib/update-pm2.js')
const { runUpdate } = require('../src/lib/update-runner.js')

async function main() {
  const web = fs.realpathSync(process.cwd())
  const state = stateDirectory(web, false)
  if (!state) throw new Error('Update state directory is unavailable')
  const lock = path.join(state, 'active')
  const job = JSON.parse(fs.readFileSync(path.join(lock, 'job.json'), 'utf8'))
  if (!job || job.id !== process.argv[2] || !/^[a-f0-9-]{36}$/.test(job.id) ||
      !/^[a-f0-9]{40}$/i.test(job.baseCommit) || !/^[a-f0-9]{40}$/i.test(job.commit) ||
      !/^[a-z0-9._-]{1,128}$/i.test(job.tag) || !/^[a-f0-9]{64}$/.test(job.healthToken)) {
    throw new Error('Invalid update job')
  }
  const previous = readStatus(web)
  if (!previous || previous.id !== job.id || previous.phase !== 'queued') {
    writeStatus(state, { id: job.id, tag: job.tag, commit: job.commit, phase: 'manual-recovery-required' })
    throw new Error('An interrupted update requires manual recovery')
  }
  let phase = 'queued'
  const report = async next => {
    writeStatus(state, { id: job.id, tag: job.tag, commit: job.commit, phase: next })
    phase = next
  }
  try {
    await report('checking')
    const metadata = path.join(web, 'release-version.json')
    const stat = fs.lstatSync(metadata)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) throw new Error('Invalid installed release metadata')
    const base = JSON.parse(fs.readFileSync(metadata, 'utf8'))
    if (base.commit !== job.baseCommit) throw new Error('Installed release changed after approval')
    const release = await loadLatestRelease(job.baseCommit, job.tag, job.commit)
    const root = path.resolve(web, '..', '..')
    const runtime = createRuntime({ root, webDir: web, appId: job.appId, initialPid: job.pid, port: job.port, healthToken: job.healthToken })
    await runUpdate({ root, backupDir: path.join(state, `backup-${job.id}`), base, target: release.manifest,
      releaseBody: release.body, download: release.download, runtime, onStatus: report })
  } catch (error) {
    console.error('[update-worker]', error)
    if (phase === 'checking' || phase === 'queued') await report('failed')
    else if (phase !== 'rolled-back' && phase !== 'manual-recovery-required') await report('manual-recovery-required')
  }
  if (phase === 'completed' || phase === 'rolled-back' || phase === 'failed') {
    try {
      fs.unlinkSync(path.join(lock, 'job.json'))
      fs.rmdirSync(lock)
    } catch (error) {
      await report('manual-recovery-required')
      throw error
    }
  }
}

main().catch(error => {
  console.error('[update-worker] Status or cleanup failed; manual review is required.', error)
  process.exitCode = 1
})
