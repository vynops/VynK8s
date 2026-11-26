import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  url: 'http://selected-cluster.test',
  failPath: '',
  requestedUrls: [] as string[],
  overrides: {} as Record<string, unknown>,
}))

vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
vi.mock('@/lib/cluster', () => ({ resolveK8sUrl: async () => state.url, K8S_TIMEOUT_MS: 1000 }))

import { GET } from './route'

const listData: Record<string, unknown> = {
  '/api/v1/pods': { items: [] },
  '/api/v1/namespaces': { items: [{ metadata: { name: 'apps', labels: { 'pod-security.kubernetes.io/enforce': 'restricted' } } }] },
  '/apis/networking.k8s.io/v1/networkpolicies': { items: [] },
  '/apis/apps/v1/daemonsets': { items: [{ metadata: { name: 'falco', namespace: 'runtime' }, spec: { template: { spec: { containers: [{ image: 'falcosecurity/falco:0.40' }] } } }, status: { numberReady: 2, desiredNumberScheduled: 3 } }] },
  '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings': { items: [] },
  '/apis/rbac.authorization.k8s.io/v1/clusterroles': { items: [] },
  '/api/v1/events?fieldSelector=type%3DWarning&limit=200': { items: [{ metadata: { uid: 'event-1' }, type: 'Warning', reason: 'Scheduled', message: 'Pod scheduled', involvedObject: { kind: 'Pod', name: 'web', namespace: 'apps' } }] },
}

beforeEach(() => {
  state.url = 'http://selected-cluster.test'
  state.failPath = ''
  state.requestedUrls = []
  state.overrides = {}
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    state.requestedUrls.push(url)
    const path = url.slice(state.url.length)
    if (path === state.failPath) return new Response('forbidden', { status: 403 })
    return new Response(JSON.stringify(state.overrides[path] ?? listData[path] ?? { items: [] }), { status: 200 })
  }))
})

describe('GET /api/security', () => {
  it('scans the resolved cluster and labels custom controls, Falco readiness, and warning events accurately', async () => {
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(state.requestedUrls.length).toBeGreaterThan(0)
    expect(state.requestedUrls.every(url => url.startsWith('http://selected-cluster.test/'))).toBe(true)
    expect(body.score).toBeTypeOf('number')
    expect(body.controls.unknown).toBe(1)
    expect(body.controls.checks.find((check: any) => check.id === 'SEC-13').pass).toBeNull()
    expect(body.kpis).toMatchObject({ falcoDetected: true, falcoRunning: true, falcoPods: 2, falcoDesiredPods: 3 })
    expect(body.warningEvents[0]).toMatchObject({ reason: 'Scheduled', priority: 'unclassified' })
    expect(body).not.toHaveProperty('threats')
    expect(body).not.toHaveProperty('cis')
  })

  it('fails the scan when any required Kubernetes source is unavailable', async () => {
    state.failPath = '/api/v1/namespaces'

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.error).toContain('/api/v1/namespaces returned HTTP 403')
    expect(body).not.toHaveProperty('score')
  })

  it('marks namespace controls unknown when no namespaces are returned', async () => {
    state.overrides['/api/v1/namespaces'] = { items: [] }

    const body = await (await GET()).json()
    const checks = new Map(body.controls.checks.map((check: any) => [check.id, check.pass]))

    expect(checks.get('SEC-01')).toBeNull()
    expect(checks.get('SEC-02')).toBeNull()
    expect(body.controls.unknown).toBe(3)
  })
})