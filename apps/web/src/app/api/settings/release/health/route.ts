import { timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextResponse } from 'next/server'
import { stateDirectory } from '@/lib/update-job.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  const token = request.headers.get('x-vynk8s-update-token')
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return new Response(null, { status: 404 })
  try {
    const state = stateDirectory(process.cwd(), false)
    if (!state) return new Response(null, { status: 404 })
    const file = join(state, 'active', 'job.json')
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return new Response(null, { status: 404 })
    const job = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof job.healthToken !== 'string' || !/^[a-f0-9]{64}$/.test(job.healthToken) ||
        !timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(job.healthToken, 'hex'))) {
      return new Response(null, { status: 404 })
    }
    return NextResponse.json({ pid: process.pid, commit: process.env.VYNK8S_BUILD_COMMIT }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[update-health]', error)
    return new Response(null, { status: 404 })
  }
}
