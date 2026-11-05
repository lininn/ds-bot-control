import assert from 'node:assert/strict'
import { test } from 'node:test'
import { config } from '../src/config.js'
import { LoginLimiter } from '../src/limits.js'
import { clientIp, sameOrigin } from '../src/util.js'

function clock() {
  let now = 1_000_000
  return { now: () => now, advance: ms => { now += ms } }
}

test('five failures for one IP/account pair lock it for fifteen minutes', () => {
  const time = clock()
  const limiter = new LoginLimiter({ now: time.now })
  try {
    for (let index = 0; index < 4; index += 1) {
      assert.equal(limiter.check('1.2.3.4', 'alice').allowed, true)
      limiter.failure('1.2.3.4', 'alice')
    }
    assert.equal(limiter.check('1.2.3.4', 'alice').allowed, true)
    limiter.failure('1.2.3.4', 'alice')
    assert.equal(limiter.check('1.2.3.4', 'alice').allowed, false)
    time.advance(15 * 60_000 + 1)
    assert.equal(limiter.check('1.2.3.4', 'alice').allowed, true)
  } finally {
    limiter.stop()
  }
})

test('an account is locked across addresses after fifty failures', () => {
  const time = clock()
  const limiter = new LoginLimiter({ now: time.now })
  try {
    for (let index = 0; index < 50; index += 1) limiter.failure(`10.0.0.${index}`, 'alice')
    assert.equal(limiter.check('192.0.2.1', 'alice').allowed, false)
  } finally {
    limiter.stop()
  }
})

test('one address is limited after ten failures across accounts', () => {
  const time = clock()
  const limiter = new LoginLimiter({ now: time.now })
  try {
    for (let index = 0; index < 10; index += 1) limiter.failure('198.51.100.7', `user-${index}`)
    assert.equal(limiter.check('198.51.100.7', 'another').allowed, false)
    assert.equal(limiter.check('198.51.100.8', 'another').allowed, true)
  } finally {
    limiter.stop()
  }
})

test('a successful sign-in clears the pair and account counters', () => {
  const time = clock()
  const limiter = new LoginLimiter({ now: time.now })
  try {
    for (let index = 0; index < 4; index += 1) limiter.failure('203.0.113.1', 'bob')
    limiter.success('203.0.113.1', 'bob')
    for (let index = 0; index < 4; index += 1) limiter.failure('203.0.113.1', 'bob')
    assert.equal(limiter.check('203.0.113.1', 'bob').allowed, true)
  } finally {
    limiter.stop()
  }
})

test('the forwarded-for header is read from the right and ignored from an untrusted peer', () => {
  const original = { trustProxy: config.trustProxy, trustedProxies: config.trustedProxies }
  try {
    config.trustProxy = true
    config.trustedProxies = ['10.0.0.0/8', '::1/128']
    const fromProxy = { socket: { remoteAddress: '::ffff:10.1.2.3' }, headers: { 'x-forwarded-for': '8.8.8.8, 203.0.113.9, 10.9.9.9' } }
    assert.equal(clientIp(fromProxy), '203.0.113.9')
    const direct = { socket: { remoteAddress: '192.0.2.5' }, headers: { 'x-forwarded-for': '8.8.8.8' } }
    assert.equal(clientIp(direct), '192.0.2.5')
    const loopback = { socket: { remoteAddress: '::1' }, headers: { 'x-forwarded-for': '2001:db8::1' } }
    assert.equal(clientIp(loopback), '2001:db8::1')
  } finally {
    config.trustProxy = original.trustProxy
    config.trustedProxies = original.trustedProxies
  }
})

test('an origin must match the request host unless a non-browser path opts out', () => {
  const request = { headers: { host: 'relay.test', origin: 'https://relay.test' } }
  assert.equal(sameOrigin(request), true)
  assert.equal(sameOrigin({ headers: { host: 'relay.test', origin: 'https://sub.relay.test' } }), false)
  assert.equal(sameOrigin({ headers: { host: 'relay.test', origin: 'not a url' } }), false)
  assert.equal(sameOrigin({ headers: { host: 'relay.test' } }), false)
  assert.equal(sameOrigin({ headers: { host: 'relay.test' } }, { allowMissing: true }), true)
})
