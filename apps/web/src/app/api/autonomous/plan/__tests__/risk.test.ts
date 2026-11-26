import { describe, expect, it } from 'vitest'
import { exceedsAutoRisk } from '../shared'

describe('exceedsAutoRisk', () => {
  const readOnly = [{ action: 'check_pod_status' }, { action: 'verify_health' }]
  const remediation = [{ action: 'check_pod_status' }, { action: 'restart_deployment' }]

  it('defaults to low: only read-only plans auto-execute', () => {
    expect(exceedsAutoRisk(readOnly)).toBe(false)
    expect(exceedsAutoRisk(remediation)).toBe(true)
  })

  it('allows medium actions only when the limit is raised', () => {
    expect(exceedsAutoRisk(remediation, 'medium')).toBe(false)
    expect(exceedsAutoRisk(remediation, 'low')).toBe(true)
  })

  it('treats unknown actions as high risk', () => {
    expect(exceedsAutoRisk([{ action: 'drop_database' }], 'medium')).toBe(true)
  })
})
