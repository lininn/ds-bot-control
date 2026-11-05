import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLOSE_BAD_PROTOCOL, MSG } from '../src/shared/relay-protocol.js'
import { createConnector } from '../src/host/relay.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

class FakeSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
  }

  addEventListener(name, listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }

  send(text) {
    this.sent.push(JSON.parse(text))
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.readyState = 1
    this.emit('open', {})
  }

  emit(name, event) {
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }

  message(message) {
    this.emit('message', { data: JSON.stringify(message) })
  }
}

function socketFactory(sockets) {
  return class extends FakeSocket {
    constructor(url) {
      super(url)
      sockets.push(this)
    }
  }
}

function connectorFor(sockets, handle) {
  return createConnector({
    url: 'ws://relay.test/connector',
    token: 'device-token',
    deviceId: 'dev-1',
    machineId: 'machine-1',
    handle,
    WebSocketImpl: socketFactory(sockets),
    random: () => 0,
  })
}

test('a cancel aborts the handler and suppresses its response', async () => {
  const sockets = []
  let seen
  const connector = connectorFor(sockets, (_endpoint, _payload, signal) => {
    seen = signal
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'bot/cancelled' })))
    })
  })
  connector.start()
  const socket = sockets[0]
  socket.open()
  await tick()
  assert.equal(socket.sent[0].t, MSG.bind)
  assert.equal(socket.sent[0].deviceToken, 'device-token')
  assert.equal(socket.sent[0].machineId, 'machine-1')
  socket.message({ t: MSG.request, id: 'r1', endpoint: 'state', payload: {} })
  await tick()
  socket.message({ t: MSG.cancel, id: 'r1' })
  await tick()
  assert.equal(seen.aborted, true)
  assert.equal(socket.sent.some(message => message.t === MSG.response), false)
  connector.stop()
})

test('a known request still answers after an unknown cancel is ignored', async () => {
  const sockets = []
  const connector = connectorFor(sockets, async (_endpoint, _payload, signal) => {
    assert.equal(signal.aborted, false)
    return { ok: true, value: { ready: true } }
  })
  connector.start()
  const socket = sockets[0]
  socket.open()
  await tick()
  socket.message({ t: MSG.cancel, id: 'missing' })
  socket.message({ t: MSG.request, id: 'r2', endpoint: 'state', payload: {} })
  await tick()
  assert.deepEqual(socket.sent.at(-1), { t: MSG.response, id: 'r2', result: { ok: true, value: { ready: true } } })
  connector.stop()
})

test('a protocol mismatch stops retrying and asks for an update', async () => {
  const sockets = []
  const connector = connectorFor(sockets, async () => ({ ok: true }))
  connector.start()
  sockets[0].open()
  await tick()
  sockets[0].emit('close', { code: CLOSE_BAD_PROTOCOL })
  await tick()
  assert.equal(connector.state, 'incompatible')
  connector.start()
  await tick()
  assert.equal(sockets.length, 1)
  connector.stop()
})

test('several close events for one socket schedule one reconnect', async () => {
  const sockets = []
  const timers = []
  const connector = createConnector({
    url: 'ws://relay.test/connector',
    token: 'device-token',
    deviceId: 'dev-1',
    machineId: 'machine-1',
    handle: async () => ({ ok: true }),
    WebSocketImpl: socketFactory(sockets),
    random: () => 0,
    setTimeoutImpl: (callback, delay) => {
      timers.push({ callback, delay })
      return { unref() {} }
    },
    clearTimeoutImpl: () => {},
  })
  connector.start()
  sockets[0].emit('close', {})
  sockets[0].emit('close', {})
  sockets[0].emit('close', {})
  const retries = timers.filter(timer => timer.delay < 20_000)
  assert.equal(retries.length, 1)
  retries[0].callback()
  assert.equal(sockets.length, 2)
  connector.stop()
})
