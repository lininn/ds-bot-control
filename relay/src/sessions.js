// Phone sessions live on the relay, not in the cookie. The cookie carries a random 256-bit
// id; the table stores only its SHA-256, so a copied cookie is the only way to use a session.
import crypto from 'node:crypto'
import { join } from 'node:path'
import { config } from './config.js'
import { readJsonFile, writeJsonFile } from './storage.js'

const sessions = new Map()
let loaded = false
let dirty = false

const file = () => join(config.dataDir, 'sessions.json')
const hash = id => crypto.createHash('sha256').update(String(id)).digest('hex')

function load() {
  if (loaded) return
  loaded = true
  const saved = readJsonFile(file(), {})
  const now = Date.now()
  for (const [key, record] of Object.entries(saved)) {
    if (record === null || typeof record !== 'object') continue
    if (typeof record.username !== 'string') continue
    if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.lastSeen)) continue
    if (expired(record, now)) continue
    sessions.set(key, record)
  }
}

function expired(record, now = Date.now()) {
  return now - record.createdAt > config.sessionTtlMs || now - record.lastSeen > config.sessionIdleMs
}

function save() {
  writeJsonFile(file(), Object.fromEntries(sessions))
  dirty = false
}

function touch(record, now) {
  // A phone makes many requests per minute; persisting every one would rewrite the table
  // constantly. A minute of drift is harmless for the 24-hour idle window.
  if (now - record.lastSeen > 60_000) {
    record.lastSeen = now
    dirty = true
  }
}

export function createSession(user) {
  load()
  const now = Date.now()
  const id = crypto.randomBytes(32).toString('base64url')
  const record = {
    username: user.username,
    displayName: typeof user.displayName === 'string' ? user.displayName : '',
    createdAt: now,
    lastSeen: now,
  }
  sessions.set(hash(id), record)
  save()
  return { id, hash: hash(id), ...record }
}

export function readSession(id) {
  load()
  if (typeof id !== 'string' || id === '') return null
  const key = hash(id)
  const record = sessions.get(key)
  if (record === undefined) return null
  const now = Date.now()
  if (expired(record, now)) {
    sessions.delete(key)
    dirty = true
    save()
    return null
  }
  touch(record, now)
  if (dirty) save()
  return {
    hash: key,
    username: record.username,
    displayName: record.displayName,
    createdAt: record.createdAt,
    lastSeen: record.lastSeen,
  }
}

export function removeSession(hashValue) {
  load()
  if (sessions.delete(hashValue)) save()
}

export function sessionCount() {
  load()
  return sessions.size
}
