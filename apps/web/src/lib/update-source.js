const { createHash } = require('node:crypto')
const { maintenanceReasons } = require('./update-policy.js')

const API = 'https://api.github.com/repos/vynops/VynOps'
const RELEASES = 'https://github.com/vynops/VynOps/releases/download'
const RAW = 'https://raw.githubusercontent.com/vynops/VynOps'
const MAX_MANIFEST = 5 * 1024 * 1024
const MAX_FILE = 10 * 1024 * 1024
const RELEASE_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])

async function getBytes(url, maxSize, allowedHosts, accept = 'application/octet-stream') {
  let current = new URL(url)
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (current.protocol !== 'https:' || current.port || !allowedHosts.has(current.hostname)) {
      throw new Error('Release download redirected to an untrusted host')
    }
    const response = await fetch(current, {
      headers: { Accept: accept },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error('Release download redirect is missing a destination')
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw new Error(`Release download failed (HTTP ${response.status})`)
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > maxSize)) throw new Error('Release download is too large')
    const reader = response.body?.getReader()
    if (!reader) return Buffer.alloc(0)
    const chunks = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxSize) {
          await reader.cancel()
          throw new Error('Release download is too large')
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, total)
  }
  throw new Error('Release download redirected too many times')
}

async function getJson(url) {
  const bytes = await getBytes(url, MAX_MANIFEST, new Set(['api.github.com']), 'application/vnd.github+json')
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('GitHub returned invalid release information')
  }
}

async function loadLatestRelease(baseCommit, expectedTag, expectedCommit) {
  if (!/^[a-f0-9]{40}$/i.test(baseCommit) ||
      typeof expectedTag !== 'string' || !/^[a-z0-9._-]{1,128}$/i.test(expectedTag) ||
      typeof expectedCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(expectedCommit)) {
    throw new Error('Invalid approved release identity')
  }
  const release = await getJson(`${API}/releases/latest`)
  if (!release || release.draft !== false || release.prerelease !== false ||
      release.tag_name !== expectedTag || typeof release.body !== 'string' ||
      !/^VYNOPS_DATA_COMPATIBLE: true\r?$/m.test(release.body) || !Array.isArray(release.assets) ||
      !release.assets.some(asset => asset && asset.name === 'vynops-manifest.json') ||
      !release.assets.some(asset => asset && asset.name === 'vynops-sha256.txt')) {
    throw new Error('The approved release is unavailable or requires maintenance')
  }
  const comparison = await getJson(`${API}/compare/${baseCommit}...${encodeURIComponent(expectedTag)}?per_page=100`)
  if (!comparison || comparison.status !== 'ahead' ||
      !comparison.head_commit || comparison.head_commit.sha !== expectedCommit ||
      !Array.isArray(comparison.files) || comparison.files.length >= 300 ||
      comparison.files.some(file => !file || typeof file.filename !== 'string' ||
        (file.previous_filename !== undefined && typeof file.previous_filename !== 'string'))) {
    throw new Error('The approved release changed or cannot be safely compared')
  }
  if (maintenanceReasons(release.body, comparison.files).length) {
    throw new Error('The approved release requires separate maintenance')
  }
  const assetBase = `${RELEASES}/${encodeURIComponent(expectedTag)}`
  const checksums = (await getBytes(`${assetBase}/vynops-sha256.txt`, 4096, RELEASE_HOSTS)).toString('utf8')
  const lines = checksums.split(/\r?\n/).filter(line => /^[a-f0-9]{64}  vynops-manifest\.json$/i.test(line))
  if (lines.length !== 1) throw new Error('Release manifest checksum is unavailable')
  const bytes = await getBytes(`${assetBase}/vynops-manifest.json`, MAX_MANIFEST, RELEASE_HOSTS)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  if (checksum !== lines[0].slice(0, 64).toLowerCase()) throw new Error('Release manifest checksum does not match')
  let manifest
  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('Release manifest is invalid')
  }
  if (!manifest || manifest.commit !== expectedCommit || manifest.dataCompatible !== true) {
    throw new Error('Release manifest does not match the approved release')
  }
  return {
    manifest,
    body: release.body,
    download: async (name, metadata) => {
      const encoded = name.split('/').map(encodeURIComponent).join('/')
      return getBytes(`${RAW}/${expectedCommit}/${encoded}`, Math.min(MAX_FILE, metadata.size), new Set(['raw.githubusercontent.com']))
    },
  }
}

module.exports = { loadLatestRelease }
