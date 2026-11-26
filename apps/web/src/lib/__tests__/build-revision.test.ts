import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import loadConfig from 'next/dist/server/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRevision } from '../build-revision.js'

const commit = 'a'.repeat(40)
const date = '2026-11-19T10:20:30+05:30'
let directory: string
let originalPath: string | undefined

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vynk8s-version-test-'))
  originalPath = process.env.PATH
  process.env.PATH = ''
})

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('release version metadata without Git', () => {
  it('uses the packaged commit and date without claiming local files are clean', () => {
    writeFileSync(join(directory, 'release-version.json'), JSON.stringify({ commit, date }))
    expect(buildRevision(directory)).toEqual({ commit, date, dirty: '', source: 'manifest' })
  })

  it('loads the packaged metadata through the actual Next.js build configuration', async () => {
    mkdirSync(join(directory, 'src', 'lib'), { recursive: true })
    copyFileSync(join(process.cwd(), 'next.config.ts'), join(directory, 'next.config.ts'))
    copyFileSync(join(process.cwd(), 'src', 'lib', 'build-revision.js'), join(directory, 'src', 'lib', 'build-revision.js'))
    writeFileSync(join(directory, 'release-version.json'), JSON.stringify({ commit, date }))
    const config = await loadConfig('phase-production-build', directory)
    expect(config.env).toMatchObject({
      VYNK8S_BUILD_COMMIT: commit,
      VYNK8S_BUILD_COMMIT_DATE: date,
      VYNK8S_BUILD_DIRTY: '',
      VYNK8S_BUILD_SOURCE: 'manifest',
    })
  })

  it('does not invent a version when the manifest and Git are unavailable', () => {
    expect(buildRevision(directory)).toEqual({ commit: '', date: '', dirty: '', source: '' })
  })

  it.each([
    '{',
    JSON.stringify({ commit: 'invalid', date }),
    JSON.stringify({ commit, date: 'not-a-date' }),
  ])('rejects invalid metadata', content => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(join(directory, 'release-version.json'), content)
    expect(buildRevision(directory)).toEqual({ commit: '', date: '', dirty: '', source: '' })
    expect(console.error).toHaveBeenCalled()
  })
})
