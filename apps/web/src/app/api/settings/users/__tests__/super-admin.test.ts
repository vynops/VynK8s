import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appendAuditLog: vi.fn(),
  state: {
    users: [] as Array<Record<string, any>>,
    passwords: {} as Record<string, string>,
    requesterId: 'regular-admin',
    requesterIsSuperAdmin: false,
  },
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn((path: unknown) => {
      const value = String(path)
      return value.endsWith('users.json') || value.endsWith('passwords.json') || value.endsWith('data')
    }),
    readFileSync: vi.fn((path: unknown) => {
      const value = String(path)
      if (value.endsWith('users.json')) return JSON.stringify(mocks.state.users)
      if (value.endsWith('passwords.json')) return JSON.stringify(mocks.state.passwords)
      throw new Error('unexpected test read')
    }),
    writeFileSync: vi.fn((path: unknown, contents: string) => {
      const value = String(path)
      if (value.endsWith('users.json')) mocks.state.users = JSON.parse(String(contents))
      else if (value.endsWith('passwords.json')) mocks.state.passwords = JSON.parse(String(contents))
      else throw new Error('unexpected test write')
    }),
    mkdirSync: vi.fn(),
  }
})

vi.mock('@/lib/rbac', () => ({
  assertAdmin: async () => null,
  assertOperator: async () => null,
  assertSession: async () => null,
  assertSuperAdmin: async () => mocks.state.requesterIsSuperAdmin
    ? null
    : new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
  getSessionUserId: async () => mocks.state.requesterId,
}))
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { email: 'actor@example.test' } }) }))
vi.mock('@/app/api/settings/config/shared', () => ({ appendAuditLog: mocks.appendAuditLog }))
vi.mock('@/lib/super-admin', () => ({
  getDesignatedSuperAdminId: (users: Array<Record<string, any>>) => {
    const designated = users.filter(user => user.isSuperAdmin === true)
    return designated.length === 1 ? designated[0]?.id ?? null : null
  },
  getConfiguredSuperAdminId: (users: Array<Record<string, any>>) => {
    const designated = users.filter(user => user.isSuperAdmin === true)
    return designated.length === 1 && designated[0]?.role === 'admin' && designated[0]?.status !== 'blocked'
      ? designated[0].id
      : null
  },
  isConfiguredSuperAdmin: (users: Array<Record<string, any>>, id: string) => {
    const designated = users.filter(user => user.isSuperAdmin === true && user.role === 'admin' && user.status !== 'blocked')
    return designated.length === 1 && designated[0]?.id === id
  },
  isDesignatedSuperAdmin: (users: Array<Record<string, any>>, id: string) => {
    const designated = users.filter(user => user.isSuperAdmin === true)
    return designated.length === 1 && designated[0]?.id === id
  },
}))

import { DELETE, GET, PATCH, POST } from '../route'

const request = (method: string, body?: unknown) => new Request('http://localhost/api/settings/users', {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const user = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, email: `${id}@example.test`, role, team: '', avatar: id.slice(0, 2),
  createdAt: '2026-01-01T00:00:00.000Z', status: 'active', sessionVersion: 0,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.users = [
    user('super-id', 'admin', { isSuperAdmin: true }),
    user('target-id', 'viewer'),
  ]
  mocks.state.passwords = {}
  mocks.state.requesterId = 'regular-admin'
  mocks.state.requesterIsSuperAdmin = false
})

describe('server-managed super-admin controls', () => {
  it('exposes the unique designated account in the user list', async () => {
    const response = await GET()
    const users = await response.json()
    expect(users.find((item: any) => item.id === 'super-id').isSuperAdmin).toBe(true)
  })

  it('denies ordinary admins the block action', async () => {
    const response = await PATCH(request('PATCH', { id: 'target-id', status: 'blocked' }))
    expect(response.status).toBe(403)
    expect(mocks.state.users[1]!.status).toBe('active')
  })

  it('blocks another user, invalidates the old session, and audits the action', async () => {
    mocks.state.requesterIsSuperAdmin = true
    const response = await PATCH(request('PATCH', { id: 'target-id', status: 'blocked' }))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'blocked', sessionVersion: 1 })
    expect(mocks.appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.block' }))
  })

  it('protects the configured account from block, demotion, and deletion', async () => {
    mocks.state.requesterIsSuperAdmin = true
    const block = await PATCH(request('PATCH', { id: 'super-id', status: 'blocked' }))
    const demote = await PATCH(request('PATCH', { id: 'super-id', role: 'viewer' }))
    const remove = await DELETE(request('DELETE', { id: 'super-id' }))
    expect(block.status).toBe(400)
    expect(demote.status).toBe(400)
    expect(remove.status).toBe(400)
    expect(mocks.state.users[0]!.status).toBe('active')
    expect(mocks.state.users[0]!.role).toBe('admin')
  })

  it('keeps the designated account protected even if its status is already blocked', async () => {
    mocks.state.users[0]!.status = 'blocked'
    mocks.state.requesterIsSuperAdmin = true

    const demote = await PATCH(request('PATCH', { id: 'super-id', role: 'viewer' }))
    const remove = await DELETE(request('DELETE', { id: 'super-id' }))

    expect(demote.status).toBe(400)
    expect(remove.status).toBe(400)
    expect(mocks.state.users[0]!.isSuperAdmin).toBe(true)
  })

  it('does not allow a newly created account to self-assign super-admin', async () => {
    const response = await POST(request('POST', {
      name: 'New Admin', email: 'new@example.test', role: 'admin', password: 'strong-test-password', isSuperAdmin: true,
    }))
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.isSuperAdmin).toBe(false)
    expect(mocks.state.users.some(item => item.id !== 'super-id' && item.isSuperAdmin === true)).toBe(false)
  })
})
