// A third-party bundle can carry its own on/off switch in the profile patch:
//
//   - id: dsh-purge
//     name: dsh-purge
//     config:
//       enabled: true | false
//
// dsh-purge rewrites this patch when it installs, but only when the insert is missing, so
// flipping the value here survives an upgrade. DS Bot lists every bundle that already has
// such a switch and lets the user turn it off from Settings without uninstalling. A bundle
// without an `enabled` key is not listed: there is nothing safe to write for it.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const PATCH_FILE = 'cordis.patch.yml'

const failure = (message, code) => Object.assign(new Error(message), { code })

const indentOf = line => line.match(/^[ \t]*/)[0].length
const startsEntry = line => /^[ \t]*-[ \t]/.test(line)

/** The profile directories a DSH home holds, in directory order. */
export function profilesOf(dshHome) {
  const root = join(dshHome, 'profiles')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name))
  } catch {
    return []
  }
}

/**
 * Every bundle switch a profile patch declares, in file order.
 * @param {string} text the cordis.patch.yml contents
 * @returns {{ name: string, enabled: boolean, enabledLine: number }[]}
 */
export function parseSwitches(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (let at = 0; at < lines.length; at += 1) {
    const block = blockAt(lines, at)
    if (block === undefined) continue
    if (block.enabled !== undefined) out.push({ name: block.name, enabled: block.enabled, enabledLine: block.enabledLine })
    at = block.end - 1
  }
  return out
}

/**
 * The entry that starts at `at`, with the switch in its config, or undefined when the line
 * is not an `- id:` entry. The block ends at the next entry at the same or a shallower
 * indent, which is where a sibling insert or a top-level row begins.
 */
function blockAt(lines, at) {
  const id = lines[at].match(/^([ \t]*)-[ \t]+id:[ \t]*(\S+)[ \t]*$/)
  if (!id) return undefined
  const base = id[1].length
  let end = lines.length
  for (let next = at + 1; next < lines.length; next += 1) {
    if (startsEntry(lines[next]) && indentOf(lines[next]) <= base) { end = next; break }
  }
  let name = id[2].replace(/^["']|["']$/g, '')
  let enabled
  let enabledLine
  for (let line = at + 1; line < end; line += 1) {
    const trimmed = lines[line].trim()
    const named = trimmed.match(/^name:[ \t]*(.+)$/)
    if (named) name = named[1].trim().replace(/^["']|["']$/g, '')
    const value = trimmed.match(/^enabled:[ \t]*(true|false)[ \t]*$/)
    if (value) { enabled = value[1] === 'true'; enabledLine = line }
  }
  return { name, enabled, enabledLine, end }
}

/** The switches a profile declares, read from its patch. Missing files read as none. */
export function switchesIn(profileDir) {
  const file = join(profileDir, PATCH_FILE)
  if (!existsSync(file)) return []
  try {
    return parseSwitches(readFileSync(file, 'utf8')).map(({ name, enabled }) => ({ name, enabled }))
  } catch {
    return []
  }
}

/** Every switch across the DSH home's profiles, each tagged with the profile it lives in. */
export function status(dshHome) {
  const plugins = []
  for (const dir of profilesOf(dshHome)) {
    for (const row of switchesIn(dir)) plugins.push({ profile: basename(dir), name: row.name, enabled: row.enabled })
  }
  return { plugins }
}

/**
 * Flip one bundle's switch in a profile's patch, leaving every other line as it was.
 * @returns {{ profile: string, name: string, enabled: boolean }}
 */
export function setEnabled(profileDir, name, enabled) {
  const file = join(profileDir, PATCH_FILE)
  if (!existsSync(file)) throw failure('That profile has no patch file.', 'bot/not-found')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (let at = 0; at < lines.length; at += 1) {
    const block = blockAt(lines, at)
    if (block === undefined) continue
    if (block.name !== name) { at = block.end - 1; continue }
    if (block.enabledLine === undefined) throw failure(`${name} has no on/off switch to change.`, 'bot/not-found')
    lines[block.enabledLine] = lines[block.enabledLine].replace(/enabled:[ \t]*(true|false)/, `enabled: ${enabled ? 'true' : 'false'}`)
    writeFileSync(file, lines.join('\n'))
    return { profile: basename(profileDir), name, enabled }
  }
  throw failure(`${name} has no on/off switch to change.`, 'bot/not-found')
}

export function install(rt) {
  rt.plugins = {
    status: () => status(rt.dshHome),
    // Only a directory that already sits under profiles/ can be written, so the name from
    // the page cannot reach outside the DSH home.
    setEnabled: (profile, name, enabled) => {
      const dirs = profilesOf(rt.dshHome).filter(dir => basename(dir) === String(profile))
      if (dirs.length !== 1) throw failure('That profile is not here any more.', 'bot/not-found')
      return setEnabled(dirs[0], String(name), enabled === true)
    },
  }
}
