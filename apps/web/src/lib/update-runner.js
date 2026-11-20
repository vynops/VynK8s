const fs = require('node:fs')
const path = require('node:path')
const { prepareUpdate, applyUpdate, rollbackUpdate } = require('./update-files.js')

async function runUpdate(options) {
  const { root, backupDir, base, target, releaseBody, download, runtime, onStatus } = options
  await onStatus('checking')
  const plan = await prepareUpdate(root, base, target, releaseBody, download)
  await runtime.check()
  fs.mkdirSync(backupDir, { mode: 0o700 })
  await onStatus('stopping')
  try {
    await runtime.stop()
  } catch (error) {
    try {
      await onStatus('manual-recovery-required')
    } catch (statusError) {
      throw new AggregateError([error, statusError], 'Application stop failed and status could not be recorded')
    }
    throw new Error('Application stop could not be confirmed; manual review is required', { cause: error })
  }

  let buildBackedUp = false
  let transaction = null
  let possiblyRunning = false
  try {
    await onStatus('backing-up')
    await runtime.backupBuild(backupDir)
    buildBackedUp = true
    await onStatus('replacing-files')
    transaction = applyUpdate(plan, path.join(backupDir, 'files'))
    await onStatus('building')
    await runtime.build()
    await onStatus('starting')
    possiblyRunning = true
    await runtime.start()
    if (!await runtime.healthy(target.commit)) throw new Error('Updated application failed its health check')
    await onStatus('completed')
  } catch (error) {
    if (error && error.manualRecoveryRequired === true) {
      try {
        await onStatus('manual-recovery-required')
      } catch (statusError) {
        throw new AggregateError([error, statusError], 'Manual recovery is required and status could not be recorded')
      }
      throw error
    }
    const statusFailures = []
    try {
      await onStatus('rolling-back')
    } catch (statusError) {
      statusFailures.push(statusError)
    }
    try {
      if (possiblyRunning) {
        await runtime.stop()
        possiblyRunning = false
      }
      if (transaction) rollbackUpdate(transaction)
      if (buildBackedUp) await runtime.restoreBuild(backupDir)
      possiblyRunning = true
      await runtime.start()
      if (!await runtime.healthy(base.commit)) throw new Error('Restored application failed its health check')
    } catch (rollbackError) {
      try {
        await onStatus('manual-recovery-required')
      } catch (statusError) {
        throw new AggregateError([error, rollbackError, statusError], 'Update failed and recovery status could not be recorded')
      }
      throw new AggregateError([error, ...statusFailures, rollbackError], 'Update failed and automatic recovery was incomplete')
    }
    try {
      await onStatus('rolled-back')
    } catch (statusError) {
      statusFailures.push(statusError)
    }
    if (statusFailures.length) {
      throw new AggregateError([error, ...statusFailures], 'The previous application was restored, but recovery status could not be recorded')
    }
    throw new Error('Update failed; the previous application was restored', { cause: error })
  }
}

module.exports = { runUpdate }
