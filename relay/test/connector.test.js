import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLOSE_BAD_PROTOCOL, CLOSE_BAD_TOKEN, CLOSE_DUPLICATE_DEVICE } from '../src/protocol.js'
import { Hub } from '../src/connector.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

function fakeSocket() {
  const listeners = new Map()
  return {
    readyState: 1,
    sent: [],
    closed: [],
    on(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]) },
    send(text) { this.sent.push(JSON.parse(text)) },
    close(code, reason) { this.closed.push({ code, reason }); this.readyState = 3 },
    emit(name, value) { for (const listener of listeners.get(name) ?? []) listener(value) },
  }
}

function makeHub(verify = async token => (token === 'good' ? { username: 'alice' } : null)) {
  return new Hub({
    verifyToken: verify,
    requestTimeoutMs: 1_000,
    pingMs: 1e9,
    pongTimeoutMs: 1e9,
    bindTimeoutMs: 1e9,
    logger: { info() {}, warn() {} },
  })
}

const BIND = { t: 'bind', accessToken: 'good', deviceId: 'd1', name: 'My Mac', version: '0.2.3', apiProtocol: 1 }

test('a bind with a valid token registers the device and answers bound', async () => {
  const hub = makeHub()
  const ws = fakeSocket()
  hub.handleConnection(ws)
  ws.emit('message', JSON.stringify(BIND))
  await tick()
  assert.deepEqual(ws.sent[0], { t: 'bound', deviceId: 'd1' })
  assert.deepEqual(hub.devicesFor('alice'), [{ deviceId: 'd1', name: 'My Mac', version: '0.2.3', apiProtocol: 1 }])
})

test('a bad token closes with 4001', async () => {
  const hub = makeHub()
  const ws = fakeSocket()
  hub.handleConnection(ws)
  ws.emit('message', JSON.stringify({ ...BIND, accessToken: 'wrong' }))
  await tick()
  assert.equal(ws.closed[0].code, CLOSE_BAD_TOKEN)
  assert.deepEqual(hub.devicesFor('alice'), [])
})

test('a different protocol closes with 4003', async () => {
  const hub = makeHub()
  const ws = fakeSocket()
  hub.handleConnection(ws)
  ws.emit('message', JSON.stringify({ ...BIND, apiProtocol: 99 }))
  await tick()
  assert.equal(ws.closed[0].code, CLOSE_BAD_PROTOCOL)
})

test('a request is correlated with its response by id', async () => {
  const hub = makeHub()
  const ws = fakeSocket()
  hub.handleConnection(ws)
  ws.emit('message', JSON.stringify(BIND))
  await tick()
  const conn = hub.get('alice', 'd1')
  const pending = hub.request(conn, 'state', { since: 2 })
  const sent = ws.sent.at(-1)
  assert.equal(sent.t, 'request')
  assert.equal(sent.endpoint, 'state')
  ws.emit('message', JSON.stringify({ t: 'response', id: sent.id, result: { ok: true, value: { revision: 2 } } }))
  assert.deepEqual(await pending, { ok: true, value: { revision: 2 } })
})

test('a second connection for the same device replaces the first with 4002', async () => {
  const hub = makeHub()
  const first = fakeSocket()
  hub.handleConnection(first)
  first.emit('message', JSON.stringify(BIND))
  await tick()
  const second = fakeSocket()
  hub.handleConnection(second)
  second.emit('message', JSON.stringify(BIND))
  await tick()
  assert.equal(first.closed[0].code, CLOSE_DUPLICATE_DEVICE)
  assert.equal(hub.devicesFor('alice').length, 1)
})

test('feed clients share one subscription and get every event', async () => {
  const hub = makeHub()
  const ws = fakeSocket()
  hub.handleConnection(ws)
  ws.emit('message', JSON.stringify(BIND))
  await tick()
  const conn = hub.get('alice', 'd1')
  const a = { chunks: [], write(text) { this.chunks.push(text) }, end() {} }
  const b = { chunks: [], write(text) { this.chunks.push(text) }, end() {} }
  const stopA = hub.addFeedClient(conn, a)
  hub.addFeedClient(conn, b)
  assert.equal(ws.sent.filter(message => message.t === 'feed-subscribe').length, 1)
  ws.emit('message', JSON.stringify({ t: 'feed-event', sub: 'd1', event: 'live', data: { x: 1 } }))
  assert.equal(a.chunks[0], 'event: live\ndata: {"x":1}\n\n')
  assert.equal(b.chunks[0], 'event: live\ndata: {"x":1}\n\n')
  stopA()
  assert.equal(ws.sent.filter(message => message.t === 'feed-unsubscribe').length, 0)
})

test('a disconnected device rejects pending requests', async () => {
  const hub = makeHub()
  const ws = fakeSocket()
  hub.handleConnection(ws)
  ws.emit('message', JSON.stringify(BIND))
  await tick()
  const conn = hub.get('alice', 'd1')
  const pending = hub.request(conn, 'state', {})
  ws.emit('close')
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'relay/offline')
  assert.deepEqual(hub.devicesFor('alice'), [])
})
