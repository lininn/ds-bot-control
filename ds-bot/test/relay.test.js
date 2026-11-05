import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CLOSE_BAD_TOKEN, CLOSE_DUPLICATE_DEVICE, MSG } from '../src/shared/relay-protocol.js'
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

function harness({ feed = false, watchdogMs, connectTimeoutMs } = {}) {
  FakeSocket.instances = []
  const handled = []
  let subscribe
  const timers = []
  const pending = new Map()
  let nextTimerId = 0
  const connector = createConnector({
    url: 'ws://relay.test/connector',
    token: 'tok-123',
    deviceId: 'device-1',
    deviceName: 'My Mac',
    version: '9.9.9',
    apiProtocol: 7,
    watchdogMs,
    connectTimeoutMs,
    handle: async (endpoint, payload) => {
      handled.push([endpoint, payload])
      return { ok: true, value: { endpoint } }
    },
    subscribeFeed: feed ? (subscriber) => { subscribe = subscriber; return () => { subscribe = undefined } } : undefined,
    WebSocketImpl: FakeSocket,
    logger: { warn() {} },
    random: () => 0,
    setTimeoutImpl: (fn, ms) => {
      timers.push(ms)
      const id = ++nextTimerId
      pending.set(id, fn)
      return id
    },
    clearTimeoutImpl: (id) => { pending.delete(id) },
  })
  // Fire the timer that is still pending and scheduled last (the retry, after the watchdog).
  const runLastTimer = () => {
    const id = [...pending.keys()].at(-1)
    const fn = pending.get(id)
    pending.delete(id)
    fn?.()
  }
  return {
    connector, handled, timers, pending, runLastTimer,
    get subscribe() { return subscribe },
    socket: () => FakeSocket.instances.at(-1),
  }
}

test('the connector binds with its identity, version and protocol', () => {
  const { connector, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  assert.deepEqual(ws.sent, [{
    t: MSG.bind, role: 'connector', kind: 'dsbot', deviceId: 'device-1', machineId: '', name: 'My Mac',
    version: '9.9.9', apiProtocol: 7, deviceToken: 'tok-123',
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
  const { connector, pending, timers, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  ws.emit('close', { code: 1006 })
  // The open armed the watchdog; close cleared it and left only the retry.
  assert.equal(pending.size, 1)
  assert.equal(timers.at(-1) >= 500 && timers.at(-1) <= 1_000, true)
  connector.stop()
})

test('a socket error reconnects even when no close event follows', () => {
  const { connector, pending, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  assert.equal(pending.size, 1)
  ws.emit('error', {})
  assert.equal(ws.abandoned, true)
  assert.equal(ws.readyState, 3)
  assert.equal(pending.size, 1)
  // A close arriving later must not schedule a second retry for the same socket.
  ws.emit('close', { code: 1006 })
  assert.equal(pending.size, 1)
  connector.stop()
})

test('a connection that goes silent is reconnected by the watchdog', () => {
  const { connector, pending, runLastTimer, socket } = harness({ watchdogMs: 60_000 })
  connector.start()
  const ws = socket()
  ws.open()
  assert.equal(pending.size, 1)
  runLastTimer()
  assert.equal(ws.abandoned, true)
  assert.equal(ws.readyState, 3)
  // The watchdog cleared itself and the abandon scheduled the retry.
  assert.equal(pending.size, 1)
  connector.stop()
})

test('an inbound frame re-arms the watchdog', () => {
  const { connector, pending, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  const armedOnOpen = [...pending.keys()].at(-1)
  ws.receive({ t: MSG.ping, at: 1 })
  const armedAfter = [...pending.keys()].at(-1)
  assert.notEqual(armedAfter, armedOnOpen)
  assert.equal(pending.size, 1)
  connector.stop()
  assert.equal(pending.size, 0)
})

test('a relay address yields both the socket and the desktop sign-in URL', () => {
  assert.deepEqual(relayUrls('https://ds.test'), { socket: 'wss://ds.test/connector', login: 'https://ds.test/api/desktop/login' })
  assert.deepEqual(relayUrls('https://ds.test/'), { socket: 'wss://ds.test/connector', login: 'https://ds.test/api/desktop/login' })
  assert.deepEqual(relayUrls('wss://ds.test/connector'), { socket: 'wss://ds.test/connector', login: 'https://ds.test/api/desktop/login' })
  assert.deepEqual(relayUrls('http://127.0.0.1:8787'), { socket: 'ws://127.0.0.1:8787/connector', login: 'http://127.0.0.1:8787/api/desktop/login' })
  assert.equal(relayUrls(''), undefined)
  assert.equal(relayUrls('not a url'), undefined)
})

function relayHarness({ config = {}, fetchImpl, env = {}, defaultUrl, machineId = 'machine-test', readOnly } = {}) {
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
    machineId,
    readOnly,
    env,
    defaultUrl,
    fetchImpl: fetchImpl ?? (async () => ({
      ok: true,
      json: async () => ({ status: true, deviceToken: 'tok-xyz', user: { username: 'alice' } }),
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
    deviceName: 'Test Mac', relayConnected: false, state: 'idle',
  })
  assert.equal(FakeSocket.instances.length, 0)
})

test('signing in stores the token and binds the connector', async (t) => {
  const calls = []
  const h = relayHarness({
    fetchImpl: async (url, options) => {
      calls.push([url, JSON.parse(options.body)])
      return { ok: true, json: async () => ({ status: true, deviceToken: 'tok-xyz', user: { username: 'alice' } }) }
    },
  })
  t.after(h.cleanup)
  const status = await h.controller.login({ username: 'alice', password: 'secret' })
  assert.equal(calls.length, 1)
  const [url, body] = calls[0]
  assert.equal(url, 'https://relay.test/api/desktop/login')
  // The login names this device and machine so the relay can pair and rebind it.
  assert.deepEqual({ ...body, deviceId: 'id' }, {
    username: 'alice', password: 'secret', deviceId: 'id', machineId: 'machine-test', name: 'Test Mac',
  })
  assert.equal(typeof body.deviceId, 'string')
  assert.equal(body.deviceId.length > 0, true)
  assert.equal(status.bound, true)
  assert.equal(status.username, 'alice')
  const ws = h.socket()
  assert.equal(ws.url, 'wss://relay.test/connector')
  ws.open()
  assert.equal(ws.sent[0].deviceToken, 'tok-xyz')
  assert.equal(h.saved().deviceToken, 'tok-xyz')
  assert.equal(h.saved().token, undefined)
  assert.equal(h.saved().deviceId, body.deviceId)
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

// --- Connector states ---------------------------------------------------------------------

test('a socket that never opens is abandoned and retried', () => {
  const { connector, pending, runLastTimer, socket } = harness({ connectTimeoutMs: 20_000 })
  connector.start()
  const ws = socket()
  // Nothing opened, so the only pending timer is the connect deadline.
  assert.equal(pending.size, 1)
  runLastTimer()
  assert.equal(ws.abandoned, true)
  assert.equal(ws.readyState, 3)
  // The retry replaces the deadline.
  assert.equal(pending.size, 1)
  connector.stop()
})

test('an open socket reports itself connected', () => {
  const { connector, socket } = harness()
  connector.start()
  assert.equal(connector.state, 'connecting')
  socket().open()
  assert.equal(connector.state, 'connected')
  assert.equal(connector.connected, true)
  connector.stop()
})

test('a duplicate device id parks the connector instead of stopping it', () => {
  const { connector, pending, runLastTimer, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  ws.emit('close', { code: CLOSE_DUPLICATE_DEVICE })
  // Retrying is right here (the other host may quit), but slowly, and the reason is visible.
  assert.equal(connector.state, 'occupied')
  assert.equal(pending.size, 1)
  connector.start()
  assert.equal(FakeSocket.instances.length, 1)
  runLastTimer()
  assert.equal(FakeSocket.instances.length, 2)
  connector.stop()
})

test('a rejected token stops the connector for good', () => {
  const { connector, pending, socket } = harness()
  connector.start()
  const ws = socket()
  ws.open()
  ws.emit('close', { code: CLOSE_BAD_TOKEN })
  assert.equal(connector.state, 'expired')
  assert.equal(pending.size, 0)
  connector.start()
  assert.equal(FakeSocket.instances.length, 1)
})

// --- Single instance and manual retry ----------------------------------------------------

test('a read-only host does not start the connector and says so', (t) => {
  const h = relayHarness({ config: { token: 'tok-123' }, readOnly: () => 'another dsh owns the team' })
  t.after(h.cleanup)
  h.controller.start()
  assert.equal(FakeSocket.instances.length, 0)
  assert.equal(h.controller.status().state, 'read-only')
  h.controller.stop()
  // The same controller, once the lock is gone elsewhere, connects on a manual retry.
  FakeSocket.instances = []
  const writable = relayHarness({ config: { token: 'tok-123' } })
  t.after(writable.cleanup)
  writable.controller.reconnect()
  assert.equal(FakeSocket.instances.length, 1)
  writable.controller.stop()
})

test('reconnect drops the backoff and dials again', (t) => {
  const h = relayHarness({ config: { token: 'tok-123' } })
  t.after(h.cleanup)
  h.controller.start()
  const first = h.socket()
  first.open()
  first.emit('close', { code: CLOSE_DUPLICATE_DEVICE })
  assert.equal(h.controller.status().state, 'occupied')
  h.controller.reconnect()
  assert.equal(FakeSocket.instances.length, 2)
  assert.equal(first.abandoned, true)
  h.controller.stop()
})

// --- Machine identity migration -----------------------------------------------------------

function identityHarness({ saved, machineId, name = 'Test Mac' }) {
  FakeSocket.instances = []
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-relay-id-'))
  if (saved !== undefined) writeFileSync(join(home, 'relay.json'), JSON.stringify(saved))
  const controller = createRelayController({
    home,
    config: { url: 'https://relay.test', token: 'tok-123' },
    handle: async () => ({ ok: true, value: null }),
    WebSocketImpl: FakeSocket,
    logger: { warn() {} },
    defaultDeviceName: name,
    machineId,
    env: {},
  })
  return {
    controller,
    saved: () => JSON.parse(readFileSync(join(home, 'relay.json'), 'utf8')),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

test('the machine id is recomputed, never written to relay.json', (t) => {
  const h = identityHarness({ saved: { deviceId: 'old-id' }, machineId: 'machine-a' })
  t.after(h.cleanup)
  h.controller.start()
  assert.equal(h.saved().deviceId, 'old-id')
  assert.equal(h.saved().machineId, undefined)
  h.controller.stop()
})

test('a file copied from another machine keeps its pairing id and binds this machine', (t) => {
  const h = identityHarness({ saved: { deviceId: 'old-id', machineId: 'machine-b' }, machineId: 'machine-a' })
  t.after(h.cleanup)
  h.controller.start()
  const ws = FakeSocket.instances.at(-1)
  ws.open()
  assert.equal(h.saved().deviceId, 'old-id')
  assert.equal(ws.sent[0].deviceId, 'old-id')
  // The stored machine id is stale; the bind names the machine actually running this file.
  assert.equal(ws.sent[0].machineId, 'machine-a')
  h.controller.stop()
})

test('the same machine keeps its pairing id', (t) => {
  const h = identityHarness({ saved: { deviceId: 'old-id', machineId: 'machine-a' }, machineId: 'machine-a' })
  t.after(h.cleanup)
  h.controller.start()
  assert.equal(h.saved().deviceId, 'old-id')
  h.controller.stop()
})

test('without a machine id the pairing id is left exactly as it was', (t) => {
  const h = identityHarness({ saved: { deviceId: 'old-id' }, machineId: '' })
  t.after(h.cleanup)
  h.controller.start()
  assert.deepEqual(h.saved(), { deviceId: 'old-id' })
  h.controller.stop()
})

test('the bogon placeholder name is replaced by the computer name', (t) => {
  const h = identityHarness({ saved: { deviceId: 'old-id', deviceName: hostname() }, machineId: 'machine-a', name: "Lininn's MacBook Pro" })
  t.after(h.cleanup)
  assert.equal(h.controller.status().deviceName, "Lininn's MacBook Pro")
  assert.equal(h.saved().deviceName, "Lininn's MacBook Pro")
  h.controller.stop()
})
