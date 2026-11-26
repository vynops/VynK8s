import { describe, expect, it } from 'vitest'
import { getConfiguredSuperAdminId, getDesignatedSuperAdminId, isAuthSessionBlocked, isConfiguredSuperAdmin, isDesignatedSuperAdmin } from '../super-admin'

const admin = { id: 'admin-1', role: 'admin', status: 'active' as const, isSuperAdmin: true }

describe('server-managed super-admin designation', () => {
  it('uses the single active admin record marked by the server', () => {
    expect(getConfiguredSuperAdminId([admin, { id: 'viewer-1', role: 'viewer' }])).toBe('admin-1')
    expect(isConfiguredSuperAdmin([admin], 'admin-1')).toBe(true)
    expect(isConfiguredSuperAdmin([admin], 'viewer-1')).toBe(false)
  })

  it('fails closed when the marker is missing, duplicated, blocked, or on a non-admin', () => {
    expect(getConfiguredSuperAdminId([{ id: 'admin-1', role: 'admin' }])).toBeNull()
    expect(getConfiguredSuperAdminId([admin, { ...admin, id: 'admin-2' }])).toBeNull()
    expect(getConfiguredSuperAdminId([{ ...admin, status: 'blocked' }])).toBeNull()
    expect(getConfiguredSuperAdminId([{ ...admin, role: 'viewer' }])).toBeNull()
    expect(getDesignatedSuperAdminId([admin, { ...admin, id: 'admin-2' }])).toBeNull()
    expect(isDesignatedSuperAdmin([admin, { ...admin, id: 'admin-2' }], 'admin-1')).toBe(true)
  })

  it('keeps a blocked or demoted designated identity protected without granting it privileges', () => {
    const blocked = [{ ...admin, status: 'blocked' as const }]
    expect(getDesignatedSuperAdminId(blocked)).toBe('admin-1')
    expect(isDesignatedSuperAdmin(blocked, 'admin-1')).toBe(true)
    expect(getConfiguredSuperAdminId(blocked)).toBeNull()
    expect(isConfiguredSuperAdmin(blocked, 'admin-1')).toBe(false)
  })

  it('invalidates old sessions after block and unblock version changes', () => {
    const user = { id: 'user-1', role: 'viewer', status: 'active' as const, sessionVersion: 1 }
    expect(isAuthSessionBlocked({ ...user, status: 'blocked' }, 0)).toBe(true)
    expect(isAuthSessionBlocked(user, 0)).toBe(true)
    expect(isAuthSessionBlocked(user, 1)).toBe(false)
    expect(isAuthSessionBlocked(null, 0)).toBe(true)
  })
})
