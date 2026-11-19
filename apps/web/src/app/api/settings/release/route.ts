import { NextResponse } from 'next/server'
import { assertSession } from '@/lib/rbac'
import { checkRelease } from '@/lib/release-check'

export async function GET() {
  const deny = await assertSession()
  if (deny) return deny

  const installed = {
    commit: process.env.VYNOPS_BUILD_COMMIT || null,
    date: process.env.VYNOPS_BUILD_COMMIT_DATE || null,
    dirty: process.env.VYNOPS_BUILD_DIRTY === 'true' ? true : process.env.VYNOPS_BUILD_DIRTY === 'false' ? false : null,
    source: process.env.VYNOPS_BUILD_SOURCE || null,
  }
  try {
    return NextResponse.json({ installed, update: await checkRelease(installed.commit) })
  } catch (error) {
    console.error('[release-check]', error)
    return NextResponse.json({
      installed,
      update: { status: 'unavailable', message: 'Unable to check GitHub for a release.' },
    })
  }
}
