const fs = require('node:fs')
const { createHash } = require('node:crypto')
const realFetch = global.fetch

global.fetch = async (input, options) => {
  const url = String(input)
  const api = 'https://api.github.com/repos/vynops/VynK8s'
    const assets = 'https://github.com/vynops/VynK8s/releases/download/v-test/'
    const raw = 'https://raw.githubusercontent.com/vynops/VynK8s/'
  if (!url.startsWith(api) && !url.startsWith(assets) && !url.startsWith(raw)) return realFetch(input, options)
  const fixture = JSON.parse(fs.readFileSync(process.env.VYNK8S_TEST_TARGET, 'utf8'))
  const manifest = JSON.stringify(fixture.target)
  if (url.endsWith('/releases/latest')) {
    return Response.json({ draft: false, prerelease: false, tag_name: 'v-test', body:     'VYNK8S_DATA_COMPATIBLE: true',
          assets: [{ name: 'vynk8s-manifest.json' }, { name: 'vynk8s-sha256.txt' }] })
  }
  if (url.includes('/compare/')) {
    return Response.json({ status: 'ahead', head_commit: { sha: fixture.target.commit }, files: [{ filename: fixture.name }] })
  }
  if (  url.endsWith('/vynk8s-sha256.txt')) return new Response(`${createHash('sha256').update(manifest).digest('hex')}  vynk8s-manifest.json\n`)
    if (url.endsWith('/vynk8s-manifest.json')) return new Response(manifest)
  if (url.startsWith(raw)) return new Response(Buffer.from(fixture.content, 'base64'))
  throw new Error('Unexpected mocked release request')
}
