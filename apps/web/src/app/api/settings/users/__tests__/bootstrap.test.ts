import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { afterEach, describe, expect, it } from 'vitest'

const localScript = join(process.cwd(), 'scripts', 'bootstrap-admin.mjs')
const script = existsSync(localScript) ? localScript : join(process.cwd(), 'apps', 'web', 'scripts', 'bootstrap-admin.mjs')
const localDesignationScript = join(process.cwd(), 'scripts', 'designate-super-admin.mjs')
const designationScript = existsSync(localDesignationScript)
  ? localDesignationScript
  : join(process.cwd(), 'apps', 'web', 'scripts', 'designate-super-admin.mjs')
const localSetupScript = join(process.cwd(), 'scripts', 'setup-env.mjs')
const setupScript = existsSync(localSetupScript) ? localSetupScript : join(process.cwd(), 'apps', 'web', 'scripts', 'setup-env.mjs')
const sandboxes: string[] = []

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'vynk8s-admin-bootstrap-'))
  const dataDir = join(root, 'data')
  const envFile = join(root, '.env.local')
  mkdirSync(dataDir)
  sandboxes.push(root)
  return { root, dataDir, envFile }
}

function runBootstrap(envFile: string, dataDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', VYNK8S_BOOTSTRAP_ENV_FILE: envFile, VYNK8S_BOOTSTRAP_DATA_DIR: dataDir }
  delete env.INITIAL_ADMIN_EMAIL
  delete env.INITIAL_ADMIN_PASSWORD
  delete env.INITIAL_ADMIN_NAME
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env })
}

function runDesignation(email: string, dataDir: string, auditPath: string) {
  const env = { ...process.env, VYNK8S_SUPER_ADMIN_DATA_DIR: dataDir, VYNK8S_SUPER_ADMIN_AUDIT_PATH: auditPath }
  return spawnSync(process.execPath, [designationScript, email], { encoding: 'utf8', env })
}

function runSetup(webDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, VYNK8S_SETUP_WEB_DIR: webDir }
  delete env.INITIAL_ADMIN_EMAIL
  delete env.INITIAL_ADMIN_PASSWORD
  delete env.INITIAL_ADMIN_NAME
  return spawnSync(process.execPath, [setupScript], { encoding: 'utf8', env })
}

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('first-admin bootstrap', () => {
  it('creates a persistent admin with a password hash and removes one-time secrets', async () => {
    const { dataDir, envFile } = createSandbox()
    const password = `${randomUUID()}-Admin!`
    writeFileSync(envFile, `INITIAL_ADMIN_NAME=First Admin\nINITIAL_ADMIN_EMAIL=First.Admin@Example.com\nINITIAL_ADMIN_PASSWORD="${password}"\nAUTH_SECRET=test-secret\n`)

    const result = runBootstrap(envFile, dataDir)

    expect(result.status, result.stderr).toBe(0)
    const users = JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8'))
    const passwords = JSON.parse(readFileSync(join(dataDir, 'passwords.json'), 'utf8'))
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ email: 'first.admin@example.com', role: 'admin', name: 'First Admin', isSuperAdmin: true, status: 'active', mustChangePassword: true })
    expect(await bcrypt.compare(password, passwords[users[0].id])).toBe(true)
    expect(existsSync(join(dataDir, 'initial-admin-credentials.txt'))).toBe(false)
    expect(readFileSync(envFile, 'utf8')).not.toMatch(/INITIAL_ADMIN_(EMAIL|PASSWORD|NAME)=/)

    if (process.platform !== 'win32') {
      expect(statSync(dataDir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dataDir, 'users.json')).mode & 0o777).toBe(0o600)
      expect(statSync(join(dataDir, 'passwords.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('refuses to overwrite an existing user store', () => {
    const { dataDir, envFile } = createSandbox()
    const existing = JSON.stringify([{ id: 'existing-admin' }])
    writeFileSync(join(dataDir, 'users.json'), existing)
    writeFileSync(envFile, `INITIAL_ADMIN_EMAIL=another@example.com\nINITIAL_ADMIN_PASSWORD=${randomUUID()}-Admin!\n`)

    const result = runBootstrap(envFile, dataDir)

    expect(result.status).not.toBe(0)
    expect(readFileSync(join(dataDir, 'users.json'), 'utf8')).toBe(existing)
    expect(existsSync(join(dataDir, 'passwords.json'))).toBe(false)
  })

  it('uses the default admin email when only a password is configured', () => {
    const { dataDir, envFile } = createSandbox()
    const password = `${randomUUID()}-Admin!`
    writeFileSync(envFile, `INITIAL_ADMIN_PASSWORD=${password}\n`)

    const result = runBootstrap(envFile, dataDir)

    expect(result.status, result.stderr).toBe(0)
    const users = JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8'))
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ email: 'admin@vynk8s.local', role: 'admin', name: 'Platform Administrator' })
  })

  it('uses changeme as the default password and forces a change at first login', async () => {
    const { dataDir, envFile } = createSandbox()
    writeFileSync(envFile, '')

    const result = runBootstrap(envFile, dataDir)

    expect(result.status, result.stderr).toBe(0)
    const users = JSON.parse(readFileSync(join(dataDir, 'users.json'), 'utf8'))
    const passwords = JSON.parse(readFileSync(join(dataDir, 'passwords.json'), 'utf8'))
    expect(users[0]).toMatchObject({ isSuperAdmin: true, mustChangePassword: true })
    expect(await bcrypt.compare('changeme', passwords[users[0].id])).toBe(true)
    expect(existsSync(join(dataDir, 'initial-admin-credentials.txt'))).toBe(false)
  })
})

describe('existing super-admin designation', () => {
  it('resolves a Profile email to one existing active admin and stores its stable ID', () => {
    const { dataDir, root } = createSandbox()
    const usersFile = join(dataDir, 'users.json')
    const auditFile = join(root, 'audit.log.jsonl')
    writeFileSync(usersFile, JSON.stringify([
      { id: 'profile-admin-id', name: 'Owner', email: 'owner@example.test', role: 'admin', status: 'active' },
      { id: 'viewer-id', name: 'Viewer', email: 'viewer@example.test', role: 'viewer', status: 'active' },
    ]))

    const result = runDesignation('Owner@Example.Test', dataDir, auditFile)

    expect(result.status, result.stderr).toBe(0)
    const users = JSON.parse(readFileSync(usersFile, 'utf8'))
    expect(users.find((user: any) => user.id === 'profile-admin-id').isSuperAdmin).toBe(true)
    expect(users.find((user: any) => user.id === 'viewer-id').isSuperAdmin).toBe(false)
    expect(JSON.parse(readFileSync(auditFile, 'utf8'))).toMatchObject({ action: 'user.super_admin.designated' })
  })

  it('refuses to create or elevate a missing, non-admin, or already replaced account', () => {
    const { dataDir, root } = createSandbox()
    const usersFile = join(dataDir, 'users.json')
    const auditFile = join(root, 'audit.log.jsonl')
    const users = [
      { id: 'owner-id', email: 'owner@example.test', role: 'admin', status: 'active', isSuperAdmin: true },
      { id: 'viewer-id', email: 'viewer@example.test', role: 'viewer', status: 'active' },
    ]
    const original = JSON.stringify(users)
    writeFileSync(usersFile, original)

    const missing = runDesignation('missing@example.test', dataDir, auditFile)
    const viewer = runDesignation('viewer@example.test', dataDir, auditFile)

    expect(missing.status).not.toBe(0)
    expect(viewer.status).not.toBe(0)
    expect(readFileSync(usersFile, 'utf8')).toBe(original)
    expect(existsSync(auditFile)).toBe(false)
  })
})

describe('one-step first installation', () => {
  it('creates local env and a first super-admin with the forced-change default', async () => {
    const { root } = createSandbox()
    const webDir = join(root, 'web')
    mkdirSync(webDir)
    writeFileSync(join(webDir, '.env.local.example'), 'AUTH_SECRET=replace-me\nNEXTAUTH_URL=http://localhost:4030\nINITIAL_ADMIN_NAME=VynK8s Administrator\nINITIAL_ADMIN_EMAIL=admin@vynk8s.local\n')

    const result = runSetup(webDir)

    expect(result.status, result.stderr).toBe(0)
    const env = readFileSync(join(webDir, '.env.local'), 'utf8')
    const users = JSON.parse(readFileSync(join(webDir, 'data', 'users.json'), 'utf8'))
    const passwords = JSON.parse(readFileSync(join(webDir, 'data', 'passwords.json'), 'utf8'))
    expect(env).not.toContain('AUTH_SECRET=replace-me')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ email: 'admin@vynk8s.local', role: 'admin', isSuperAdmin: true, mustChangePassword: true })
    expect(await bcrypt.compare('changeme', passwords[users[0].id])).toBe(true)
    expect(existsSync(join(webDir, 'data', 'initial-admin-credentials.txt'))).toBe(false)

    const secondRun = runSetup(webDir)
    expect(secondRun.status, secondRun.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(webDir, 'data', 'users.json'), 'utf8'))).toHaveLength(1)
  })

  it('does not alter existing users or create a credential for an existing installation', () => {
    const { root } = createSandbox()
    const webDir = join(root, 'web')
    const dataDir = join(webDir, 'data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(webDir, '.env.local.example'), 'AUTH_SECRET=replace-me\nNEXTAUTH_URL=http://localhost:4030\n')
    const existing = JSON.stringify([{ id: 'existing-user', email: 'existing@example.test', role: 'admin' }])
    writeFileSync(join(dataDir, 'users.json'), existing)

    const result = runSetup(webDir)

    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(dataDir, 'users.json'), 'utf8')).toBe(existing)
    expect(existsSync(join(dataDir, 'initial-admin-credentials.txt'))).toBe(false)
  })
})