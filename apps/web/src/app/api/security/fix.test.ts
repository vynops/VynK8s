import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  requestHeaders: {} as Record<string, string>,
  patchedUrls: [] as string[],
  patchBodies: [] as string[],
}))

vi.mock('next/headers', () => ({ headers: async () => new Headers(state.requestHeaders) }))
vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
vi.mock('@/lib/cluster', () => ({
  resolveK8sUrl: async () => state.requestHeaders['x-k8s-url'] ?? '',
  K8S_TIMEOUT_MS: 1000,
}))
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { role: 'operator', email: 'operator@example.test' } }) }))
vi.mock('@/app/api/settings/config/shared', () => ({ appendAuditLog: vi.fn() }))

import { POST } from './fix/route'

beforeEach(() => {
  state.requestHeaders = {
    'x-k8s-url': 'http://selected-cluster.test',
    'x-prom-url': 'none',
    'x-alertmanager-url': 'none',
    'x-loki-url': 'none',
    'x-jaeger-url': 'none',
    'x-grafana-url': 'none',
  }
  state.patchedUrls = []
  state.patchBodies = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'PATCH') {
      state.patchedUrls.push(url)
      state.patchBodies.push(String(init.body))
    }
    if (url.endsWith('/pods/cache-0')) {
      return new Response(JSON.stringify({ metadata: { name: 'cache-0', ownerReferences: [{ kind: 'StatefulSet', name: 'cache' }] } }), { status: 200 })
    }
    if (url.endsWith('/statefulsets/cache')) {
      return new Response(JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'redis', resources: { limits: {} } }] } } } }), { status: 200 })
    }
    return new Response(JSON.stringify({ metadata: { name: 'apps' } }), { status: 200 })
  }))
})

describe('POST /api/security/fix', () => {
  it('applies the fix to the cluster selected by the request headers', async () => {
    const request = new Request('http://localhost/api/security/fix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'add_psa_label', namespace: 'apps' }),
    })

    const response = await POST(request as any)

    expect(response.status).toBe(200)
    expect(state.patchedUrls).toEqual(['http://selected-cluster.test/api/v1/namespaces/apps'])
    expect(state.patchedUrls[0]).not.toContain('default-cluster')
  })

  it('resolves a StatefulSet pod and applies read-only-root-filesystem to the exact container', async () => {
    const request = new Request('http://localhost/api/security/fix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'set_read_only_root_fs', namespace: 'cache', podName: 'cache-0', containerName: 'redis' }),
    })

    const response = await POST(request as any)

    expect(response.status).toBe(200)
    expect(state.patchedUrls).toEqual(['http://selected-cluster.test/apis/apps/v1/namespaces/cache/statefulsets/cache'])
    expect(JSON.parse(state.patchBodies[0]!).spec.template.spec.containers).toEqual([
      { name: 'redis', securityContext: { readOnlyRootFilesystem: true } },
    ])
  })

  it('patches init-container security context in initContainers', async () => {
    const request = new Request('http://localhost/api/security/fix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'set_no_priv_esc', namespace: 'cache', podName: 'cache-0', containerName: 'init', containerType: 'initContainers' }),
    })

    const response = await POST(request as any)

    expect(response.status).toBe(200)
    const patch = JSON.parse(state.patchBodies[0]!)
    expect(patch.spec.template.spec.initContainers).toEqual([
      { name: 'init', securityContext: { allowPrivilegeEscalation: false } },
    ])
    expect(patch.spec.template.spec.containers).toBeUndefined()
  })

  it('rejects invalid container list targets before patching', async () => {
    const request = new Request('http://localhost/api/security/fix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'set_no_priv_esc', namespace: 'cache', podName: 'cache-0', containerName: 'redis', containerType: '__proto__' }),
    })

    const response = await POST(request as any)

    expect(response.status).toBe(400)
    expect(state.patchedUrls).toHaveLength(0)
  })
})