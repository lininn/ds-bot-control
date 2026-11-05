// Unpack one published @lininn/ds-web version into WEB_STATIC_DIR/<version>/.
// Usage: node scripts/sync-web.mjs <version> [webStaticDir]
// It runs `npm pack` (no runtime npm install) and extracts dist/ + manifest.json.
// Set DS_WEB_PACKAGE_DIR to pack a local checkout before the version is published.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pruneWebDist } from '../../scripts/prune-web-dist.mjs'

const version = process.argv[2]
if (!version) {
  console.error('usage: node scripts/sync-web.mjs <version> [webStaticDir]')
  process.exit(1)
}
const outDir = resolve(process.argv[3] ?? new URL('../web-dist', import.meta.url).pathname)
const work = mkdtempSync(join(tmpdir(), 'ds-web-sync-'))

try {
  const spec = process.env.DS_WEB_PACKAGE_DIR ? resolve(process.env.DS_WEB_PACKAGE_DIR) : `@lininn/ds-web@${version}`
  const tarball = execFileSync('npm', ['pack', spec, '--silent'], { encoding: 'utf8', cwd: work }).trim()
  execFileSync('tar', ['-xzf', join(work, tarball), '-C', work])
  const source = join(work, 'package')
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'))
  if (manifest.version !== version) {
    throw new Error(`packed manifest version ${manifest.version} is not ${version}`)
  }
  const target = join(outDir, version)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(join(source, 'dist'), target, { recursive: true })
  cpSync(join(source, 'manifest.json'), join(target, 'manifest.json'))
  console.log(`unpacked @lininn/ds-web@${version} to ${target}`)
  // Keep the previous shell for phones whose desktop has not updated yet, and drop the rest.
  const pruned = pruneWebDist(outDir, 2)
  if (pruned.removed.length > 0) console.log(`pruned old shells: ${pruned.removed.join(', ')}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
