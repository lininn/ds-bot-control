import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hub } from '../src/connector.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

class FakeSocket {
  constructor() {
    this.readyState = 1
    this.sent = []
    this.listeners = new Map()
  }

  on(name, listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]) }
  send(text) { this.sent.push(JSON.parse(text)) }
  close(code) { this.closed = code; this.readyState = 3 }
  emit(name, value) { for (const listener of this.listeners.get(name) ?? []) listener(value) }
}

const RECORD = { username: 'alice', deviceId: 'd1', machineId: 'm1', tokenHash: 'hash', name: 'My Mac' }

function connectedHub(options = {}) {
  const hub = new Hub({
    verifyDevice: async () => ({ record: RECORD }),
    requestTimeoutMs: 1_000,
    pingMs: 1e9,
    pongTimeoutMs: 1e9,
    bindTimeoutMs: 1e9,
    sseMaxBytes: 1_000,
    logger: { info() {}, warn() {} },
    ...options,
  })
  const ws = new FakeSocket()
  hub.handleConnection(ws)
  ws.emit('message', JSON.stringify({ t: 'bind', deviceToken: 'good', deviceId: 'd1', machineId: 'm1', name: 'My Mac', version: '0.2.7', apiProtocol: 2 }))
  return { hub, ws, ready: tick().then(() => hub.get('alice', 'd1')) }
}

function slowResponse() {
  const response = {
    chunks: [],
    ended: false,
    blocked: true,
    drain: undefined,
    write(text) {
      this.chunks.push(text)
      if (this.blocked) { this.blocked = false; return false }
      return true
    },
    end() { this.ended = true },
    once(name, listener) { if (name === 'drain') this.drain = listener },
  }
  return response
}

test('a slow feed keeps events in a bounded queue until the socket drains', async () => {
  const { hub, ws, ready } = connectedHub()
  const conn = await ready
  const response = slowResponse()
  const stop = hub.addFeedClient(conn, response, { sessionHash: 's1' })
  assert.equal(typeof stop, 'function')
  ws.emit('message', JSON.stringify({ t: 'feed-event', sub: 'd1', event: 'one', data: { n: 1 } }))
  ws.emit('message', JSON.stringify({ t: 'feed-event', sub: 'd1', event: 'two', data: { n: 2 } }))
  assert.equal(response.chunks.length, 1)
  response.drain()
  assert.equal(response.chunks.length, 2)
  assert.match(response.chunks[1], /event: two/)
  stop()
})

test('a feed that exceeds its byte budget is ended and unsubscribed', async () => {
  const { hub, ws, ready } = connectedHub({ sseMaxBytes: 50 })
  const conn = await ready
  const response = slowResponse()
  hub.addFeedClient(conn, response, { sessionHash: 's1' })
  ws.emit('message', JSON.stringify({ t: 'feed-event', sub: 'd1', event: 'one', data: { text: 'x'.repeat(100) } }))
  ws.emit('message', JSON.stringify({ t: 'feed-event', sub: 'd1', event: 'two', data: { text: 'y'.repeat(100) } }))
  assert.equal(response.ended, true)
  assert.equal(ws.sent.filter(message => message.t === 'feed-unsubscribe').length, 1)
})

test('signing out closes only that session’s live feeds', async () => {
  const { hub, ready } = connectedHub()
  const conn = await ready
  const mine = slowResponse()
  const other = slowResponse()
  hub.addFeedClient(conn, mine, { sessionHash: 'mine' })
  hub.addFeedClient(conn, other, { sessionHash: 'other' })
  hub.closeSessionFeeds('mine')
  assert.equal(mine.ended, true)
  assert.equal(other.ended, false)
})
