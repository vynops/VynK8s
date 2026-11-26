import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const sandbox = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vynk8s-autoheal-'))
  fs.mkdirSync(path.join(root, 'data'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  return root
})
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock('next/server', () => ({ NextResponse: { json: (body: unknown) => new Response(JSON.stringify(body)) } }))
vi.mock('@/lib/cluster', () => ({ resolveK8sUrl: async () => 'http://k8s.test', resolvePromUrl: async () => 'http://prom.test', K8S_TIMEOUT_MS: 100 }))
vi.mock('@/app/api/incidents/shared', () => ({ manualStore: new Map() }))
vi.mock('@/lib/notify', () => ({ teamsPayload: (title: string, detail: string) => ({ title, detail }) }))
vi.mock('@/app/api/settings/config/shared', () => ({ readConfig: () => config.current, appendNotifLog: vi.fn(), appendAuditLog: vi.fn() }))

import { appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { GET } from '@/app/api/ai/insights/route'
import { appendAuditLog } from '@/app/api/settings/config/shared'

const crashPod = {
  metadata: { name: 'web-abc-1', namespace: 'shop', ownerReferences: [{ kind: 'ReplicaSet', name: 'web-abc' }] },
  status: { phase: 'Running', containerStatuses: [{ restartCount: 25, state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
}
const patches = vi.fn()
const teamsPosts = vi.fn()
const slackPosts = vi.fn()
let highRestartMetric = false

async function fakeFetch(input: unknown, init?: RequestInit) {
  const url = String(input)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  if (url.startsWith('https://teams.test')) { teamsPosts(init?.body); return new Response('', { status: 202 }) }
  if (url.startsWith('https://hooks.slack.com/')) { slackPosts(init?.body); return new Response('ok', { status: 200 }) }
  if (url.startsWith('http://prom.test/api/v1/query')) {
    const query = new URL(url).searchParams.get('query') ?? ''
    const result = highRestartMetric && query.startsWith('topk(5, increase(')
      ? [{ metric: { pod: 'falco-falcosidekick-ui-redis-0', container: 'redis', namespace: 'falco' }, value: [Date.now() / 1000, '16'] }]
      : []
    return json({ data: { result } })
  }
  if (init?.method === 'PATCH') { patches(url); return json({}) }
  if (url === 'http://k8s.test/api/v1/pods') return json({ items: [crashPod] })
  if (url.endsWith('/replicasets/web-abc')) return json({ metadata: { ownerReferences: [{ kind: 'Deployment', name: 'web' }] } })
  if (url.endsWith('/deployments/web')) return json({ metadata: { annotations: {} } })
  if (url.startsWith('http://k8s.test')) return json({ items: [] })
  return json({}, 503)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  highRestartMetric = false
  rmSync(join(sandbox, 'data/autoheal.log.jsonl'), { force: true })
  config.current = {}
})

afterAll(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(sandbox, { recursive: true, force: true })
})

describe('crash-loop auto-restart gating', () => {
  it('does nothing while autonomous healing is disabled', async () => {
    const body = await (await GET()).json()
    expect(patches).not.toHaveBeenCalled()
    expect(body.autoHealSkipped).toEqual(['shop/web'])
    expect(body.insights).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'rca',
        severity: 'critical',
        title: 'CrashLoopBackOff: web-abc-1',
        suggestedAction: 'Run multi-layer RCA to identify root cause',
      }),
    ]))
  })

  it('does nothing in dry-run, which is the default when the flag is unset', async () => {
    config.current = { autonomous_enabled: true }
    await GET()
    expect(patches).not.toHaveBeenCalled()
    config.current = { autonomous_enabled: true, autonomous_dry_run: true }
    await GET()
    expect(patches).not.toHaveBeenCalled()
  })

  it('restarts and audits only when enabled and live', async () => {
    config.current = { autonomous_enabled: true, autonomous_dry_run: false }
    const body = await (await GET()).json()
    expect(patches).toHaveBeenCalledTimes(1)
    expect(body.autoHealed).toHaveLength(1)
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'autonomous.auto_heal', user: 'autonomous-agent' }))
  })

  it('stops after the per-workload cap and notifies including Teams', async () => {
    config.current = { autonomous_enabled: true, autonomous_dry_run: false, teams_webhook_url: 'https://teams.test/hook', alert_routing: { critical: ['teams'] } }
    const line = JSON.stringify({ ts: new Date().toISOString(), key: 'shop/web' }) + '\n'
    appendFileSync(join(sandbox, 'data/autoheal.log.jsonl'), line.repeat(3))
    const body = await (await GET()).json()
    expect(patches).not.toHaveBeenCalled()
    expect(body.healExhausted).toEqual(['shop/web'])
    expect(teamsPosts).toHaveBeenCalledTimes(1)
    expect(String(teamsPosts.mock.calls[0]![0])).toContain('auto heal exhausted')
  })

  it('sends readable high-restart notifications to Slack and Teams', async () => {
    config.current = {
      slack_webhook_url: 'https://hooks.slack.com/services/test-only',
      teams_webhook_url: 'https://teams.test/hook',
      alert_routing: { warning: ['slack', 'teams'] },
    }
    highRestartMetric = true

    const body = await (await GET()).json()
    expect(body.insights).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'High restart rate: falco-falcosidekick-ui-redis-0' }),
    ]))

    expect(slackPosts).toHaveBeenCalledTimes(1)
    const slackPayload = JSON.parse(String(slackPosts.mock.calls[0]![0]))
    expect(JSON.stringify(slackPayload)).toContain('VynK8s WARNING - High Restart Rate on 1 container(s)')
    expect(JSON.stringify(slackPayload)).toContain('16 restarts in 6h')
    expect(JSON.stringify(slackPayload)).not.toContain('?')

    expect(teamsPosts).toHaveBeenCalledTimes(1)
    const teamsPayload = JSON.parse(String(teamsPosts.mock.calls[0]![0]))
    expect(teamsPayload.detail).toContain('VynK8s warning: high restarts - falco-falcosidekick-ui-redis-0: 16/6h')
    expect(JSON.stringify(teamsPayload)).not.toContain('?')
  })
})
