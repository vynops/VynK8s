import { describe, expect, it } from 'vitest'
import { estimateBudgetExhaustionHours, hasCompleteDailyWindow } from '../analytics-math'

describe('estimateBudgetExhaustionHours', () => {
  it('uses the full 30-day window at a normal burn rate', () => {
    expect(estimateBudgetExhaustionHours(1, 0)).toBe(720)
  })

  it('projects remaining budget at the current burn rate', () => {
    expect(estimateBudgetExhaustionHours(14.4, 0)).toBe(50)
    expect(estimateBudgetExhaustionHours(6, 50)).toBe(60)
  })

  it('does not project a runway after budget exhaustion or without burn', () => {
    expect(estimateBudgetExhaustionHours(1, 120)).toBe(0)
    expect(estimateBudgetExhaustionHours(0, 25)).toBeNull()
    expect(estimateBudgetExhaustionHours(null, 25)).toBeNull()
    expect(estimateBudgetExhaustionHours(14.4, null)).toBeNull()
  })
})

describe('hasCompleteDailyWindow', () => {
  const now = Date.UTC(2026, 10, 3)
  const dayMs = 86_400_000

  it('accepts 31 fresh daily samples spanning 30 days', () => {
    const points = Array.from({ length: 31 }, (_, index) => ({ ts: now - (30 - index) * dayMs, value: 100 }))
    expect(hasCompleteDailyWindow(points, 30, now)).toBe(true)
  })

  it('rejects short, gapped, or stale history', () => {
    const points = Array.from({ length: 31 }, (_, index) => ({ ts: now - (30 - index) * dayMs, value: 100 }))
    expect(hasCompleteDailyWindow(points.slice(-7), 30, now)).toBe(false)
    expect(hasCompleteDailyWindow(points.filter((_, index) => index !== 15), 30, now)).toBe(false)
    expect(hasCompleteDailyWindow(points.map(point => ({ ...point, ts: point.ts - 2 * dayMs })), 30, now)).toBe(false)
  })
})
