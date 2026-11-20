import { z } from 'zod'

export const releaseIdentitySchema = z.object({
  tag: z.string().regex(/^[a-z0-9._-]{1,128}$/i),
  commit: z.string().regex(/^[a-f0-9]{40}$/i),
})

export function isReleaseRequestSameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return origin === new URL(process.env.AUTH_URL || process.env.NEXTAUTH_URL || request.url).origin
  } catch {
    return false
  }
}
