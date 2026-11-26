import { z } from 'zod'
import { maintenanceReasons } from './update-policy.js'

const API = 'https://api.github.com/repos/vynops/VynK8s'
const releaseSchema = z.object({
  tag_name: z.string().min(1),
  name: z.string().nullable(),
  published_at: z.string().nullable(),
  body: z.string().nullable().optional(),
})
const comparisonSchema = z.object({
  status: z.enum(['ahead', 'behind', 'identical', 'diverged']),
  head_commit: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }).optional(),
  files: z.array(z.object({
    filename: z.string(),
    status: z.string(),
    previous_filename: z.string().optional(),
  })),
})

export async function checkRelease(commit: string | null) {
  const options: RequestInit = {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  }
  const response = await fetch(`${API}/releases/latest`, options)
  if (response.status === 404) {
    return { status: 'unavailable' as const, message: 'No published release was found, or the repository is inaccessible.' }
  }
  if (!response.ok) throw new Error(`GitHub release check failed (HTTP ${response.status})`)
  const release = releaseSchema.parse(await response.json())
  if (!commit || !/^[a-f0-9]{40}$/i.test(commit)) {
    return { status: 'unknown' as const, release, message: 'Installed commit is unavailable; comparison is not possible.' }
  }

  const compare = await fetch(`${API}/compare/${commit}...${encodeURIComponent(release.tag_name)}?per_page=100`, {
    ...options, signal: AbortSignal.timeout(10000),
  })
  if (!compare.ok) throw new Error(`GitHub comparison failed (HTTP ${compare.status})`)
  const comparison = comparisonSchema.parse(await compare.json())
  if (comparison.status === 'behind' || comparison.status === 'diverged') {
    return { status: 'unknown' as const, release, message: 'The installed commit is newer than or diverges from the release.' }
  }
  if (comparison.files.length >= 300) {
    return { status: 'unknown' as const, release, message: 'The release has too many changes to display a complete file list.' }
  }
  const maintenance = maintenanceReasons(release.body, comparison.files)
  return {
    status: comparison.status === 'identical' ? 'current' as const : 'available' as const,
    release,
    files: comparison.files,
    maintenance,
    targetCommit: comparison.head_commit?.sha ?? null,
  }
}
