import { NextResponse } from 'next/server'
import { appendAuditLog } from '@/app/api/settings/config/shared'
import { assertSuperAdmin, getSessionUserId } from '@/lib/rbac'
import { isReleaseRequestSameOrigin, releaseIdentitySchema } from '@/lib/release-request'
import { readStatus, startJob } from '@/lib/update-job.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function enabled() {
  return process.env.VYNK8S_UPDATES_ENABLED === 'true' &&
    (process.platform !== 'win32' || process.env.VYNK8S_UPDATES_WINDOWS_ACL_CONFIRMED === 'true') &&
    process.env.NODE_ENV === 'production' &&
    process.env.VYNK8S_BUILD_SOURCE === 'manifest' &&
    /^[a-f0-9]{40}$/i.test(process.env.VYNK8S_BUILD_COMMIT || '') &&
    /^\d+$/.test(process.env.pm_id || '')
}

export async function GET() {
  const deny = await assertSuperAdmin()
  if (deny) return deny
  try {
    return NextResponse.json({ enabled: enabled(), status: readStatus(process.cwd()) }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('[update-status]', error)
    return NextResponse.json({ error: 'Unable to read update status. Check the server log.' }, { status: 503 })
  }
}

export async function POST(request: Request) {
  const deny = await assertSuperAdmin()
  if (deny) return deny
  if (!isReleaseRequestSameOrigin(request)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 })
  if (!enabled()) return NextResponse.json({ error: 'Automatic installation is not enabled for this installation.' }, { status: 503 })
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  const input = releaseIdentitySchema.safeParse(body)
  if (!input.success) return NextResponse.json({ error: 'Invalid release identity.' }, { status: 400 })
  const user = await getSessionUserId()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const appId = Number(process.env.pm_id)
  const port = Number(process.env.PORT || '4030')
  if (!Number.isSafeInteger(appId) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return NextResponse.json({ error: 'Invalid application process configuration.' }, { status: 503 })
  }
  try {
    appendAuditLog({ ts: new Date().toISOString(), user, action: 'update-approved', detail: input.data.tag })
    const status = startJob(process.cwd(), {
      ...input.data, baseCommit: process.env.VYNK8S_BUILD_COMMIT, appId, pid: process.pid, port,
    })
    return NextResponse.json({ status }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[update-start]', error)
    return NextResponse.json({ error: 'Unable to confirm update startup. Check update status and the server log before trying again.' }, { status: 409 })
  }
}
