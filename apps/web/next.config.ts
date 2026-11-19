import type { NextConfig } from 'next'
import { buildRevision } from './src/lib/build-revision.js'

const revision = buildRevision(__dirname)

// Allow remote access to the dev server (e.g. on a cloud VM accessed by IP).
// Set ALLOWED_DEV_ORIGINS=1.2.3.4,5.6.7.8 in .env.local ? leave unset for local dev.
const allowedDevOrigins = process.env.ALLOWED_DEV_ORIGINS
  ? process.env.ALLOWED_DEV_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : []

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {},
  env: {
    VYNOPS_BUILD_COMMIT: revision.commit,
    VYNOPS_BUILD_COMMIT_DATE: revision.date,
    VYNOPS_BUILD_DIRTY: revision.dirty,
    VYNOPS_BUILD_SOURCE: revision.source,
  },
  ...(allowedDevOrigins.length > 0 && { allowedDevOrigins }),
  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts'],
  },
  images: {
    domains: [],
  },
}

export default nextConfig
