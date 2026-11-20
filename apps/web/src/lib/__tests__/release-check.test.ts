import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkRelease } from '../release-check'

const commit = 'a'.repeat(40)
const release = { tag_name: 'v1.2.0', name: 'Release 1.2', published_at: '2026-11-19T00:00:00Z' }

afterEach(() => vi.unstubAllGlobals())

describe('release checks', () => {
  it('reports changed files when the release is ahead', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(Response.json({
        status: 'ahead',
        head_commit: { sha: 'b'.repeat(40) },
        files: [{ filename: 'app.ts', status: 'modified' }, { filename: 'new.ts', status: 'renamed', previous_filename: 'old.ts' }],
      }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await checkRelease(commit)
    expect(result.status).toBe('available')
    expect('files' in result && result.files).toHaveLength(2)
    expect('targetCommit' in result && result.targetCommit).toBe('b'.repeat(40))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not compare an unknown installed version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(release))
    vi.stubGlobal('fetch', fetchMock)
    expect((await checkRelease(null)).status).toBe('unknown')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('flags unconfirmed releases and dependency or migration changes for maintenance', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(Response.json({
        status: 'ahead',
        files: [
          { filename: 'apps/web/package.json', status: 'modified' },
          { filename: 'apps/web/src/migrations/next.ts', status: 'added' },
        ],
      }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await checkRelease(commit)
    expect(result.status).toBe('available')
    expect('maintenance' in result && result.maintenance).toHaveLength(3)
  })

  it('recognizes explicit publisher confirmation for code-only releases', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ...release, body: 'VYNOPS_DATA_COMPATIBLE: true' }))
      .mockResolvedValueOnce(Response.json({ status: 'ahead', files: [{ filename: 'apps/web/src/page.tsx', status: 'modified' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await checkRelease(commit)
    expect('maintenance' in result && result.maintenance).toEqual([])
  })

  it('flags protected client data and unsafe renamed paths for maintenance', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ...release, body: 'VYNOPS_DATA_COMPATIBLE: true' }))
      .mockResolvedValueOnce(Response.json({
        status: 'ahead',
        files: [
          { filename: 'apps/web/data/users.json', status: 'modified' },
          { filename: 'apps/web/src/new.ts', previous_filename: '../outside', status: 'renamed' },
        ],
      }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await checkRelease(commit)
    expect('maintenance' in result && result.maintenance).toContain('Protected client data, configuration or unsafe paths require separate maintenance.')
  })

  it('distinguishes an identical release from an older release', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(Response.json({ status: 'identical', files: [] }))
      .mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(Response.json({ status: 'behind', files: [] }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await checkRelease(commit)).status).toBe('current')
    expect((await checkRelease(commit)).status).toBe('unknown')
  })

  it('does not claim an update for a diverged commit or incomplete file list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(Response.json({ status: 'diverged', files: [] }))
      .mockResolvedValueOnce(Response.json(release))
      .mockResolvedValueOnce(Response.json({ status: 'ahead', files: Array.from({ length: 300 }, (_, i) => ({ filename: `${i}.ts`, status: 'modified' })) }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await checkRelease(commit)).status).toBe('unknown')
    expect((await checkRelease(commit)).status).toBe('unknown')
  })

  it('reports an unavailable release and surfaces GitHub errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await checkRelease(commit)).status).toBe('unavailable')
    await expect(checkRelease(commit)).rejects.toThrow('HTTP 403')
  })
})
