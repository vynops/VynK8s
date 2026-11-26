import { beforeEach, describe, expect, it, vi } from 'vitest'
import bcrypt from 'bcryptjs'

const state = vi.hoisted(() => ({
  user: { id: 'initial-admin', email: 'admin@vynk8s.local', mustChangePassword: true, isSuperAdmin: true, sessionVersion: 0 },
  passwordHash: '',
  credentialExists: true,
}))

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: state.user.id, email: state.user.email } }) }))
vi.mock('@/app/api/settings/config/shared', () => ({ appendAuditLog: vi.fn() }))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn((path: unknown) => {
      const value = String(path)
      return value.endsWith('passwords.json') || value.endsWith('users.json') || (value.endsWith('initial-admin-credentials.txt') && state.credentialExists)
    }),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn((path: unknown) => String(path).endsWith('users.json')
      ? JSON.stringify([state.user])
      : JSON.stringify({ [state.user.id]: state.passwordHash })),
    writeFileSync: vi.fn((path: unknown, contents: string) => {
      if (String(path).endsWith('users.json')) Object.assign(state.user, JSON.parse(String(contents))[0])
      if (String(path).endsWith('passwords.json')) state.passwordHash = JSON.parse(String(contents))[state.user.id]
    }),
    unlinkSync: vi.fn(() => { state.credentialExists = false }),
  }
})

import { POST } from '../change-password/route'

beforeEach(async () => {
  state.user = { id: 'initial-admin', email: 'admin@vynk8s.local', mustChangePassword: true, isSuperAdmin: true, sessionVersion: 0 }
  state.passwordHash = await bcrypt.hash('temporary-bootstrap-password', 4)
  state.credentialExists = true
})

describe('forced initial password change', () => {
  it('accepts an 8-character password, clears the forced-change flag, invalidates the old session, and deletes the temporary credential', async () => {
    const newPassword = 'Abcd1234'
    const response = await POST(new Request('http://localhost/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'temporary-bootstrap-password', newPassword }),
    }))

    expect(response.status).toBe(200)
    expect(state.user.mustChangePassword).toBe(false)
    expect(state.user.sessionVersion).toBe(1)
    expect(state.credentialExists).toBe(false)
    expect(await bcrypt.compare(newPassword, state.passwordHash)).toBe(true)
  })
})
