import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NextResponse } from 'next/server'
import { assertSuperAdmin } from '@/lib/rbac'
import { prepareUpdate } from '@/lib/update-files.js'
import { loadLatestRelease } from '@/lib/update-source.js'
import { isReleaseRequestSameOrigin, releaseIdentitySchema } from '@/lib/release-request'

export async function POST(request: Request) {
  const deny = await assertSuperAdmin()
  if (deny) return deny

  if (!isReleaseRequestSameOrigin(request)) {
    return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  const input = releaseIdentitySchema.safeParse(body)
  if (!input.success) return NextResponse.json({ error: 'Invalid release identity.' }, { status: 400 })
  if (process.env.VYNK8S_BUILD_SOURCE !== 'manifest' || !process.env.VYNK8S_BUILD_COMMIT) {
    return NextResponse.json({ error: 'Verified release metadata is required before checking installation.' }, { status: 409 })
  }

  try {
    const web = process.cwd()
    const metadata = join(web, 'release-version.json')
    const stat = lstatSync(metadata)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) {
      throw new Error('Installed release metadata is invalid')
    }
    const base = JSON.parse(readFileSync(metadata, 'utf8'))
    if (base.commit !== process.env.VYNK8S_BUILD_COMMIT) {
      throw new Error('Installed release metadata does not match the running build')
    }
    const release = await loadLatestRelease(base.commit, input.data.tag, input.data.commit)
    const plan = await prepareUpdate(resolve(web, '..', '..'), base, release.manifest, release.body, release.download)
    return NextResponse.json({
      tag: input.data.tag,
      commit: input.data.commit,
      files: plan.changes.map((change: { name: string; before: object | null; after: object | null }) => ({
        name: change.name,
        action: !change.before ? 'add' : !change.after ? 'remove' : 'replace',
      })),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[release-preview]', error)
    return NextResponse.json({
      error: 'Update verification failed. No files were changed; check the server log for details.',
    }, { status: 409 })
  }
}
