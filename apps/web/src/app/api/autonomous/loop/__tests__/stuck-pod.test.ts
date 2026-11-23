import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sandbox = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vynops-stuck-pod-'))
  fs.mkdirSync(path.join(root, 'data'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  return root
})
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
const auditLog = vi.hoisted(() => vi.fn())

vi.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } }) } }))
vi.mock('@/lib/rbac', () => ({ assertOperator: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/cluster', () => ({ resolveK8sUrl: async () => 'http://k8s.test', K8S_TIMEOUT_MS: 1000 }))
vi.mock('@/lib/internal', () => ({
  hasInternalSecret: () => true,
  internalFetch: async (path: string) => {
    if (path === '/api/ai/insights') return new Response(JSON.stringify({ insights: [] }))
    return new Response(JSON.stringify({ ok: true, skipped: true }))
  },
}))
vi.mock('@/app/api/settings/config/shared', () => ({ readConfig: () => config.current, appendAuditLog: (...args: unknown[]) => auditLog(...args) }))

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { POST } from '../route'

const LOG_FILE = join(sandbox, 'data', 'autonomous.log.jsonl')
const request = () => new Request('http://localhost/api/autonomous/loop', { method: 'POST' })

function pod(namePrefix: string, overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      name: `${namePrefix}-pod`, namespace: 'default', uid: `${namePrefix}-uid`,
      deletionTimestamp: new Date(Date.now() - 20 * 60_000).toISOString(),
      deletionGracePeriodSeconds: 30,
      ...overrides,
    },
    spec: {},
  }
}

beforeEach(() => {
  rmSync(LOG_FILE, { force: true })
  config.current = {
    autonomous_enabled: true,
    autonomous_dry_run: false,
    autonomous_allowed_actions: ['delete_pod'],
  }
  auditLog.mockClear()
})

afterEach(() => vi.unstubAllGlobals())

function stubFetch(onDelete: (namespace: string, name: string) => Response, pods: unknown[]) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/v1/pods') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ items: pods }))
    }
    const match = url.match(/\/namespaces\/([^/]+)\/pods\/([^/?]+)/)
    if (match && init?.method === 'DELETE') return onDelete(match[1], decodeURIComponent(match[2]))
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('stuck-Terminating pod cleanup', () => {
  it('force-deletes a pod stuck well past its grace period, with gracePeriodSeconds=0', async () => {
    const del = vi.fn(() => new Response(null, { status: 200 }))
    const fetchMock = stubFetch(del, [pod('stuck')])
    const res = await POST(request())
    const body = await res.json()
    expect(body.actions).toHaveLength(1)
    expect(body.actions[0]).toMatchObject({ action: 'delete_stuck_pod', result: 'ok' })
    const deleteCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'DELETE')
    expect(String(deleteCall?.[0])).toContain('gracePeriodSeconds=0')
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'autonomous.delete_stuck_pod' }))
  })

  it('ignores a pod that is Terminating but not yet past the stuck threshold', async () => {
    const del = vi.fn(() => new Response(null, { status: 200 }))
    stubFetch(del, [pod('fresh', { deletionTimestamp: new Date(Date.now() - 60_000).toISOString() })])
    const res = await POST(request())
    const body = await res.json()
    expect(body.actions).toHaveLength(0)
    expect(del).not.toHaveBeenCalled()
  })

  it('does not act when "Delete Pod" is not an allowed action', async () => {
    config.current.autonomous_allowed_actions = ['restart_deployment']
    const del = vi.fn(() => new Response(null, { status: 200 }))
    stubFetch(del, [pod('stuck')])
    const res = await POST(request())
    const body = await res.json()
    expect(body.actions).toHaveLength(0)
    expect(del).not.toHaveBeenCalled()
  })

  it('logs only (no deletion) in dry-run mode', async () => {
    config.current.autonomous_dry_run = true
    const del = vi.fn(() => new Response(null, { status: 200 }))
    stubFetch(del, [pod('stuck')])
    const res = await POST(request())
    const body = await res.json()
    expect(body.actions).toMatchObject([{ action: 'delete_stuck_pod', result: 'dry_run', dryRun: true }])
    expect(del).not.toHaveBeenCalled()
  })

  it('respects the per-pod cooldown and does not retry the same pod within 1 hour', async () => {
    const recent = { id: 'prev', ts: new Date(Date.now() - 10 * 60_000).toISOString(), result: 'ok', action: 'delete_stuck_pod', target: 'default/stuck-pod:stuck-uid', namespace: 'default', confidence: 100, dryRun: false }
    writeFileSync(LOG_FILE, JSON.stringify(recent) + '\n')
    const del = vi.fn(() => new Response(null, { status: 200 }))
    stubFetch(del, [pod('stuck')])
    const res = await POST(request())
    const body = await res.json()
    expect(body.actions).toHaveLength(0)
    expect(del).not.toHaveBeenCalled()
  })

  it('stops after the daily cap and flags remaining pods for manual review instead of deleting them', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({
      id: `prev-${i}`, ts: new Date(Date.now() - 5 * 60_000).toISOString(), result: 'ok',
      action: 'delete_stuck_pod', target: `default/old-${i}:uid-${i}`, namespace: 'default', confidence: 100, dryRun: false,
    }))
    writeFileSync(LOG_FILE, lines.join('\n') + '\n')
    const del = vi.fn(() => new Response(null, { status: 200 }))
    stubFetch(del, [pod('newstuck')])
    const res = await POST(request())
    const body = await res.json()
    expect(body.actions).toMatchObject([{ action: 'delete_stuck_pod', result: 'skipped_cooldown' }])
    expect(del).not.toHaveBeenCalled()
  })

  it('treats a 404 on delete as success (pod already cleared on its own)', async () => {
    const del = vi.fn(() => new Response(null, { status: 404 }))
    stubFetch(del, [pod('racey')])
    const res = await POST(request())
    const body = await res.json()
    expect(body.actions).toMatchObject([{ action: 'delete_stuck_pod', result: 'ok' }])
  })
})
