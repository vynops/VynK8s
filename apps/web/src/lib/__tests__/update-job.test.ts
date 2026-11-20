import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readStatus, startJob, stateDirectory, writeStatus } from '../update-job.js'

let scratch: string
let web: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'vynops-job-test-'))
  web = join(scratch, 'web')
  mkdirSync(join(web, 'data'), { recursive: true })
  const bin = process.platform === 'win32' ? join(scratch, 'node_modules', 'pm2', 'bin') : scratch
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'pm2'), '#!/usr/bin/env node\n')
  vi.stubEnv('PATH', scratch)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

describe('update job state', () => {
  it('creates one durable job and rejects concurrent starts', () => {
    const invoke = vi.fn()
    const job = { tag: 'v2.1.0', commit: 'b'.repeat(40), baseCommit: 'a'.repeat(40), appId: 0, pid: 123, port: 3030 }
    const status = startJob(web, job, invoke)
    expect(readStatus(web)).toMatchObject({ ...status, phase: 'queued' })
    expect(invoke).toHaveBeenCalledOnce()
    const state = stateDirectory(web, false)
    if (!state) throw new Error('Update state was not created')
    expect(JSON.parse(readFileSync(join(state, 'active', 'job.json'), 'utf8'))).toMatchObject({ ...job, id: status.id })
    expect(() => startJob(web, job, invoke)).toThrow('already active')
    expect(invoke).toHaveBeenCalledOnce()
    writeStatus(state, { ...status, phase: 'building' })
    expect(readStatus(web)).toMatchObject({ id: status.id, phase: 'building' })
  })

  it('keeps the lock when worker startup cannot be confirmed', () => {
    const job = { tag: 'v2.1.0', commit: 'b'.repeat(40) }
    expect(() => startJob(web, job, () => { throw new Error('timeout') })).toThrow('could not be confirmed')
    expect(readStatus(web).phase).toBe('queued')
    expect(() => startJob(web, job, vi.fn())).toThrow('already active')
  })

  it('does not replay an interrupted worker', () => {
    const job = { tag: 'v2.1.0', commit: 'b'.repeat(40), baseCommit: 'a'.repeat(40), appId: 0, pid: 123, port: 3030 }
    const status = startJob(web, job, vi.fn())
    const state = stateDirectory(web, false)
    if (!state) throw new Error('Update state was not created')
    writeStatus(state, { ...status, phase: 'building' })
    const worker = join(process.cwd(), 'scripts', 'update-worker.js')
    const result = spawnSync(process.execPath, [worker, status.id], { cwd: web, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(readStatus(web).phase).toBe('manual-recovery-required')
    expect(() => startJob(web, job, vi.fn())).toThrow('already active')
  })
})
