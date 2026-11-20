import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '../../app/api/settings/release/health/route'

let scratch: string
const token = 'a'.repeat(64)
const commit = 'b'.repeat(40)

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vynops-health-test-'))
  const active = join(scratch, 'data', '.vynops-updater', 'active')
  mkdirSync(active, { recursive: true, mode: 0o700 })
  writeFileSync(join(active, 'job.json'), JSON.stringify({ healthToken: token }))
  vi.spyOn(process, 'cwd').mockReturnValue(scratch)
  vi.stubEnv('VYNOPS_BUILD_COMMIT', commit)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

describe('update health identity', () => {
  it('only returns the running process identity to the update worker', async () => {
    const request = (value: string) => new Request('http://localhost/api/settings/release/health', { headers: { 'x-vynops-update-token': value } })
    expect(GET(request('c'.repeat(64))).status).toBe(404)
    const response = GET(request(token))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ pid: process.pid, commit })
  })
})
