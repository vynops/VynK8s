import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRevision } from '../build-revision.js'

const scratch = mkdtempSync(join(tmpdir(), 'vynops-package-test-'))
const repo = join(scratch, 'repo')
const unpacked = join(scratch, 'unpacked')
const archive = join(scratch, 'release.tar.gz')
const script = resolve('scripts', 'package-release.mjs')

afterEach(() => rmSync(scratch, { recursive: true, force: true }))

describe('release packaging', () => {
  it('packages only committed source with Git-free version metadata', () => {
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
    mkdirSync(unpacked)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git('init')
    writeFileSync(join(repo, 'apps', 'web', 'app.txt'), 'committed')
    git('add', 'apps')
    git('-c', 'user.name=Release Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'test')
    const commit = git('rev-parse', 'HEAD')
    writeFileSync(join(repo, 'apps', 'web', 'app.txt'), 'local modification')
    writeFileSync(join(repo, 'apps', 'web', 'private.txt'), 'untracked')

    const manifestFile = join(scratch, 'manifest.json')
    execFileSync(process.execPath, [script, repo, archive, manifestFile], {
      stdio: 'pipe', env: { ...process.env, VYNOPS_RELEASE_BODY: '' },
    })
    execFileSync('tar', ['-xf', archive, '-C', unpacked])

    expect(readFileSync(join(unpacked, 'apps', 'web', 'app.txt'), 'utf8')).toBe('committed')
    expect(() => readFileSync(join(unpacked, 'apps', 'web', 'private.txt'))).toThrow()
    const revision = buildRevision(join(unpacked, 'apps', 'web'))
    expect(revision.commit).toBe(commit)
    expect(revision.source).toBe('manifest')
    expect(revision.dirty).toBe('')
    const manifest = JSON.parse(readFileSync(join(unpacked, 'apps', 'web', 'release-version.json'), 'utf8'))
    expect(manifest.dataCompatible).toBe(false)
    expect(manifest.files['apps/web/app.txt'].sha256).toBe(createHash('sha256').update('committed').digest('hex'))
    expect(JSON.parse(readFileSync(manifestFile, 'utf8'))).toEqual(manifest)

    const approvedArchive = join(scratch, 'approved.tar.gz')
    const approvedSource = join(scratch, 'approved')
    mkdirSync(approvedSource)
    execFileSync(process.execPath, [script, repo, approvedArchive, join(scratch, 'approved-manifest.json')], {
      stdio: 'pipe', env: { ...process.env, VYNOPS_RELEASE_BODY: 'Notes\r\nVYNOPS_DATA_COMPATIBLE: true\r\n' },
    })
    execFileSync('tar', ['-xf', approvedArchive, '-C', approvedSource])
    const approved = JSON.parse(readFileSync(join(approvedSource, 'apps', 'web', 'release-version.json'), 'utf8'))
    expect(approved.dataCompatible).toBe(true)
  }, 30000)
})
