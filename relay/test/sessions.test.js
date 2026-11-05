import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'ds-relay-sessions-'))
process.env.DSBOT_RELAY_DATA = dataDir
process.env.COOKIE_SECURE = '0'

const { config } = await import('../src/config.js')
const { createSession, readSession, removeSession, sessionCount } = await import('../src/sessions.js')

test('a session id is random, kept as a hash on disk, and resolves to its user', () => {
  const created = createSession({ username: 'alice', displayName: 'Alice' })
  assert.equal(created.id.length >= 40, true)
  assert.equal(created.hash.length, 64)
  const session = readSession(created.id)
  assert.equal(session.username, 'alice')
  assert.equal(session.displayName, 'Alice')
  assert.equal(session.hash, created.hash)
  const saved = readFileSync(join(dataDir, 'sessions.json'), 'utf8')
  assert.equal(saved.includes(created.id), false)
  assert.equal(saved.includes(created.hash), true)
  assert.equal(saved.includes('accessToken'), false)
  removeSession(created.hash)
  assert.equal(readSession(created.id), null)
  assert.equal(sessionCount(), 0)
})

test('a malformed or unknown session id is never read', () => {
  assert.equal(readSession(''), null)
  assert.equal(readSession('not-a-session'), null)
  assert.equal(readSession(undefined), null)
})

test('an idle session expires and is removed from the table', async () => {
  const created = createSession({ username: 'bob' })
  const idle = config.sessionIdleMs
  config.sessionIdleMs = 1
  try {
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(readSession(created.id), null)
    assert.equal(sessionCount(), 0)
  } finally {
    config.sessionIdleMs = idle
  }
})

test.after(() => rmSync(dataDir, { recursive: true, force: true }))
