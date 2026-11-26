import { describe, it, expect, vi, beforeEach } from 'vitest'

const k8s = vi.hoisted(() => ({ url: 'http://k8s.test' as string | null }))

vi.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }))
vi.mock('@/lib/cluster', () => ({ resolveK8sUrl: async () => k8s.url, resolveClusterMeta: async () => ({ name: 'test-cluster' }) }))
vi.mock('@/lib/rbac', () => ({ assertOperator: vi.fn().mockResolvedValue(null), getSessionUserId: async () => 'test-operator' }))
vi.mock('@/app/api/settings/config/shared', () => ({ appendAuditLog: vi.fn() }))

import { GET } from '@/app/api/k8s/deployments-history/route'
import { POST as rollback } from '@/app/api/k8s/deployments/[namespace]/[name]/rollback/route'
import { POST as restart } from '@/app/api/k8s/deployments/[namespace]/[name]/restart/route'
import { appendAuditLog } from '@/app/api/settings/config/shared'

const day = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * day).toISOString()
const rs = (name: string, owner: string, ns: string, revision: number, replicas: number, ready: number, createdDaysAgo: number) => ({
  metadata: { name, namespace: ns, creationTimestamp: ago(createdDaysAgo), annotations: { 'deployment.kubernetes.io/revision': String(revision) }, ownerReferences: [{ kind: 'Deployment', name: owner }] },
  spec: { replicas, template: { metadata: { labels: { app: owner, 'pod-template-hash': 'abc' } }, spec: { containers: [{ name: 'c', image: `img:${revision}` }] } } },
  status: { readyReplicas: ready },
})
const deployment = (name: string, ns: string, replicas: number) => ({ metadata: { name, namespace: ns, annotations: {} }, spec: { replicas, strategy: {} }, status: {} })

const patches = vi.fn()
async function fakeFetch(input: unknown, init?: RequestInit) {
  const url = String(input)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  if (init?.method === 'PATCH') { patches(url, init.body); return json({}) }
  if (url.endsWith('/apis/apps/v1/deployments')) return json({ items: [deployment('idle', 'lab', 0), deployment('web', 'prod-shop', 2)] })
  if (url.endsWith('/apis/apps/v1/replicasets')) return json({ items: [
    rs('idle-1', 'idle', 'lab', 1, 0, 0, 10),
    rs('web-2', 'web', 'prod-shop', 2, 2, 2, 1),
    rs('web-1', 'web', 'prod-shop', 1, 0, 0, 5),
  ] })
  if (url.endsWith('/replicasets/other-1')) return json(rs('other-1', 'other', 'prod-shop', 1, 0, 0, 3))
  if (url.endsWith('/replicasets/web-1')) return json(rs('web-1', 'web', 'prod-shop', 1, 0, 0, 5))
  return json({}, 404)
}

beforeEach(() => {
  vi.clearAllMocks()
  k8s.url = 'http://k8s.test'
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})

const ctx = (namespace: string, name: string) => ({ params: Promise.resolve({ namespace, name }) })
const rollbackReq = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }) as any

describe('deployments history accuracy', () => {
  it('reports N/A rates when there are no deployments in the measurement window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))))
    const { events, dora } = await (await GET()).json()
    expect(events).toHaveLength(0)
    expect(dora.ratedDeploys30d).toBe(0)
    expect(dora.failedDeploys30d).toBe(0)
    expect(dora.deploys7d).toBe(0)
    expect(dora.successRate).toBeNull()
    expect(dora.changeFailureRate).toBeNull()
    expect(dora.frequencyBand).toBe('no-data')
    expect(dora.cfrBand).toBe('no-data')
  })

  it('keeps every real revision, not just the current one', async () => {
    const { events } = await (await GET()).json()
    expect(events.filter((e: any) => e.service === 'web')).toHaveLength(2)
  })

  it('does not call a deployment scaled to 0 a failure', async () => {
    const { events, dora } = await (await GET()).json()
    const idle = events.find((e: any) => e.service === 'idle')
    expect(idle.scaledToZero).toBe(true)
    expect(idle.status).toBe('success')
    expect(idle.riskScore).toBeLessThan(80)
    expect(dora.changeFailureRate).toBe(0)
    expect(dora.successRate).toBe(100)
  })

  it('never presents an internal id as a commit and does not guess the environment', async () => {
    const { events } = await (await GET()).json()
    expect(events.every((e: any) => e.commitSha === '')).toBe(true)
    expect(events.find((e: any) => e.service === 'idle').environment).toBe('unknown')
    expect(events.find((e: any) => e.service === 'web').environment).toBe('production')
  })
})

describe('deployment actions', () => {
  it('refuses to roll back to a ReplicaSet owned by another deployment', async () => {
    const res = await rollback(rollbackReq({ rsName: 'other-1' }), ctx('prod-shop', 'web'))
    expect(res.status).toBe(400)
    expect(patches).not.toHaveBeenCalled()
  })

  it('rolls back without the pod-template-hash label and records an audit entry', async () => {
    const res = await rollback(rollbackReq({ rsName: 'web-1' }), ctx('prod-shop', 'web'))
    expect(res.status).toBe(200)
    expect(patches).toHaveBeenCalledTimes(1)
    expect(String(patches.mock.calls[0]![1])).not.toContain('pod-template-hash')
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'deployment.rollback', user: 'test-operator' }))
  })

  it('reports an unreachable cluster instead of faking success', async () => {
    k8s.url = null
    const res = await rollback(rollbackReq({ rsName: 'web-1' }), ctx('prod-shop', 'web'))
    expect(res.status).toBe(503)
  })

  it('audits restarts', async () => {
    const res = await restart(new Request('http://localhost/x', { method: 'POST' }), ctx('prod-shop', 'web'))
    expect(res.status).toBe(200)
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'deployment.restart' }))
  })
})
