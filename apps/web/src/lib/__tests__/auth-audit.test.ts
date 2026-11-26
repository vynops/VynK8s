import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ appendAuditLog: vi.fn() }))
vi.mock('@/app/api/settings/config/shared', () => ({ appendAuditLog: mocks.appendAuditLog }))

import { appendAuthAuditSafely, logFailedSignIn, logSignOut, logSuccessfulSignIn } from '../auth-audit'

beforeEach(() => mocks.appendAuditLog.mockReset())

describe('authentication audit events', () => {
  it('records successful sign-in and sign-out without credential data', () => {
    const identity = { id: 'user-1', email: 'operator@example.test' }
    logSuccessfulSignIn(identity)
    logSignOut(identity)

    expect(mocks.appendAuditLog).toHaveBeenNthCalledWith(1, expect.objectContaining({
      user: 'operator@example.test', action: 'auth.login', detail: 'Credentials sign-in',
    }))
    expect(mocks.appendAuditLog).toHaveBeenNthCalledWith(2, expect.objectContaining({
      user: 'operator@example.test', action: 'auth.logout', detail: 'Session signed out',
    }))
    expect(JSON.stringify(mocks.appendAuditLog.mock.calls)).not.toContain('password')
  })

  it('records failed attempts without storing unknown account identifiers and limits repeats', () => {
    for (let attempt = 0; attempt < 7; attempt++) logFailedSignIn({ id: 'user-failed-1', email: 'operator@example.test' })
    for (let attempt = 0; attempt < 7; attempt++) logFailedSignIn()

    expect(mocks.appendAuditLog).toHaveBeenCalledTimes(10)
    expect(mocks.appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      user: 'operator@example.test', action: 'auth.login_failed', detail: 'Credentials rejected',
    }))
    expect(mocks.appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      user: 'unknown', action: 'auth.login_failed', detail: 'Credentials rejected',
    }))
  })

  it('does not throw when the audit store is unavailable', () => {
    const failingWriter = () => { throw new Error('disk unavailable') }

    expect(() => appendAuthAuditSafely({ id: 'user-2' }, 'auth.login', 'Credentials sign-in', failingWriter)).not.toThrow()
  })
})
