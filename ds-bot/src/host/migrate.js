// Upgrades to a new baseline keep the old team file. The first host that can write
// copies state.json aside before adopting it, and records the settings the new
// baseline retires. The copy is made once: later launches find it and leave it alone.
import { basename, dirname, join } from 'node:path'
import { appendFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs'

export const MIGRATION_LOG = 'state-migration.log'

const backupPrefix = statePath => `${basename(statePath)}.bak-`

/**
 * Copy the saved team aside unless an earlier launch already did. The copy is made
 * synchronously, before adoption and before the async load can yield, so the session
 * indexes still exist before the first tool or shell env call.
 * @param {string} statePath
 * @param {number} now
 * @returns {string | undefined} the backup made, or undefined when one exists
 */
export function backupBeforeMigration(statePath, now = Date.now()) {
  const dir = dirname(statePath)
  const prefix = backupPrefix(statePath)
  const names = readdirSync(dir)
  if (names.some(name => name.startsWith(prefix))) return undefined
  const backup = `${statePath}.bak-${now}`
  copyFileSync(statePath, backup)
  return backup
}

/**
 * Append the retired relay settings to the migration log, one line per setting.
 * @param {string} home
 * @param {{roomId:string,key:string,value:unknown}[]} retired
 * @param {Date} at
 */
export function logRetiredSettings(home, retired, at = new Date()) {
  if (retired.length === 0) return
  mkdirSync(home, { recursive: true })
  const text = retired
    .map(({ roomId, key, value }) => `${at.toISOString()} retired group ${roomId}: ${key}=${JSON.stringify(value)}`)
    .join('\n')
  appendFileSync(join(home, MIGRATION_LOG), `${text}\n`, 'utf8')
}
