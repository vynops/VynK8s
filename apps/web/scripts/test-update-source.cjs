const fs = require('node:fs')
const { createHash } = require('node:crypto')
const realFetch = global.fetch

global.fetch = async (input, options) => {
  const url = String(input)
  const api = 'https://api.github.com/repos/vynops/VynOps'
  const assets = 'https://github.com/vynops/VynOps/releases/download/v-test/'
  const raw = 'https://raw.githubusercontent.com/vynops/VynOps/'
  if (!url.startsWith(api) && !url.startsWith(assets) && !url.startsWith(raw)) return realFetch(input, options)
  const fixture = JSON.parse(fs.readFileSync(process.env.VYNOPS_TEST_TARGET, 'utf8'))
  const manifest = JSON.stringify(fixture.target)
  if (url.endsWith('/releases/latest')) {
    return Response.json({ draft: false, prerelease: false, tag_name: 'v-test', body: 'VYNOPS_DATA_COMPATIBLE: true',
      assets: [{ name: 'vynops-manifest.json' }, { name: 'vynops-sha256.txt' }] })
  }
  if (url.includes('/compare/')) {
    return Response.json({ status: 'ahead', head_commit: { sha: fixture.target.commit }, files: [{ filename: fixture.name }] })
  }
  if (url.endsWith('/vynops-sha256.txt')) return new Response(`${createHash('sha256').update(manifest).digest('hex')}  vynops-manifest.json\n`)
  if (url.endsWith('/vynops-manifest.json')) return new Response(manifest)
  if (url.startsWith(raw)) return new Response(Buffer.from(fixture.content, 'base64'))
  throw new Error('Unexpected mocked release request')
}
