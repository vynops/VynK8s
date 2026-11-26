import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const sandbox = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vynk8s-plans-'))
  fs.mkdirSync(path.join(root, 'data'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  return root
})

const incident = (id: string, severity: string) => ({ id, title: `Title ${id}`, severity, state: 'investigating', service: 'svc', labels: {}, timeline: [] })

vi.mock('next/server', () => ({ NextResponse: { json: (body: unknown) => new Response(JSON.stringify(body)) } }))
vi.mock('@/lib/rbac', () => ({ assertOperator: vi.fn().mockResolvedValue(null), assertSession: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/internal', () => ({ hasInternalSecret: () => true, internalFetch: vi.fn() }))
vi.mock('@/lib/cluster', () => ({ resolveK8sUrl: async () => null, K8S_TIMEOUT_MS: 100 }))
vi.mock('@/lib/notify', () => ({ notifyIncident: vi.fn().mockResolvedValue({ ok: true, channels: ['slack'], status: 'delivered' }) }))
vi.mock('@/app/api/settings/config/shared', () => ({ readConfig: () => ({ auto_plan_enabled: true }) }))
vi.mock('@/app/api/incidents/shared', () => ({
  manualStore: new Map(),
  buildAutoIncidents: async () => ({ incidents: [incident('INC-A', 'medium'), incident('INC-B', 'high')], totalAlerts: 2, hasPrometheus: true }),
}))

import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { POST } from '@/app/api/autonomous/plan/route'
import { notifyIncident } from '@/lib/notify'

const PLANS = join(sandbox, 'data/autonomous.plans.jsonl')
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const plan = (id: string, incidentId: string, extra: Record<string, unknown> = {}) => ({
  id, incidentId, incidentTitle: `Title ${incidentId}`, severity: 'high', service: 'svc', createdAt: hoursAgo(3), reasoning: 'CrashLoopBackOff follows a missing config map.', confidence: 82,
  steps: [
    { action: 'check_pod_status', reason: 'Confirm pod events and last termination.' },
    { action: 'restart_deployment', target: 'web', namespace: 'shop', reason: 'Restart after restoring the required config map.' },
  ], status: 'pending', namespace: 'default', ...extra,
})
const post = () => POST(new Request('http://localhost/api/autonomous/plan', { method: 'POST' }))

beforeEach(() => {
  vi.clearAllMocks()
  writeFileSync(PLANS, [
    plan('p1', 'INC-A'),                                  // never announced
    plan('p2', 'INC-B', { notifiedAt: hoursAgo(2) }),     // announced long ago, no reminder yet
    plan('p3', 'INC-GONE'),                               // incident no longer open
  ].map(p => JSON.stringify(p)).join('\n') + '\n')
})

afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

describe('pending plan notifications', () => {
  it('announces a pending plan once, reminds once, and ignores plans of closed incidents', async () => {
    const first = await (await post()).json()
    expect(first.planNotices).toBe(2)
    const titles = vi.mocked(notifyIncident).mock.calls.map(c => c[0].title)
    expect(titles.some(t => t.startsWith('AI plan awaiting approval for Title INC-A'))).toBe(true)
    expect(titles.some(t => t.startsWith('Reminder: AI plan awaiting approval for Title INC-B'))).toBe(true)
    expect(titles.some(t => t.includes('INC-GONE'))).toBe(false)
    const notice = vi.mocked(notifyIncident).mock.calls.find(([payload]) => payload.id === 'p1')?.[0]
    expect(notice?.detail).toContain('Root cause: CrashLoopBackOff follows a missing config map.')
    expect(notice?.detail).toContain('Confidence: 82%')
    expect(notice?.detail).toContain('restart_deployment (shop/web) - Restart after restoring the required config map.')

    const second = await (await post()).json()
    expect(second.planNotices).toBe(0)
    const stored = readFileSync(PLANS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(stored.find(p => p.id === 'p1').notifiedAt).toBeTruthy()
    expect(stored.find(p => p.id === 'p2').reminderSentAt).toBeTruthy()
  })
})
