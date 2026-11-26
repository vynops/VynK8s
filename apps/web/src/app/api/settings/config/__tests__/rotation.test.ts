import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vynk8s-rotate-'))
afterAll(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

describe('log rotation', () => {
  it('moves an oversized log aside and keeps appending to a fresh file', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    vi.resetModules()
    const { appendAuditLog, appendNotifLog } = await import('../shared')
    const audit = path.join(root, 'audit.log.jsonl')
    fs.writeFileSync(audit, 'x'.repeat(5 * 1024 * 1024 + 1))
    appendAuditLog({ ts: 't', user: 'u', action: 'a' })
    expect(fs.statSync(`${audit}.1`).size).toBeGreaterThan(5 * 1024 * 1024)
    expect(fs.readFileSync(audit, 'utf8')).toBe('{"ts":"t","user":"u","action":"a"}\n')

    appendNotifLog({ ts: 't', event: 'e', channels: [], summary: 's', ok: true })
    expect(fs.existsSync(path.join(root, 'notifications.log.jsonl.1'))).toBe(false)
  })
})
