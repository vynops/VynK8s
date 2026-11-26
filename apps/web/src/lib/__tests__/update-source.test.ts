import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareUpdate } from '../update-files.js'
import { loadLatestRelease } from '../update-source.js'

const baseCommit = 'a'.repeat(40)
const targetCommit = 'b'.repeat(40)
const body = 'VYNK8S_DATA_COMPATIBLE: true'
const filename = 'apps/web/src/app.ts'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const entry = (value: string) => ({ sha256: hash(value), size: Buffer.byteLength(value), executable: false })
const base = { commit: baseCommit, date: '2026-11-19T10:00:00Z', dataCompatible: true, files: { [filename]: entry('old') } }
const target = { commit: targetCommit, date: '2026-11-19T11:00:00Z', dataCompatible: true, files: { [filename]: entry('new') } }

afterEach(() => vi.unstubAllGlobals())

function mockRelease(options: { checksum?: string; targetCommit?: string; redirect?: string; previousFilename?: string } = {}) {
  const manifest = JSON.stringify(target)
  const checksum = options.checksum ?? hash(manifest)
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/releases/latest')) {
      return Response.json({
        draft: false, prerelease: false, tag_name: 'v2.1.0', body,
        assets: [{ name: 'vynk8s-manifest.json' }, { name: 'vynk8s-sha256.txt' }],
      })
    }
    if (url.includes('/compare/')) {
      return Response.json({ status: 'ahead', head_commit: { sha: options.targetCommit ?? targetCommit }, files: [{ filename, previous_filename: options.previousFilename }] })
    }
    if (url.endsWith('/vynk8s-sha256.txt')) return new Response(`${checksum}  vynk8s-manifest.json\n`)
    if (url.endsWith('/vynk8s-manifest.json')) {
      if (options.redirect) return new Response(null, { status: 302, headers: { location: options.redirect } })
      return new Response(manifest)
    }
    if (url.includes('raw.githubusercontent.com')) return new Response('new')
    throw new Error(`Unexpected request: ${url}`)
  })
}

describe('approved release source', () => {
  it('pins the release and prepares verified changed files without Git', async () => {
    vi.stubGlobal('fetch', mockRelease())
    const scratch = mkdtempSync(join(tmpdir(), 'vynk8s-source-test-'))
    try {
      const web = join(scratch, 'apps', 'web')
      mkdirSync(join(web, 'src'), { recursive: true })
      writeFileSync(join(web, 'release-version.json'), JSON.stringify(base) + '\n')
      writeFileSync(join(web, 'src', 'app.ts'), 'old')
      const release = await loadLatestRelease(baseCommit, 'v2.1.0', targetCommit)
      const plan = await prepareUpdate(scratch, base, release.manifest, release.body, release.download)
      expect(plan.changes.map((change: { name: string }) => change.name)).toEqual([filename, 'apps/web/release-version.json'])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('rejects a changed release and a bad manifest checksum', async () => {
    vi.stubGlobal('fetch', mockRelease({ targetCommit: 'c'.repeat(40) }))
    await expect(loadLatestRelease(baseCommit, 'v2.1.0', targetCommit)).rejects.toThrow('changed')
    vi.stubGlobal('fetch', mockRelease({ checksum: '0'.repeat(64) }))
    await expect(loadLatestRelease(baseCommit, 'v2.1.0', targetCommit)).rejects.toThrow('checksum does not match')
  })

  it('does not follow a release asset redirect to an untrusted host', async () => {
    const fetchMock = mockRelease({ redirect: 'https://example.invalid/manifest' })
    vi.stubGlobal('fetch', fetchMock)
    await expect(loadLatestRelease(baseCommit, 'v2.1.0', targetCommit)).rejects.toThrow('untrusted host')
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('example.invalid'))).toBe(false)
  })

  it('rejects renamed protected files even if the target path is safe', async () => {
    vi.stubGlobal('fetch', mockRelease({ previousFilename: 'apps/web/data/users.json' }))
    await expect(loadLatestRelease(baseCommit, 'v2.1.0', targetCommit)).rejects.toThrow('requires separate maintenance')
  })
})
