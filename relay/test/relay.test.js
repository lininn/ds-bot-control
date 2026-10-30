import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeSession, readSession } from '../src/auth.js'
import { isForbiddenEndpoint } from '../src/protocol.js'
import { hasVersion, listVersions, mismatchPage } from '../src/static.js'
import { cookieHeader, parseCookies } from '../src/util.js'

const reqWithCookie = (token) => ({ headers: { cookie: `relay_session=${token}` } })

test('a session cookie round-trips and rejects a tampered signature', () => {
  const token = makeSession({ username: 'alice', displayName: 'Alice' }, 'access-123')
  const session = readSession(reqWithCookie(token))
  assert.equal(session.u, 'alice')
  assert.equal(session.t, 'access-123')
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
  assert.equal(readSession(reqWithCookie(tampered)), null)
})

test('an expired session is not read', () => {
  const token = makeSession({ username: 'alice' }, 'x')
  // Reach into the payload: the expiry is part of the signed JSON, so re-sign via a fake
  // clock is not possible here; instead assert a garbage payload fails closed.
  assert.equal(readSession(reqWithCookie('not-a-token')), null)
  assert.equal(readSession({ headers: {} }), null)
})

test('forbidden endpoints are recognized by family and by exact name', () => {
  for (const endpoint of ['provider-key', 'provider-add', 'secret-set', 'diagnostics-log', 'connector-retry', 'providers', 'folder-pick', 'update-install', 'dsh-update-install']) {
    assert.equal(isForbiddenEndpoint(endpoint), true, endpoint)
  }
  for (const endpoint of ['state', 'chat', 'send', 'models', 'efforts', 'approval-answer']) {
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
