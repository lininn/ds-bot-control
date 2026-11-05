import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.DSBOT_RELAY_DATA = mkdtempSync(join(tmpdir(), 'ds-relay-test-'))
process.env.COOKIE_SECURE = '0'

const { SESSION_COOKIE, destroySession, makeSession, readSession } = await import('../src/auth.js')
const { isForbiddenEndpoint } = await import('../src/protocol.js')
const { hasVersion, listVersions, mismatchPage } = await import('../src/static.js')
const { cookieHeader, parseCookies } = await import('../src/util.js')

const reqWithCookie = (token) => ({ headers: { cookie: `${SESSION_COOKIE}=${token}` } })

test('a session cookie round-trips and never carries the access token', () => {
  const created = makeSession({ username: 'alice', displayName: 'Alice' })
  assert.equal(typeof created.id, 'string')
  assert.equal(created.id.length >= 40, true)
  const session = readSession(reqWithCookie(created.id))
  assert.equal(session.username, 'alice')
  assert.equal(session.displayName, 'Alice')
  assert.equal('t' in session, false)
  assert.equal(JSON.stringify(session).includes('access'), false)
  const tampered = `${created.id.slice(0, -1)}${created.id.endsWith('A') ? 'B' : 'A'}`
  assert.equal(readSession(reqWithCookie(tampered)), null)
  destroySession(session)
  assert.equal(readSession(reqWithCookie(created.id)), null)
})

test('an expired or malformed session is not read', () => {
  assert.equal(readSession(reqWithCookie('not-a-token')), null)
  assert.equal(readSession({ headers: {} }), null)
})

test('forbidden endpoints are a default-deny allowlist', () => {
  for (const endpoint of ['provider-key', 'provider-add', 'secret-set', 'diagnostics-log', 'connector-retry', 'providers', 'folder-pick', 'update-install', 'dsh-update-install', 'made-up-endpoint']) {
    assert.equal(isForbiddenEndpoint(endpoint), true, endpoint)
  }
  for (const endpoint of ['state', 'chat', 'send', 'models', 'efforts', 'approval-answer', 'create-room', 'new-room-conversation', 'duplicate-room', 'memory-history']) {
    assert.equal(isForbiddenEndpoint(endpoint), false, endpoint)
  }
})

test('versions are listed newest-last and only semver directories count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-relay-static-'))
  try {
    for (const version of ['0.2.3', '0.2.10', '0.1.0', 'tmp', 'v0.3.0']) {
      mkdirSync(join(dir, version))
      writeFileSync(join(dir, version, 'index.html'), '<!doctype html>')
    }
    assert.deepEqual(listVersions(dir), ['0.1.0', '0.2.3', '0.2.10', 'v0.3.0'])
    assert.equal(hasVersion(dir, '0.2.3'), true)
    assert.equal(hasVersion(dir, '9.9.9'), false)
    assert.equal(hasVersion(dir, 'tmp'), false)
    const page = mismatchPage(listVersions(dir), '9.9.9')
    assert.equal(page.includes('9.9.9'), true)
    assert.equal(page.includes('0.2.3'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cookies parse and are emitted with the expected flags', () => {
  assert.deepEqual(parseCookies({ headers: { cookie: 'a=1; b=two' } }), { a: '1', b: 'two' })
  const header = cookieHeader('relay_session', 'v', { maxAgeSec: 60, secure: true })
  assert.equal(header.includes('HttpOnly'), true)
  assert.equal(header.includes('SameSite=Lax'), true)
  assert.equal(header.includes('Path=/'), true)
  assert.equal(header.includes('Secure'), true)
  assert.equal(header.includes('Max-Age=60'), true)
})
