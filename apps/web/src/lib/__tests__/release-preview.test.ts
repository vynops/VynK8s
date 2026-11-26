import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ guard: vi.fn(), load: vi.fn() }))
vi.mock('@/lib/rbac', () => ({ assertSuperAdmin: mocks.guard }))
vi.mock('@/lib/update-source.js', () => ({ loadLatestRelease: mocks.load }))

import { POST } from '../../app/api/settings/release/preview/route'

const filename = 'apps/web/src/app.ts'
const entry = (value: string) => ({
  sha256: createHash('sha256').update(value).digest('hex'),
  size: Buffer.byteLength(value),
  executable: false,
})
const base = { commit: 'a'.repeat(40), date: '2026-11-19T10:00:00Z', dataCompatible: true, files: { [filename]: entry('old') } }
const target = { commit: 'b'.repeat(40), date: '2026-11-19T11:00:00Z', dataCompatible: true, files: { [filename]: entry('new') } }
let scratch: string
let web: string

function request(origin = 'https://example.test') {
  return new Request('https://example.test/api/settings/release/preview', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ tag: 'v2.1.0', commit: target.commit }),
  })
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vynk8s-preview-test-'))
  web = join(scratch, 'apps', 'web')
  mkdirSync(join(web, 'src'), { recursive: true })
  mkdirSync(join(web, 'data'))
  writeFileSync(join(web, 'src', 'app.ts'), 'old')
  writeFileSync(join(web, 'data', 'users.json'), 'client data')
  writeFileSync(join(web, 'release-version.json'), JSON.stringify(base) + '\n')
  vi.spyOn(process, 'cwd').mockReturnValue(web)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubEnv('AUTH_URL', '')
  vi.stubEnv('NEXTAUTH_URL', '')
  vi.stubEnv('VYNK8S_BUILD_SOURCE', 'manifest')
  vi.stubEnv('VYNK8S_BUILD_COMMIT', base.commit)
  mocks.guard.mockResolvedValue(null)
  mocks.load.mockResolvedValue({ manifest: target, body: 'VYNK8S_DATA_COMPATIBLE: true', download: async () => Buffer.from('new') })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  mocks.guard.mockReset()
  mocks.load.mockReset()
  rmSync(scratch, { recursive: true, force: true })
})

describe('update verification endpoint', () => {
  it('verifies a pinned release without changing the app or client data', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ commit: target.commit, files: [
      { name: filename, action: 'replace' },
      { name: 'apps/web/release-version.json', action: 'replace' },
    ] })
    expect(mocks.load).toHaveBeenCalledWith(base.commit, 'v2.1.0', target.commit)
    expect(readFileSync(join(web, 'src', 'app.ts'), 'utf8')).toBe('old')
    expect(readFileSync(join(web, 'data', 'users.json'), 'utf8')).toBe('client data')
  })

  it('rejects unauthorized and cross-origin requests before accessing releases', async () => {
    mocks.guard.mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    expect((await POST(request())).status).toBe(403)
    expect((await POST(request('https://other.test'))).status).toBe(403)
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('rejects a client file conflict without changing it', async () => {
    writeFileSync(join(web, 'src', 'app.ts'), 'client edit')
    expect((await POST(request())).status).toBe(409)
    expect(readFileSync(join(web, 'src', 'app.ts'), 'utf8')).toBe('client edit')
  })

  it('rejects metadata that does not match the running build', async () => {
    vi.stubEnv('VYNK8S_BUILD_COMMIT', 'c'.repeat(40))
    expect((await POST(request())).status).toBe(409)
    expect(mocks.load).not.toHaveBeenCalled()
  })
})
