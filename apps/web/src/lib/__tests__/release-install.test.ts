import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ guard: vi.fn(), user: vi.fn(), audit: vi.fn(), read: vi.fn(), start: vi.fn() }))
vi.mock('@/lib/rbac', () => ({ assertSuperAdmin: mocks.guard, getSessionUserId: mocks.user }))
vi.mock('@/app/api/settings/config/shared', () => ({ appendAuditLog: mocks.audit }))
vi.mock('@/lib/update-job.js', () => ({ readStatus: mocks.read, startJob: mocks.start }))

import { GET, POST } from '../../app/api/settings/release/install/route'

const commit = 'b'.repeat(40)
function request(origin = 'https://example.test') {
  return new Request('https://example.test/api/settings/release/install', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ tag: 'v2.1.0', commit }),
  })
}

beforeEach(() => {
  vi.stubEnv('AUTH_URL', '')
  vi.stubEnv('NEXTAUTH_URL', '')
  vi.stubEnv('VYNK8S_UPDATES_ENABLED', 'true')
  vi.stubEnv('VYNK8S_UPDATES_WINDOWS_ACL_CONFIRMED', 'true')
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VYNK8S_BUILD_SOURCE', 'manifest')
  vi.stubEnv('VYNK8S_BUILD_COMMIT', 'a'.repeat(40))
  vi.stubEnv('pm_id', '0')
  vi.stubEnv('PORT', '4030')
  mocks.guard.mockResolvedValue(null)
  mocks.user.mockResolvedValue('admin-id')
  mocks.read.mockReturnValue(null)
  mocks.start.mockReturnValue({ id: 'job-id', tag: 'v2.1.0', commit, phase: 'queued' })
})

afterEach(() => {
  vi.unstubAllEnvs()
  Object.values(mocks).forEach(mock => mock.mockReset())
})

describe('update installation endpoint', () => {
  it('only starts a pinned release after super-admin authorization and records approval', async () => {
    const response = await POST(request())
    expect(response.status).toBe(202)
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ user: 'admin-id', action: 'update-approved' }))
    expect(mocks.start).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({ tag: 'v2.1.0', commit, appId: 0, pid: process.pid, port: 4030 }))
    expect(await (await GET()).json()).toMatchObject({ enabled: true, status: null })
  })

  it('does not start when disabled, unauthorized, or cross-origin', async () => {
    mocks.guard.mockResolvedValueOnce(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    expect((await POST(request())).status).toBe(403)
    expect((await POST(request('https://other.test'))).status).toBe(403)
    vi.stubEnv('VYNK8S_UPDATES_ENABLED', 'false')
    expect((await POST(request())).status).toBe(503)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})
