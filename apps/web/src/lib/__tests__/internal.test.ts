import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasInternalSecret, internalHeaders, isInternalPath } from '../internal'

afterEach(() => vi.unstubAllEnvs())

describe('internal auth', () => {
  it('accepts either header form only when CRON_SECRET is set and matches', () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    expect(hasInternalSecret(new Headers({ 'x-internal-secret': 's3cret' }))).toBe(true)
    expect(hasInternalSecret(new Headers({ authorization: 'Bearer s3cret' }))).toBe(true)
    expect(hasInternalSecret(new Headers({ 'x-internal-secret': 'nope' }))).toBe(false)
    expect(hasInternalSecret(new Headers())).toBe(false)
  })

  it('rejects empty-secret matches', () => {
    vi.stubEnv('CRON_SECRET', '')
    expect(hasInternalSecret(new Headers({ 'x-internal-secret': '' }))).toBe(false)
  })

  it('round-trips headers it generates', () => {
    vi.stubEnv('CRON_SECRET', 'abc')
    expect(hasInternalSecret(new Headers(internalHeaders()))).toBe(true)
  })

  it('allowlists only loop-internal paths', () => {
    for (const p of ['/api/autonomous/loop', '/api/autonomous/plan', '/api/autonomous/plan/abc123/approve', '/api/ai/insights', '/api/incidents/auto-escalate', '/api/automation/auto-trigger', '/api/automation/execute']) {
      expect(isInternalPath(p)).toBe(true)
    }
    for (const p of ['/api/settings/users', '/api/k8s/exec', '/api/autonomous/plan/a/b/approve', '/api/autonomous/config']) {
      expect(isInternalPath(p)).toBe(false)
    }
  })
})
