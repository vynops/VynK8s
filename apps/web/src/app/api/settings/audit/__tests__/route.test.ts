import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { assertAdminMock } = vi.hoisted(() => ({ assertAdminMock: vi.fn() }))
vi.mock('@/lib/rbac', () => ({ assertAdmin: assertAdminMock }))

let root = ''
let get: typeof import('../route').GET

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vynk8s-audit-'))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  assertAdminMock.mockReset().mockResolvedValue(null)
  vi.resetModules()
  ;({ GET: get } = await import('../route'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const entry = (ts: string, user: string, action: string) => JSON.stringify({ ts, user, action, fields: ['role'] })
const request = (query = '') => new Request(`http://localhost/api/settings/audit${query}`)

async function readJson(response: Response) {
  return response.json() as Promise<{ entries: Array<{ ts: string; user: string; action: string }>; total: number; page: number; pageSize: number }>
}

describe('GET /api/settings/audit', () => {
  it('requires the admin guard', async () => {
    assertAdminMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }))

    const response = await get(request())

    expect(response.status).toBe(403)
    expect(assertAdminMock).toHaveBeenCalledOnce()
  })

  it('reads rotated logs and returns entries newest first', async () => {
    const audit = path.join(root, 'audit.log.jsonl')
    fs.writeFileSync(`${audit}.2`, `${entry('2026-01-01T00:00:00.000Z', 'alice', 'user.create')}\n`)
    fs.writeFileSync(`${audit}.1`, `${entry('2026-01-03T00:00:00.000Z', 'bob', 'user.update')}\n`)
    fs.writeFileSync(audit, `${entry('2026-01-02T00:00:00.000Z', 'alice', 'incident.created')}\n`)

    const result = await readJson(await get(request()))

    expect(result.entries.map(item => item.ts)).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ])
    expect(result.total).toBe(3)
  })

  it('applies user and action filters to paginated results', async () => {
    const audit = path.join(root, 'audit.log.jsonl')
    fs.writeFileSync(audit, [
      entry('2026-01-01T00:00:00.000Z', 'alice', 'user.update'),
      entry('2026-01-02T00:00:00.000Z', 'alice', 'incident.created'),
      entry('2026-01-03T00:00:00.000Z', 'alice', 'user.update'),
      entry('2026-01-04T00:00:00.000Z', 'bob', 'user.update'),
    ].join('\n'))

    const result = await readJson(await get(request('?user=ALICE&action=USER.UPDATE&page=1&pageSize=1')))

    expect(result.total).toBe(2)
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(1)
    expect(result.entries.map(item => item.ts)).toEqual(['2026-01-01T00:00:00.000Z'])
  })

  it('exports all entries matching the supplied filters', async () => {
    const audit = path.join(root, 'audit.log.jsonl')
    fs.writeFileSync(audit, [
      entry('2026-01-01T00:00:00.000Z', 'alice', 'user.update'),
      entry('2026-01-02T00:00:00.000Z', 'alice', 'incident.created'),
      entry('2026-01-03T00:00:00.000Z', 'alice', 'user.update'),
      entry('2026-01-04T00:00:00.000Z', 'bob', 'user.update'),
    ].join('\n'))

    const result = await readJson(await get(request('?export=1&user=alice&action=user.update&pageSize=1')))

    expect(result.total).toBe(2)
    expect(result.entries).toHaveLength(2)
    expect(result.entries.every(item => item.user === 'alice' && item.action === 'user.update')).toBe(true)
  })
})
