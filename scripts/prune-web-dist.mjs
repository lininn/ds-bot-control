// Keep only the newest built web shells under a relay's WEB_STATIC_DIR. A phone pinned to an
// older desktop version still needs that version's directory, so the previous release is kept
// alongside the current one; anything older is dead weight.
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listVersions } from '../relay/src/static.js'

export function pruneWebDist(dir, keep = 2) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a positive integer')
  const versions = listVersions(dir)
  const removed = versions.slice(0, Math.max(0, versions.length - keep))
  for (const version of removed) rmSync(join(dir, version), { recursive: true, force: true })
  return { kept: versions.slice(-keep), removed }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../relay/web-dist', import.meta.url)))
  const keep = Number(process.argv[3] ?? 2)
  try {
    const result = pruneWebDist(dir, keep)
    console.log(`[prune-web-dist] kept ${result.kept.join(', ') || '(none)'}`)
    if (result.removed.length > 0) console.log(`[prune-web-dist] removed ${result.removed.join(', ')}`)
  } catch (error) {
    console.error(`[prune-web-dist] ${error?.message ?? error}`)
    process.exit(1)
  }
}
