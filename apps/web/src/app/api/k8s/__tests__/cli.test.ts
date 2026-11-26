import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deny: null as Response | null,
  appendAuditLog: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
vi.mock('fs', () => ({
  existsSync: () => true,
  readFileSync: () => JSON.stringify([{ id: 'cluster-a', name: 'Production', k8sUrl: 'https://k8s.example.test' }]),
}))
vi.mock('@/lib/rbac', () => ({
  assertSession: async () => mocks.deny,
  getSessionUserId: async () => 'test-user',
}))
vi.mock('@/app/api/settings/config/shared', () => ({ appendAuditLog: mocks.appendAuditLog }))

import { POST } from '@/app/api/k8s/cli/route'

function request(body: unknown) {
  return new Request('http://localhost/api/k8s/cli', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.deny = null
  vi.stubGlobal('fetch', mocks.fetch)
})

describe('Kubernetes CLI runner', () => {
  it('runs an allowlisted namespaced query against the registered cluster and audits it', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ items: [
      { metadata: { namespace: 'prod', name: 'api-1' }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] }, spec: { containers: [{}], nodeName: 'node-1' } },
    ] })))

    const response = await POST(request({ clusterId: 'cluster-a', commandId: 'pods', namespace: 'prod' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.fetch).toHaveBeenCalledWith('https://k8s.example.test/api/v1/namespaces/prod/pods?limit=100', expect.any(Object))
    expect(body.output).toContain('api-1')
    expect(mocks.appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'kubernetes.cli.read', user: 'test-user' }))
  })

  it('rejects arbitrary shell commands without contacting Kubernetes', async () => {
    const response = await POST(request({ clusterId: 'cluster-a', commandId: 'get pods; delete namespace prod' }))
    expect(response.status).toBe(400)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests', async () => {
    mocks.deny = Response.json({ error: 'Unauthorized' }, { status: 401 })
    const response = await POST(request({ clusterId: 'cluster-a', commandId: 'nodes' }))
    expect(response.status).toBe(401)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
