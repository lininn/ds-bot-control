// Small JSON files owned by the relay. Sessions and devices survive a restart, so every
// write goes to a private temporary file and is renamed into place: a crash never leaves a
// half-written registry that would strand every signed-in phone.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export function readJsonFile(path, fallback) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : fallback
  } catch {
    return fallback
  }
}

export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* the temporary file may not exist */ }
    throw error
  }
}
