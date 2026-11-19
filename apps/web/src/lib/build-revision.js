const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const unknown = { commit: '', date: '', dirty: '', source: '' }

function validRevision(commit, date) {
  return typeof commit === 'string' && /^[a-f0-9]{40}$/i.test(commit) &&
    typeof date === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(date) &&
    !Number.isNaN(Date.parse(date))
}

function buildRevision(webDir) {
  let manifest = null
  try {
    manifest = readFileSync(join(webDir, 'release-version.json'), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[version] Unable to read release metadata.')
      return unknown
    }
  }

  if (manifest !== null) {
    try {
      const data = JSON.parse(manifest)
      if (data && validRevision(data.commit, data.date)) {
        return { commit: data.commit, date: data.date, dirty: '', source: 'manifest' }
      }
    } catch {
      // Invalid release metadata is reported below.
    }
    console.error('[version] Invalid release metadata; installed version is unavailable.')
    return unknown
  }

  try {
    const git = (...args) => execFileSync('git', args, {
      cwd: webDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }).trim()
    const commit = git('rev-parse', '--verify', 'HEAD')
    const date = git('show', '-s', '--format=%cI', 'HEAD')
    const dirty = Boolean(git('status', '--porcelain', '--untracked-files=no'))
    if (!validRevision(commit, date)) return unknown
    return { commit, date, dirty: String(dirty), source: 'git' }
  } catch {
    return unknown
  }
}

module.exports = { buildRevision }
