import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

const [repository, output, manifestOutput] = process.argv.slice(2)
if (!repository || !output || !manifestOutput) throw new Error('Usage: node package-release.mjs <repository> <output.tar.gz> <manifest.json>')

const root = realpathSync(repository)
const target = resolve(output)
const staging = mkdtempSync(join(tmpdir(), 'vynops-release-'))

function hashFiles(source, directory = source, files = Object.create(null)) {
  for (const name of readdirSync(directory)) {
    const file = join(directory, name)
    const info = lstatSync(file)
    if (info.isDirectory()) hashFiles(source, file, files)
    else if (info.isFile()) {
      files[relative(source, file).split(sep).join('/')] = {
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
        size: info.size,
        executable: Boolean(info.mode & 0o111),
      }
    } else {
      throw new Error('Release packages cannot contain symlinks or special files')
    }
  }
  return files
}

try {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const commit = git('rev-parse', '--verify', 'HEAD')
  const date = git('show', '-s', '--format=%cI', commit)
  const dataCompatible = /^VYNOPS_DATA_COMPATIBLE: true\r?$/m.test(process.env.VYNOPS_RELEASE_BODY || '')
  const archive = join(staging, 'source.tar')
  const source = join(staging, 'source')
  mkdirSync(source)
  git('archive', '--format=tar', `--output=${archive}`, commit)
  execFileSync('tar', ['-xf', archive, '-C', source], { stdio: 'inherit' })
  const manifest = JSON.stringify({ commit, date, dataCompatible, files: hashFiles(source) }) + '\n'
  writeFileSync(join(source, 'apps', 'web', 'release-version.json'), manifest, { flag: 'wx' })
  writeFileSync(resolve(manifestOutput), manifest, { flag: 'wx' })
  execFileSync('tar', ['-czf', target, '-C', source, '.'], { stdio: 'inherit' })
  console.log(`Packaged release ${commit}`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
