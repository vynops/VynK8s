import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ failedUrl: '', promStatus: 'success', responses: {} as Record<string, unknown>, requestedUrls: [] as string[] }))

vi.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
}))
vi.mock('@/lib/cluster', () => ({
  resolveK8sUrl: async () => 'http://k8s.test',
  resolvePromUrl: async () => 'http://prom.test',
  resolveClusterMeta: async () => ({ name: 'test', provider: 'test', region: 'test' }),
  K8S_TIMEOUT_MS: 1000,
}))
vi.mock('@/app/api/settings/config/shared', () => ({ readConfig: () => ({}) }))

import { GET } from './route'

beforeEach(() => {
  state.failedUrl = ''
  state.promStatus = 'success'
  state.responses = {}
  state.requestedUrls = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    state.requestedUrls.push(url)
    if (url === state.failedUrl) return new Response('unavailable', { status: 503 })
    const parsedUrl = new URL(url)
    if (parsedUrl.pathname === '/api/v1/query') {
      const query = parsedUrl.searchParams.get('query') ?? ''
      return new Response(JSON.stringify({ status: state.promStatus, data: { result: state.responses[query] ?? [] } }))
    }
    const path = parsedUrl.pathname + parsedUrl.search
    if (path === '/version') return new Response(JSON.stringify(state.responses[path] ?? { gitVersion: 'v1.test' }))
    return new Response(JSON.stringify(state.responses[path] ?? { items: [] }))
  }))
})

describe('GET /api/cloud/overview data availability', () => {
  it('does not turn a failed Kubernetes source into a zero-cost response', async () => {
    state.failedUrl = 'http://k8s.test/api/v1/nodes'

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.sourceStatus).toBe('unavailable')
    expect(body.error).toContain('/api/v1/nodes returned HTTP 503')
    expect(body.cost).toBeUndefined()
  })

  it('does not turn a failed Prometheus query into zero usage', async () => {
    state.failedUrl = 'http://prom.test/api/v1/query?query=kube_node_status_allocatable%7Bresource%3D%22cpu%22%7D'

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.sourceStatus).toBe('unavailable')
    expect(body.error).toContain('Prometheus query returned HTTP 503')
    expect(body.cost).toBeUndefined()
  })

  it('rejects Prometheus error payloads even when HTTP status is 200', async () => {
    state.promStatus = 'error'

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body.sourceStatus).toBe('unavailable')
    expect(body.error).toContain('invalid query response')
  })

  it('includes init-container requests, charges only Bound PVCs, and keeps missing usage unknown', async () => {
    state.responses['/api/v1/namespaces'] = { items: [{ metadata: { name: 'apps' } }] }
    state.responses['/api/v1/pods?limit=1000'] = { items: [{
      metadata: { name: 'web-0', namespace: 'apps', ownerReferences: [{ kind: 'StatefulSet', name: 'web' }] },
      spec: {
        containers: [{ name: 'web', resources: { requests: { cpu: '500m', memory: '256Mi' } } }],
        initContainers: [{ name: 'init', resources: { requests: { cpu: '1', memory: '1Gi' } } }],
        overhead: { cpu: '100m', memory: '128Mi' },
      },
      status: { phase: 'Running' },
    }] }
    state.responses['/api/v1/persistentvolumeclaims?limit=500'] = { items: [
      { metadata: { name: 'bound', namespace: 'apps' }, spec: { resources: { requests: { storage: '10Gi' } } }, status: { phase: 'Bound', capacity: { storage: '10Gi' } } },
      { metadata: { name: 'pending', namespace: 'apps' }, spec: { resources: { requests: { storage: '20Gi' } } }, status: { phase: 'Pending' } },
    ] }
    state.responses['kubelet_volume_stats_used_bytes'] = [{ metric: { namespace: 'apps', persistentvolumeclaim: 'bound' }, value: [0, String(5 * 1024 ** 3)] }]
    state.responses['kubelet_volume_stats_capacity_bytes'] = [{ metric: { namespace: 'apps', persistentvolumeclaim: 'bound' }, value: [0, String(8 * 1024 ** 3)] }]

    const response = await GET()
    const body = await response.json()
    const bound = body.storage.pvcs.find((pvc: any) => pvc.name === 'bound')
    const pending = body.storage.pvcs.find((pvc: any) => pvc.name === 'pending')

    expect(response.status).toBe(200)
    expect(body.cost.byWorkload[0]).toMatchObject({ cpuCores: 1.1, memGiB: 1.13 })
    expect(body.storage).toMatchObject({ totalPVCs: 2, totalCapacityGiB: 10, totalUsedGiB: 5, costPerMo: 0.5, usageComplete: true })
    expect(bound).toMatchObject({ status: 'Bound', capacityGiB: 10, costPerMo: 0.5, usedGiB: 5, usagePct: 63 })
    expect(pending).toMatchObject({ status: 'Pending', costPerMo: 0, usedGiB: null, usagePct: null })
    expect(body.cost.usageComplete).toBe(false)
    expect(body.cost.wastedPerMo).toBeNull()
  })

  it('follows Kubernetes continuation tokens instead of silently truncating lists', async () => {
    state.responses['/api/v1/namespaces'] = {
      items: [{ metadata: { name: 'first' } }],
      metadata: { continue: 'next-page' },
    }
    state.responses['/api/v1/namespaces?continue=next-page'] = {
      items: [{ metadata: { name: 'second' } }],
      metadata: {},
    }

    const body = await (await GET()).json()

    expect(body.cluster.namespaceCount).toBe(2)
    expect(state.requestedUrls).toContain('http://k8s.test/api/v1/namespaces?continue=next-page')
  })

  it('weights cluster efficiency by total resource requests instead of averaging namespaces equally', async () => {
    state.responses['/api/v1/namespaces'] = { items: [
      { metadata: { name: 'tiny' } },
      { metadata: { name: 'large' } },
    ] }
    state.responses['/api/v1/pods?limit=1000'] = { items: [
      { metadata: { name: 'tiny', namespace: 'tiny' }, spec: { containers: [{ resources: { requests: { cpu: '1' } } }] }, status: { phase: 'Running' } },
      { metadata: { name: 'large', namespace: 'large' }, spec: { containers: [{ resources: { requests: { cpu: '9' } } }] }, status: { phase: 'Running' } },
    ] }
    state.responses['sum by(namespace) (rate(container_cpu_usage_seconds_total{namespace!="",container!="POD",container!=""}[5m]) or rate(container_cpu_usage_seconds_total{namespace!="",container!="POD",image!=""}[5m]))'] = [
      { metric: { namespace: 'tiny' }, value: [0, '1'] },
      { metric: { namespace: 'large' }, value: [0, '0'] },
    ]

    const body = await (await GET()).json()

    expect(body.cost.byNamespace.map((namespace: any) => namespace.overallEfficiency).sort()).toEqual([0, 100])
    expect(body.cost.cpuEfficiency).toBe(10)
    expect(body.cost.resourceEfficiency).toBe(10)
  })

  it('uses image-labeled legacy container metrics when the container label is absent', async () => {
    state.responses['/api/v1/namespaces'] = { items: [{ metadata: { name: 'apps' } }] }
    state.responses['/api/v1/pods?limit=1000'] = { items: [{
      metadata: { name: 'api-0', namespace: 'apps' },
      spec: { containers: [{ name: 'api', resources: { requests: { cpu: '1', memory: '1Gi' } } }] },
      status: { phase: 'Running' },
    }] }
    state.responses['sum by(namespace) (rate(container_cpu_usage_seconds_total{namespace!="",container!="POD",container!=""}[5m]) or rate(container_cpu_usage_seconds_total{namespace!="",container!="POD",image!=""}[5m]))'] = [
      { metric: { namespace: 'apps' }, value: [0, '0.5'] },
    ]
    state.responses['sum by(namespace) (container_memory_working_set_bytes{namespace!="",container!="POD",container!=""} or container_memory_working_set_bytes{namespace!="",container!="POD",image!=""})'] = [
      { metric: { namespace: 'apps' }, value: [0, String(256 * 1024 ** 2)] },
    ]

    const body = await (await GET()).json()

    expect(body.cost.usageComplete).toBe(true)
    expect(body.cost.byNamespace[0]).toMatchObject({ cpuActualCores: 0.5, memActualGiB: 0.25 })
    expect(body.cost.wastedPerMo).not.toBeNull()
  })

  it('calculates node memory utilization against allocatable capacity', async () => {
    state.responses['/api/v1/nodes'] = { items: [{
      metadata: { name: 'node-a', labels: { 'node.kubernetes.io/instance-type': 'vm.test' } },
      status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }], conditions: [{ type: 'Ready', status: 'True' }] },
    }] }
    state.responses['kube_node_status_allocatable{resource="cpu"}'] = [{ metric: { node: 'node-a' }, value: [0, '4'] }]
    state.responses['kube_node_status_allocatable{resource="memory"}'] = [{ metric: { node: 'node-a' }, value: [0, String(14 * 1024 ** 3)] }]
    state.responses['kube_node_status_condition{condition="Ready",status="true"}'] = [{ metric: { node: 'node-a' }, value: [0, '1'] }]
    state.responses['node_memory_MemAvailable_bytes'] = [{ metric: { instance: '10.0.0.1:9100' }, value: [0, String(8 * 1024 ** 3)] }]
    state.responses['node_memory_MemTotal_bytes'] = [{ metric: { instance: '10.0.0.1:9100' }, value: [0, String(16 * 1024 ** 3)] }]
    state.responses['1 - avg by(node, instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))'] = [{ metric: { instance: '10.0.0.1:9100' }, value: [0, '0.5'] }]
    state.responses['count by(node) (kube_pod_info{node!=""})'] = [{ metric: { node: 'node-a' }, value: [0, '10'] }]
    state.responses['kube_node_status_allocatable{resource="pods"}'] = [{ metric: { node: 'node-a' }, value: [0, '100'] }]

    const response = await GET()
    const body = await response.json()

    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.nodes[0]).toMatchObject({ cpuUsagePct: 50, memUsagePct: 57.1 })

    state.responses['1 - avg by(node, instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))'] = []
    const partialResponse = await GET()
    const partialBody = await partialResponse.json()
    expect(partialResponse.status).toBe(200)
    expect(partialBody.nodes[0].cpuUsagePct).toBeNull()
    expect(partialBody.dataQuality.nodeUsageComplete).toBe(false)
    expect(partialBody.cost).toBeDefined()
  })
})