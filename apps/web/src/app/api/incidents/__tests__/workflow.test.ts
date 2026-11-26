import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const sandbox = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vynk8s-incidents-'))
  fs.mkdirSync(path.join(root, 'data'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  return root
})
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
const internalFetchMock = vi.hoisted(() => vi.fn())
const generateTextMock = vi.hoisted(() => vi.fn())

vi.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } }) } }))
vi.mock('@/lib/cluster', () => ({ resolvePromUrl: async () => 'https://prometheus.example.invalid', resolveK8sUrl: async () => 'http://k8s.test', K8S_TIMEOUT_MS: 100 }))
vi.mock('@/lib/rbac', () => ({ assertSession: vi.fn().mockResolvedValue(null), assertOperator: vi.fn().mockResolvedValue(null), getSessionUserId: async () => 'test-operator' }))
vi.mock('@/lib/auth', () => ({ auth: (handler: unknown) => handler }))
vi.mock('@/lib/internal', () => ({ isInternalPath: (pathname: string) => pathname === '/api/incidents/worker', hasInternalSecret: (headers: Headers) => headers.get('authorization') === 'Bearer test-only', internalFetch: (...args: unknown[]) => internalFetchMock(...args) }))
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => generateTextMock(...args) }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => (_model: string) => ({}) }))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: () => (_model: string) => ({}) }))
vi.mock('@/lib/anthropic', () => ({ createAnthropicModel: () => ({}) }))
vi.mock('next', () => ({ default: () => ({ prepare: async () => {}, getRequestHandler: () => vi.fn() }) }))
vi.mock('http', () => ({ createServer: () => ({ prependListener: vi.fn(), listen: (_port: number, _host: string, ready: () => void) => ready() }) }))
vi.mock('ws', () => ({ WebSocketServer: class {}, WebSocket: class {} }))
vi.mock('@/app/api/settings/config/shared', () => ({ readConfig: () => config.current, appendNotifLog: vi.fn(), appendAuditLog: vi.fn() }))

import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { GET, POST } from '@/app/api/incidents/route'
import { PATCH } from '@/app/api/incidents/[id]/route'
import { POST as worker } from '@/app/api/incidents/worker/route'
import { POST as escalate } from '@/app/api/incidents/auto-escalate/route'
import { POST as manualEscalate } from '@/app/api/settings/oncall/escalate/route'
import { POST as autoTrigger } from '@/app/api/automation/auto-trigger/route'
import { POST as generatePlan } from '@/app/api/autonomous/plan/route'
import { POST as alertWebhook } from '@/app/api/alerts/webhook/route'
import { manualStore, buildAutoIncidents, reconcileAutoIncidents, persistStore, compactNotificationTimeline, normalizeAlertSeverity, NOTIFY_MAX_ATTEMPTS, affectedSummary, escalationClockStart } from '@/app/api/incidents/shared'
import { notifyIncident, notifyEscalation } from '@/lib/notify'
import { appendAuditLog, appendNotifLog } from '@/app/api/settings/config/shared'
import { assertOperator } from '@/lib/rbac'
import { resolveEscalationContact } from '@/app/api/settings/oncall/shared'
import proxy from '@/proxy'

const request = (body: unknown) => new Request('http://localhost/api/incidents', { method: 'POST', body: JSON.stringify(body) }) as any
const cronRequest = () => new Request('http://localhost/api/incidents/worker', { method: 'POST', headers: { authorization: 'Bearer test-only' } })
let firing = true
let alertName = 'KubePodCrashLooping'
let sourceOk = true
let deliveryOk = true
async function simulatedFetch(input: unknown, _init?: RequestInit) {
  const url = String(input)
  if (url.includes('/api/incidents/worker')) return new Response(JSON.stringify({ ok: true, pending: 0 }))
  if (url.includes('/api/autonomous/loop')) return new Response(JSON.stringify({ skipped: true }))
  if (url.startsWith('https://prometheus.example.invalid')) {
    if (!sourceOk) return new Response(JSON.stringify({ status: 'error' }), { status: 503 })
    const metric = { alertname: alertName, severity: 'critical', job: 'test' }
    const result = firing ? [{ metric, value: [Date.now() / 1000, url.includes('ALERTS_FOR_STATE') ? String(Date.now() / 1000 - 120) : '1'] }] : []
    return new Response(JSON.stringify({ status: 'success', data: url.endsWith('/rules') ? { groups: [] } : { result } }))
  }
  return new Response(deliveryOk ? 'ok' : 'unavailable', { status: deliveryOk ? 200 : 503 })
}
const fetchMock = vi.fn(simulatedFetch)

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation(simulatedFetch)
  vi.stubEnv('CRON_SECRET', 'test-only')
  vi.stubGlobal('fetch', fetchMock)
  config.current = { slack_webhook_url: 'https://hooks.slack.com/services/test-only', auto_escalate_enabled: false }
  internalFetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', steps: [{ name: 'Scan pods', status: 'warn', output: 'Synthetic CrashLoopBackOff detected' }], duration: 42 })))
  generateTextMock.mockReset().mockResolvedValue({
    text: JSON.stringify({
      reasoning: 'CrashLoopBackOff follows a missing config map.',
      confidence: 82,
      namespace: 'shop',
      steps: [
        { action: 'check_pod_status', target: 'web', namespace: 'shop', reason: 'Confirm pod events and last termination.' },
        { action: 'restart_deployment', target: 'web', namespace: 'shop', reason: 'Restart after restoring the required config map.' },
      ],
    }),
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  })
  firing = sourceOk = deliveryOk = true
  alertName = 'KubePodCrashLooping'
  ;(globalThis as any).vynk8sBlind = undefined
  manualStore.clear()
  persistStore()
  vi.mocked(assertOperator).mockResolvedValue(null)
})

afterAll(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(sandbox, { recursive: true, force: true })
})

describe('isolated incident workflow', () => {
  it('names the affected workloads and starts the escalation clock at the latest reopen', () => {
    const alert = (name: string, labels: Record<string, string>) => ({ name, labels }) as any
    expect(affectedSummary({ alerts: [alert('KubePodCrashLooping', { namespace: 'shop', pod: 'web-1' }), alert('KubePodNotReady', { namespace: 'shop', pod: 'web-1' })] })).toBe('shop/web-1 (KubePodCrashLooping, KubePodNotReady)')
    expect(affectedSummary({ alerts: [1, 2, 3, 4].map(n => alert('A', { namespace: 'ns', deployment: `d${n}` })) })).toContain('+1 more')
    expect(affectedSummary({ alerts: [] })).toBe('')
    const created = '2026-01-01T00:00:00.000Z'
    const reopened = '2026-01-02T00:00:00.000Z'
    expect(escalationClockStart({ createdAt: created, timeline: [] })).toBe(Date.parse(created))
    expect(escalationClockStart({ createdAt: created, timeline: [{ title: 'Alerts firing again', ts: reopened } as any] })).toBe(Date.parse(reopened))
  })

  it('persists creation, ownership, notes, resolution and reopening with trusted actors', async () => {
    const incident = await (await POST(request({ title: 'Test incident', severity: 'high' }))).json()
    const context = { params: Promise.resolve({ id: incident.id }) }
    await PATCH(request({ owner: 'test-owner', note: 'triaged', actor: 'spoofed' }), context)
    await PATCH(request({ state: 'resolved', actor: 'spoofed' }), context)
    expect(manualStore.get(incident.id)!.resolvedAt).toBeTruthy()
    await PATCH(request({ state: 'investigating' }), context)
    const stored = JSON.parse(readFileSync(join(sandbox, 'data/incidents-manual.json'), 'utf8'))[incident.id]
    expect(stored.resolvedAt).toBeUndefined()
    expect(stored.owner).toBe('test-owner')
    expect(stored.timeline.filter((event: any) => event.type === 'user_action').every((event: any) => event.actor === 'test-operator')).toBe(true)
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'incident.created', user: 'test-operator' }))
    expect(stored.notificationPending).toBe(true)
  })

  it('rejects viewer creation and invalid lifecycle state', async () => {
    vi.mocked(assertOperator).mockResolvedValueOnce(new Response('Forbidden', { status: 403 }) as any)
    expect((await POST(request({ title: 'denied' }))).status).toBe(403)
    expect(manualStore.size).toBe(0)
    const created = await (await POST(request({ title: 'valid' }))).json()
    expect((await PATCH(request({ state: 'made-up' }), { params: Promise.resolve({ id: created.id }) })).status).toBe(400)
  })

  it('runs without browser or healing enabled, deduplicates notifications and preserves recovery history', async () => {
    expect((await worker(cronRequest())).status).toBe(200)
    const incident = [...manualStore.values()][0]
    expect(incident.source).toBe('auto')
    expect(incident.notificationPending).toBe(false)
    const deliveries = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('hooks.slack.com')).length
    expect(deliveries()).toBe(1)
    await worker(cronRequest())
    expect(deliveries()).toBe(1)
    firing = false
    await worker(cronRequest())
    expect(incident.state).toBe('resolved')
    expect(deliveries()).toBe(2)
    const slackBodies = fetchMock.mock.calls.filter(([url]) => String(url).includes('hooks.slack.com')).map(([, init]) => String((init as RequestInit | undefined)?.body))
    expect(slackBodies[1]).toContain('test (KubePodCrashLooping)')
    firing = true
    await worker(cronRequest())
    expect(incident.state).toBe('investigating')
    expect(incident.timeline.some(event => event.title === 'Alerts recovered')).toBe(true)
    expect(incident.timeline.some(event => event.title === 'Alerts firing again')).toBe(true)
    const heartbeat = JSON.parse(readFileSync(join(sandbox, 'data/incident-worker.json'), 'utf8'))
    expect(heartbeat.ok).toBe(true)
    expect(heartbeat.completedAt).toBeTruthy()
  })

  it('does not recover incidents on source failure', async () => {
    await worker(cronRequest())
    sourceOk = false
    const response = await (await worker(cronRequest())).json()
    expect(response.hasPrometheus).toBe(false)
    expect([...manualStore.values()][0].state).not.toBe('resolved')
  })

  it('runs one synthetic CrashLoop through notification, Claude RCA plan, runbook, escalation, recovery, and audit', async () => {
    config.current = {
      slack_webhook_url: 'https://hooks.slack.com/services/test-only',
      teams_webhook_url: 'https://teams.example.invalid/hook',
      auto_escalate_enabled: true,
      auto_runbook_enabled: true,
      auto_plan_enabled: true,
      auto_execute_plans: false,
      ai_provider: 'anthropic',
      ai_api_key: 'test-only',
    }
    writeFileSync(join(sandbox, 'data/oncall.json'), JSON.stringify({ schedules: [{
      id: 'primary', name: 'Test on-call', rotationDays: 7, rotationStart: new Date().toISOString(),
      members: [{ id: 'test-member', name: 'Test On-call', email: 'test@example.invalid', slack: 'U123TEST' }],
      escalationLevels: [{ level: 1, delayMins: 0, description: 'Primary on-call', memberId: 'test-member' }],
    }] }))

    await worker(cronRequest())
    const incident = [...manualStore.values()][0]
    expect(incident.title).toBe('Kubernetes Workload Issues')
    expect(incident.alerts[0].name).toBe('KubePodCrashLooping')
    expect(incident.escalationLevel).toBe(1)

    const response = await autoTrigger(new Request('http://localhost/api/automation/auto-trigger', { method: 'POST' }))
    const result = await response.json()
    expect(result.runs).toEqual([{ incidentId: incident.id, runbookId: 'diagnose-crash-loop', status: 'completed' }])
    expect(internalFetchMock).toHaveBeenCalledWith('/api/automation/execute', expect.objectContaining({ method: 'POST' }))

    const automation = readFileSync(join(sandbox, 'data/automation.log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(automation).toHaveLength(1)
    expect(automation[0]).toMatchObject({ incidentId: incident.id, runbookId: 'diagnose-crash-loop', status: 'completed' })
    expect(incident.timeline.some(event => event.title === 'Auto-ran runbook: diagnose crash loop')).toBe(true)

    const planResponse = await generatePlan(cronRequest())
    const planResult = await planResponse.json()
    expect(planResult.generated).toBe(1)
    expect(generateTextMock.mock.calls[0][0]).not.toHaveProperty('temperature')
    const plans = readFileSync(join(sandbox, 'data/autonomous.plans.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(plans[0]).toMatchObject({ incidentId: incident.id, status: 'pending', confidence: 82 })

    firing = false
    await worker(cronRequest())
    expect(incident.state).toBe('resolved')
    expect(incident.timeline.some(event => event.title === 'Alerts recovered')).toBe(true)

    const bodiesFor = (host: string) => fetchMock.mock.calls
      .filter(([url]) => String(url).includes(host))
      .map(([, init]) => String((init as RequestInit | undefined)?.body))
    const slackBodies = bodiesFor('hooks.slack.com')
    const teamsBodies = bodiesFor('teams.example.invalid')
    for (const [channel, bodies] of [['Slack', slackBodies], ['Teams', teamsBodies]] as const) {
      expect(bodies.some(body => body.includes('Kubernetes Workload Issues') && body.includes(incident.id)), `${channel} incident notice`).toBe(true)
      expect(bodies.some(body => body.includes('VynK8s Escalation') && body.includes('Primary on-call')), `${channel} escalation`).toBe(true)
      expect(bodies.some(body => body.includes('Root cause: CrashLoopBackOff follows a missing config map.') && body.includes('restart_deployment')), `${channel} RCA/remediation plan`).toBe(true)
      expect(bodies.some(body => body.includes('Incident resolved')), `${channel} recovery notice`).toBe(true)
    }

    const timelineTitles = incident.timeline.map(event => event.title)
    const milestoneIndexes = [
      '1 alert detected',
      'Auto-escalated to L1',
      'Auto-ran runbook: diagnose crash loop',
      'Alerts recovered',
    ].map(title => timelineTitles.indexOf(title))
    expect(milestoneIndexes.every(index => index >= 0)).toBe(true)
    expect(milestoneIndexes).toEqual([...milestoneIndexes].sort((a, b) => a - b))

    const auditActions = vi.mocked(appendAuditLog).mock.calls.map(([entry]) => entry.action)
    expect(auditActions).toEqual(expect.arrayContaining(['incident.created', 'incident.escalated', 'incident.resolved']))
  })

  it('retains pending delivery after bounded retries and retries on a later cycle', async () => {
    deliveryOk = false
    await worker(cronRequest())
    const incident = [...manualStore.values()][0]
    expect(incident.notificationPending).toBe(true)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('hooks.slack.com'))).toHaveLength(3)
    deliveryOk = true
    await worker(cronRequest())
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('hooks.slack.com'))).toHaveLength(3)
    incident.notificationNextAttemptAt = new Date(Date.now() - 1000).toISOString()
    await worker(cronRequest())
    expect(incident.notificationPending).toBe(false)
    expect(incident.timeline.some(event => event.title === 'Notification failed')).toBe(true)
    expect(incident.timeline.some(event => event.title === 'Notification delivered')).toBe(true)
  })

  it('backs off, records one failure entry, and abandons after the attempt cap', async () => {
    deliveryOk = false
    await worker(cronRequest())
    const incident = [...manualStore.values()][0]
    for (let i = 0; i < NOTIFY_MAX_ATTEMPTS + 2; i++) {
      incident.notificationNextAttemptAt = new Date(Date.now() - 1000).toISOString()
      await worker(cronRequest())
    }
    expect(incident.notificationPending).toBe(false)
    expect(incident.notificationAbandoned).toBe(true)
    expect(incident.notificationAttempts).toBe(NOTIFY_MAX_ATTEMPTS)
    expect(incident.timeline.filter(event => event.title === 'Notification failed')).toHaveLength(1)
    expect(incident.timeline.filter(event => event.title === 'Notification abandoned')).toHaveLength(1)
    const heartbeat = JSON.parse(readFileSync(join(sandbox, 'data/incident-worker.json'), 'utf8'))
    expect(heartbeat.ok).toBe(false)
    expect(heartbeat.abandoned).toBe(1)
    const slackCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('hooks.slack.com')).length
    const calls = slackCalls()
    await worker(cronRequest())
    expect(slackCalls()).toBe(calls)
  })

  it('does not retry before the backoff window elapses', async () => {
    deliveryOk = false
    await worker(cronRequest())
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes('hooks.slack.com')).length
    await worker(cronRequest())
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('hooks.slack.com'))).toHaveLength(calls)
  })

  it('compacts runs of identical notification entries', () => {
    const entry = (n: number) => ({ id: `t${n}`, ts: `2026-01-01T00:00:0${n}Z`, type: 'notification', title: 'Notification failed', description: 'x', actor: 'system' })
    const incident = { timeline: [{ id: 'a', ts: 't', type: 'alert', title: 'A', description: '', actor: 's' }, entry(1), entry(2), entry(3)] } as any
    expect(compactNotificationTimeline(incident)).toBe(2)
    expect(incident.timeline).toHaveLength(2)
    expect(incident.timeline[1].metadata.repeats).toBe(3)
  })

  it('reopens an incident resolved by hand while its alerts are still firing, after the grace period', async () => {
    await worker(cronRequest())
    const incident = [...manualStore.values()][0]
    incident.state = 'resolved'
    incident.resolvedAt = new Date(Date.now() - 5 * 60_000).toISOString()
    await worker(cronRequest())
    expect(incident.state).toBe('resolved')
    incident.resolvedAt = new Date(Date.now() - 31 * 60_000).toISOString()
    await worker(cronRequest())
    expect(incident.state).toBe('investigating')
    expect(incident.notificationEvent).toBe('incident.reopened')
    expect(incident.timeline.some(event => event.title === 'Alerts firing again')).toBe(true)
  })

  it('routes medium incidents through the warning routing', async () => {
    config.current = { slack_webhook_url: 'https://hooks.slack.com/services/test-only', teams_webhook_url: 'https://teams.example.invalid/hook', alert_routing: { warning: ['slack'] } }
    await notifyIncident({ id: 'test', title: 'test', severity: 'medium', service: 'test', state: 'open' })
    const hosts = fetchMock.mock.calls.map(([url]) => String(url))
    expect(hosts.some(url => url.includes('hooks.slack.com'))).toBe(true)
    expect(hosts.some(url => url.includes('teams.example.invalid'))).toBe(false)
  })

  it('maps Prometheus warning severity to medium', () => {
    expect(normalizeAlertSeverity('warning')).toBe('medium')
    expect(normalizeAlertSeverity('critical')).toBe('critical')
    expect(normalizeAlertSeverity(undefined)).toBe('medium')
  })

  it('ages old breaches out of the SLA metrics but keeps them in the list', async () => {
    firing = false
    const created = await (await POST(request({ title: 'Old breach', severity: 'high' }))).json()
    const incident = manualStore.get(created.id)!
    const day = 86_400_000
    incident.state = 'resolved'
    incident.createdAt = new Date(Date.now() - 45 * day).toISOString()
    incident.slaDeadline = new Date(Date.now() - 44 * day).toISOString()
    incident.resolvedAt = new Date(Date.now() - 40 * day).toISOString()
    const recent = await (await GET()).json()
    expect(recent.incidents.some((item: any) => item.id === created.id && item.slaBreached)).toBe(true)
    expect(recent.metrics.slaBreached).toBe(0)
    expect(recent.metrics.slaCompliancePct).toBe(100)
    expect(recent.metrics.windowDays).toBe(30)
    const wide = await (await GET(new Request('http://localhost/api/incidents?windowDays=60') as any)).json()
    expect(wide.metrics.slaBreached).toBe(1)
    expect(wide.metrics.slaCompliancePct).toBe(0)
  })

  it('tells people once when Prometheus stays unreachable, and again when it recovers', async () => {
    const slackCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('hooks.slack.com')).length
    firing = false
    sourceOk = false
    await worker(cronRequest())
    expect(slackCalls()).toBe(0)
    ;(globalThis as any).vynk8sBlind.since = Date.now() - 6 * 60_000
    await worker(cronRequest())
    expect(slackCalls()).toBe(1)
    await worker(cronRequest())
    expect(slackCalls()).toBe(1)
    sourceOk = true
    await worker(cronRequest())
    expect(slackCalls()).toBe(2)
    await worker(cronRequest())
    expect(slackCalls()).toBe(2)
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'monitoring.unavailable' }))
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'monitoring.restored' }))
  })

  it('rejects cron calls without the matching secret', async () => {
    expect((await worker(request({}))).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['VynK8sWorkloadDown', 'VynK8sWorkloadDegraded', 'VynK8sPodRestartingFast'])('groups the fast alert %s with workload issues', async name => {
    alertName = name
    const detected = await buildAutoIncidents()
    expect(detected.incidents.map(i => i.title)).toEqual(['Kubernetes Workload Issues'])
  })

  it('does not advance failed escalation and records successful retry exactly once', async () => {
    config.current.auto_escalate_enabled = true
    writeFileSync(join(sandbox, 'data/oncall.json'), JSON.stringify({ schedules: [{ members: [{ id: 'test-member', name: 'test-contact', email: 'test@example.invalid', slack: 'U123TEST' }], escalationLevels: [{ level: 1, delayMins: 0, description: 'Primary' }] }] }))
    const detected = await buildAutoIncidents()
    reconcileAutoIncidents(detected.incidents, detected.hasPrometheus)
    deliveryOk = false
    await escalate(cronRequest())
    const incident = [...manualStore.values()][0]
    expect(incident.escalationLevel).toBe(0)
    expect(incident.timeline.at(-1)?.title).toContain('failed')
    deliveryOk = true
    await escalate(cronRequest())
    expect(incident.escalationLevel).toBe(1)
    const count = incident.timeline.length
    await escalate(cronRequest())
    expect(incident.timeline).toHaveLength(count)
  })

  it('reports disabled and unconfigured channels without claiming delivery', async () => {
    config.current = { notify_on: { critical_incidents: false } }
    const payload = { id: 'test', title: 'test', severity: 'critical', service: 'test', state: 'open' }
    expect((await notifyIncident(payload)).status).toBe('disabled')
    expect(fetchMock).not.toHaveBeenCalled()
    config.current = {}
    vi.stubEnv('SLACK_WEBHOOK_URL', '')
    vi.stubEnv('ALERT_WEBHOOK_URL', '')
    vi.stubEnv('TEAMS_WEBHOOK_URL', '')
    expect((await notifyIncident(payload)).status).toBe('unconfigured')
    expect(appendNotifLog).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, status: 'unconfigured' }))
  })

  it('uses Slack user ID mention syntax', async () => {
    await notifyEscalation({ incidentId: 'test', incidentTitle: 'test', severity: 'high', service: 'test', levelDesc: 'Primary', nextLevel: 1, contactName: 'test-contact', contactEmail: 'test@example.invalid', contactSlack: 'U123TEST' })
    expect(appendNotifLog).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, incidentId: 'test' }))
    expect(fetchMock.mock.calls.at(-1)?.[1]?.body).toContain('<@U123TEST>')
  })

  it('persists real manual escalation and leaves failure retryable', async () => {
    writeFileSync(join(sandbox, 'data/oncall.json'), JSON.stringify({ schedules: [{ members: [{ id: 'test', name: 'test-contact', email: 'test@example.invalid' }], escalationLevels: [{ delayMins: 0, description: 'Primary' }] }] }))
    const incident = await (await POST(request({ title: 'manual test' }))).json()
    deliveryOk = false
    expect((await manualEscalate(request({ incidentId: incident.id, currentLevel: 99 }))).status).toBe(502)
    expect(manualStore.get(incident.id)!.escalationLevel).toBe(0)
    deliveryOk = true
    expect((await manualEscalate(request({ incidentId: incident.id }))).status).toBe(200)
    expect(manualStore.get(incident.id)!.escalationLevel).toBe(1)
    expect(appendAuditLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'incident.escalated', user: 'test-operator' }))
  })

  it('rejects malformed and unauthenticated webhooks, and exposes delivery failure for upstream retry', async () => {
    vi.stubEnv('ALERTMANAGER_SECRET', 'test-only')
    expect((await alertWebhook(request({}))).status).toBe(401)
    const send = (body: unknown) => new Request('http://localhost/api/alerts/webhook', { method: 'POST', headers: { 'x-alertmanager-secret': 'test-only' }, body: JSON.stringify(body) })
    expect((await alertWebhook(send({}))).status).toBe(400)
    const payload = { status: 'firing', commonLabels: { alertname: 'test', severity: 'high' }, groupLabels: {}, alerts: [{ status: 'firing', labels: { alertname: 'test' }, annotations: {}, startsAt: new Date().toISOString() }] }
    deliveryOk = false
    expect((await alertWebhook(send(payload))).status).toBe(502)
    expect(appendNotifLog).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'alert.firing', ok: false }))
  })

  it('forwards Alertmanager alerts to Slack and Teams, honoring alert routing', async () => {
    const send = () => new Request('http://localhost/api/alerts/webhook', { method: 'POST', headers: { 'x-alertmanager-secret': 'test-only' }, body: JSON.stringify({ status: 'firing', commonLabels: { alertname: 'DiskHigh', severity: 'warning' }, groupLabels: {}, alerts: [{ status: 'firing', labels: { alertname: 'DiskHigh' }, annotations: { summary: 'Disk over 80%' }, startsAt: new Date().toISOString() }] }) })
    config.current = { slack_webhook_url: 'https://hooks.slack.com/services/test-only', teams_webhook_url: 'https://teams.example.invalid/hook' }
    expect((await alertWebhook(send())).status).toBe(200)
    const urls = () => fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls().some(u => u.includes('hooks.slack.com'))).toBe(true)
    expect(urls().some(u => u.includes('teams.example.invalid'))).toBe(true)
    fetchMock.mockClear()
    config.current.alert_routing = { warning: ['teams'] }
    expect((await alertWebhook(send())).status).toBe(200)
    expect(urls().some(u => u.includes('hooks.slack.com'))).toBe(false)
    expect(urls().some(u => u.includes('teams.example.invalid'))).toBe(true)
  })

  it('starts and repeats the incident timer without a browser', async () => {
    vi.useFakeTimers()
    try {
      await import('../../../../../server.mjs')
      await vi.advanceTimersByTimeAsync(10000)
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/incidents/worker'))).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(50000)
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/incidents/worker'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates unique IDs even within the same millisecond', async () => {
    const responses = await Promise.all([POST(request({ title: 'one' })), POST(request({ title: 'two' }))])
    const incidents = await Promise.all(responses.map(response => response.json()))
    expect(incidents[0].id).not.toBe(incidents[1].id)
  })

  it('records an SLA breach once and freezes it after resolution', async () => {
    const created = await (await POST(request({ title: 'SLA test', severity: 'critical' }))).json()
    const incident = manualStore.get(created.id)!
    incident.slaDeadline = new Date(Date.now() - 60000).toISOString()
    await worker(cronRequest())
    await worker(cronRequest())
    expect(incident.timeline.filter(event => event.title === 'SLA deadline exceeded')).toHaveLength(1)
    expect(incident.notificationEvent).toBe('incident.sla_breached')
    await PATCH(request({ state: 'resolved' }), { params: Promise.resolve({ id: incident.id }) })
    expect((await (await GET()).json()).incidents.find((item: any) => item.id === incident.id).slaBreached).toBe(true)
  })

  it('respects rotation, override and explicit escalation contacts', () => {
    const members = [{ id: 'one', name: 'one', email: 'one@example.invalid' }, { id: 'two', name: 'two', email: 'two@example.invalid' }]
    const now = Date.now()
    const schedule = { id: 'test', name: 'test', members, rotationDays: 1, rotationStart: new Date(now - 86400000).toISOString(), escalationLevels: [{ level: 1, delayMins: 0, description: 'Primary' }] }
    expect(resolveEscalationContact(schedule, 0, now)?.id).toBe('two')
    expect(resolveEscalationContact({ ...schedule, overrideUntil: new Date(now + 1000).toISOString(), overrideMember: members[0] }, 0, now)?.id).toBe('one')
    expect(resolveEscalationContact({ ...schedule, escalationLevels: [{ ...schedule.escalationLevels[0], memberId: 'one' }] }, 0, now)?.id).toBe('one')
  })

  it('allows only exact cron paths with the matching secret through middleware', async () => {
    const call = (pathname: string, authorization: string) => proxy({ auth: null, nextUrl: { pathname }, headers: new Headers({ authorization }) } as any, {} as any)
    expect(await call('/api/incidents/worker', 'Bearer test-only')).toBeUndefined()
    expect((await call('/api/incidents/worker', 'Bearer wrong') as Response).status).toBe(401)
    expect((await call('/api/settings/config', 'Bearer test-only') as Response).status).toBe(401)
  })

  it('retries only undelivered channels after partial delivery', async () => {
    config.current.teams_webhook_url = 'https://teams.example.invalid/test-only'
    fetchMock.mockImplementation(async input => new Response(String(input).includes('teams.example.invalid') ? 'unavailable' : 'ok', { status: String(input).includes('teams.example.invalid') ? 503 : 200 }))
    const payload = { id: 'partial', title: 'partial', severity: 'high', service: 'test', state: 'open' }
    const first = await notifyIncident(payload)
    expect(first.channels).toEqual(['slack'])
    expect(first.ok).toBe(false)
    fetchMock.mockImplementation(async () => new Response('ok'))
    vi.clearAllMocks()
    const second = await notifyIncident(payload, 'incident.created', first.channels)
    expect(second.ok).toBe(true)
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('teams.example.invalid'))).toBe(true)
  })

  it('reloads persisted incident history and delivery state after module restart', async () => {
    const created = await (await POST(request({ title: 'restart test' }))).json()
    const previous = (globalThis as any).vynk8sIncidentStore
        delete (globalThis as any).vynk8sIncidentStore
    vi.resetModules()
    try {
      const reloaded = await import('@/app/api/incidents/shared')
      expect(reloaded.manualStore.get(created.id)?.notificationChannels).toEqual(['slack'])
      expect(reloaded.manualStore.get(created.id)?.timeline.some(event => event.title === 'Notification delivered')).toBe(true)
    } finally {
      Object.assign(globalThis, { vynk8sIncidentStore: previous })
    }
  })
})