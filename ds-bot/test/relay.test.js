import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CLOSE_BAD_TOKEN, MSG } from '../src/shared/relay-protocol.js'
import { DEFAULT_RELAY_URL, createConnector, createRelayController, relayUrls } from '../src/host/relay.js'

// A stand-in for the browser/Node WebSocket the connector uses. The test drives its events.
class FakeSocket {
  static instances = []
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    FakeSocket.instances.push(this)
  }

  addEventListener(name, listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }

  send(text) {
    this.sent.push(JSON.parse(text))
  }

  close() {
    this.readyState = 3
    this.emit('close', { code: 1000 })
  }

  emit(name, event) {
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }

  open() {
    this.readyState = 1
    this.emit('open', {})
  }

  receive(message) {
    this.emit('message', { data: JSON.stringify(message) })
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

function harness({ feed = false } = {}) {
  FakeSocket.instances = []
  const handled = []
  let subscribe
  const timers = []
  const connector = createConnector({
    url: 'ws://relay.test/connector',
    token: 'tok-123',
    deviceId: 'device-1',
    deviceName: 'My Mac',
    version: '9.9.9',
    apiProtocol: 7,
    handle: async (endpoint, payload) => {
      handled.push([endpoint, payload])
      return { ok: true, value: { endpoint } }
    },
    subscribeFeed: feed ? (subscriber) => { subscribe = subscriber; return () => { subscribe = undefined } } : undefined,
    WebSocketImpl: FakeSocket,
    logger: { warn() {} },
    random: () => 0,
    setTimeoutImpl: (fn, ms) => { timers.push(ms); return timers.length },
    clearTimeoutImpl: () => {},
  })
  return { connector, handled, timers, get subscribe() { return subscribe }, socket: () => FakeSocket.instances.at(-1) }
}

test('the connector binds with its identity, version and protocol', () => {
  const { connector, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  assert.deepEqual(ws.sent, [{
    t: MSG.bind, role: 'connector', kind: 'dsbot', deviceId: 'device-1', name: 'My Mac',
    version: '9.9.9', apiProtocol: 7, accessToken: 'tok-123',
  }])
  connector.stop()
})

test('a request is answered by the in-process handler', async () => {
  const { connector, handled, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  ws.receive({ t: MSG.request, id: 'r1', endpoint: 'state', payload: { since: 3 } })
  await tick()
  assert.deepEqual(handled, [['state', { since: 3 }]])
  assert.deepEqual(ws.sent.at(-1), { t: MSG.response, id: 'r1', result: { ok: true, value: { endpoint: 'state' } } })
  connector.stop()
})

test('host-only endpoints are refused without reaching the handler', async () => {
  const { connector, handled, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  for (const endpoint of ['provider-key', 'secret-set', 'diagnostics-log', 'providers', 'update-install', 'folder-pick']) {
    ws.receive({ t: MSG.request, id: endpoint, endpoint, payload: {} })
  }
  await tick()
  assert.deepEqual(handled, [])
  for (const sent of ws.sent.filter(message => message.t === MSG.response)) {
    assert.equal(sent.result.ok, false)
    assert.equal(sent.result.error.code, 'bot/forbidden')
  }
  connector.stop()
})

test('a feed subscription forwards the same events a window would see', async () => {
  const h = harness({ feed: true })
  h.connector.start()
  const ws = h.socket()
  ws.open()
  ws.receive({ t: MSG.feedSubscribe, sub: 's1' })
  assert.equal(typeof h.subscribe, 'function')
  h.subscribe('stream', { botId: 'b1', text: 'hi' })
  assert.deepEqual(ws.sent.at(-1), { t: MSG.feedEvent, sub: 's1', event: 'stream', data: { botId: 'b1', text: 'hi' } })
  ws.receive({ t: MSG.feedUnsubscribe })
  assert.equal(h.subscribe, undefined)
  h.connector.stop()
})

test('a wrong token stops the connector instead of retrying', () => {
  const { connector, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  ws.emit('close', { code: CLOSE_BAD_TOKEN })
  assert.equal(FakeSocket.instances.length, 1)
  connector.start()
  assert.equal(FakeSocket.instances.length, 1)
})

test('a dropped connection retries with backoff', () => {
  const { connector, timers, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  ws.emit('close', { code: 1006 })
  assert.equal(timers.length, 1)
  assert.equal(timers[0] >= 500 && timers[0] <= 1_000, true)
  connector.stop()
})

test('a relay address yields both the socket and the desktop sign-in URL', () => {
  assert.deepEqual(relayUrls('https://ds.test'), { socket: 'wss://ds.test/connector', login: 'https://ds.test/api/desktop/login' })
  assert.deepEqual(relayUrls('https://ds.test/'), { socket: 'wss://ds.test/connector', login: 'https://ds.test/api/desktop/login' })
  assert.deepEqual(relayUrls('wss://ds.test/connector'), { socket: 'wss://ds.test/connector', login: 'https://ds.test/api/desktop/login' })
  assert.deepEqual(relayUrls('http://127.0.0.1:8787'), { socket: 'ws://127.0.0.1:8787/connector', login: 'http://127.0.0.1:8787/api/desktop/login' })
  assert.equal(relayUrls(''), undefined)
  assert.equal(relayUrls('not a url'), undefined)
})

function relayHarness({ config = {}, fetchImpl, env = {}, defaultUrl } = {}) {
  FakeSocket.instances = []
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-relay-'))
  const controller = createRelayController({
    home,
    config: { url: 'https://relay.test', ...config },
    handle: async () => ({ ok: true, value: null }),
    WebSocketImpl: FakeSocket,
    logger: { warn() {} },
    random: () => 0,
    setTimeoutImpl: () => 0,
    clearTimeoutImpl: () => {},
    defaultDeviceName: 'Test Mac',
    env,
    defaultUrl,
    fetchImpl: fetchImpl ?? (async () => ({
      ok: true,
      json: async () => ({ status: true, accessToken: 'tok-xyz', user: { username: 'alice' } }),
    })),
  })
  return {
    controller,
    home,
    socket: () => FakeSocket.instances.at(-1),
    saved: () => JSON.parse(readFileSync(join(home, 'relay.json'), 'utf8')),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

test('an unbound controller reports the address but no account', (t) => {
  const h = relayHarness()
  t.after(h.cleanup)
  assert.deepEqual(h.controller.status(), {
    configured: true, bound: false, username: '', url: 'https://relay.test',
    deviceName: 'Test Mac', relayConnected: false,
  })
  assert.equal(FakeSocket.instances.length, 0)
})

test('signing in stores the token and binds the connector', async (t) => {
  const calls = []
  const h = relayHarness({
    fetchImpl: async (url, options) => {
      calls.push([url, JSON.parse(options.body)])
      return { ok: true, json: async () => ({ status: true, accessToken: 'tok-xyz', user: { username: 'alice' } }) }
    },
  })
  t.after(h.cleanup)
  const status = await h.controller.login({ username: 'alice', password: 'secret' })
  assert.deepEqual(calls, [['https://relay.test/api/desktop/login', { username: 'alice', password: 'secret' }]])
  assert.equal(status.bound, true)
  assert.equal(status.username, 'alice')
  const ws = h.socket()
  assert.equal(ws.url, 'wss://relay.test/connector')
  ws.open()
  assert.equal(ws.sent[0].accessToken, 'tok-xyz')
  assert.equal(h.saved().token, 'tok-xyz')
  assert.equal(h.saved().deviceId.length > 0, true)
  h.controller.stop()
})

test('a refused sign-in reports the relay message and stays unbound', async (t) => {
  const h = relayHarness({
    fetchImpl: async () => ({ ok: false, json: async () => ({ status: false, message: '无效的凭证' }) }),
  })
  t.after(h.cleanup)
  await assert.rejects(h.controller.login({ username: 'alice', password: 'wrong' }), (error) => {
    assert.equal(error.code, 'bot/invalid')
    assert.equal(error.message, '无效的凭证')
    return true
  })
  assert.equal(h.controller.status().bound, false)
  assert.equal(FakeSocket.instances.length, 0)
})

test('signing in without an address is refused before any request', async (t) => {
  const h = relayHarness({ config: { token: '' } })
  t.after(h.cleanup)
  // Drop the configured address the harness supplies, and the built-in default with it.
  const bare = createRelayController({
    home: h.home,
    config: {},
    handle: async () => ({ ok: true, value: null }),
    WebSocketImpl: FakeSocket,
    logger: { warn() {} },
    defaultDeviceName: 'Test Mac',
    env: {},
    defaultUrl: '',
    fetchImpl: async () => { throw new Error('must not be called') },
  })
  await assert.rejects(bare.login({ username: 'alice', password: 'secret' }), (error) => {
    assert.equal(error.code, 'bot/invalid')
    assert.match(error.message, /relay address/i)
    return true
  })
  bare.stop()
})

test('with nothing configured the controller points at the built-in relay', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-relay-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const controller = createRelayController({
    home,
    config: {},
    handle: async () => ({ ok: true, value: null }),
    WebSocketImpl: FakeSocket,
    logger: { warn() {} },
    defaultDeviceName: 'Test Mac',
    env: {},
  })
  const status = controller.status()
  assert.equal(status.url, DEFAULT_RELAY_URL)
  assert.equal(status.url, 'https://ds.d-1.top')
  assert.equal(status.configured, true)
  assert.equal(status.bound, false)
  controller.stop()
})

test('a blank DS_BOT_RELAY_URL does not hide the built-in relay', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-relay-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const controller = createRelayController({
    home,
    config: {},
    handle: async () => ({ ok: true, value: null }),
    WebSocketImpl: FakeSocket,
    logger: { warn() {} },
    defaultDeviceName: 'Test Mac',
    env: { DS_BOT_RELAY_URL: '   ' },
  })
  assert.equal(controller.status().url, DEFAULT_RELAY_URL)
  controller.stop()
})

test('signing out stops the connector and overrides a profile token', async (t) => {
  const h = relayHarness({ config: { token: 'cfg-token' } })
  t.after(h.cleanup)
  assert.equal(h.controller.status().bound, true)
  h.controller.start()
  assert.equal(FakeSocket.instances.length, 1)
  const status = h.controller.logout()
  assert.equal(status.bound, false)
  assert.equal(FakeSocket.instances[0].readyState, 3)
  assert.equal(h.saved().disabled, true)
  // A profile that still carries a token cannot turn it back on; the account must sign in.
  h.controller.start()
  assert.equal(FakeSocket.instances.length, 1)
})
