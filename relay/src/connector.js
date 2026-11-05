// The registry of desktops and their one WebSocket each. A phone's request becomes a
// `request` frame; the desktop's answer settles the pending promise by id. Feed events fan
// out to every SSE client of that device, with a bounded queue so a phone that stops reading
// cannot grow the relay's memory without limit.
import { randomUUID } from 'node:crypto'
import { CLOSE_BAD_PROTOCOL, CLOSE_BAD_TOKEN, CLOSE_DUPLICATE_DEVICE, MSG, RELAY_PROTOCOL } from './protocol.js'

const OPEN = 1
const CLOSE_LIMIT = 1013
const CLOSE_POLICY = 1008

export class Hub {
  constructor({
    verifyDevice,
    requestTimeoutMs,
    pingMs,
    pongTimeoutMs,
    bindTimeoutMs,
    maxPerUser = 10,
    maxConnectors = 1000,
    maxUnbound = 2000,
    maxUnboundPerIp = 100,
    wsFramesPerSecond = 100,
    sseMaxPerDevice = 4,
    sseMaxBytes = 4 * 1024 * 1024,
    sseBlockedMs = 30_000,
    logger = console,
  }) {
    this.verifyDevice = verifyDevice
    this.requestTimeoutMs = requestTimeoutMs
    this.pingMs = pingMs
    this.pongTimeoutMs = pongTimeoutMs
    this.bindTimeoutMs = bindTimeoutMs
    this.maxPerUser = maxPerUser
    this.maxConnectors = maxConnectors
    this.maxUnbound = maxUnbound
    this.maxUnboundPerIp = maxUnboundPerIp
    this.wsFramesPerSecond = wsFramesPerSecond
    this.sseMaxPerDevice = sseMaxPerDevice
    this.sseMaxBytes = sseMaxBytes
    this.sseBlockedMs = sseBlockedMs
    this.logger = logger
    // username -> Map<deviceId, conn>
    this.byUser = new Map()
    this.total = 0
    this.unbound = new Set()
    this.unboundByIp = new Map()
  }

  devicesFor(username) {
    const devices = this.byUser.get(username)
    if (devices === undefined) return []
    return [...devices.values()].map(conn => ({
      deviceId: conn.deviceId,
      name: conn.name,
      version: conn.version,
      apiProtocol: conn.apiProtocol,
    }))
  }

  get(username, deviceId) {
    return this.byUser.get(username)?.get(deviceId)
  }

  handleConnection(ws, { ip = 'unknown' } = {}) {
    if (this.total >= this.maxConnectors) {
      try { ws.close(CLOSE_LIMIT, 'relay is full') } catch { /* already closing */ }
      return
    }
    const pendingForIp = this.unboundByIp.get(ip) ?? 0
    if (this.unbound.size >= this.maxUnbound || pendingForIp >= this.maxUnboundPerIp) {
      try { ws.close(CLOSE_LIMIT, 'too many unbound connections') } catch { /* already closing */ }
      return
    }
    const now = Date.now()
    const conn = {
      ws,
      ip,
      bound: false,
      username: '',
      deviceId: '',
      name: '',
      version: '',
      apiProtocol: 0,
      pending: new Map(),
      feedClients: new Set(),
      feedSubscribed: false,
      lastSeen: now,
      // 100 frames per second, refilled by elapsed time. A non-browser client cannot make
      // the relay parse an unbounded JSON stream.
      frames: { tokens: this.wsFramesPerSecond, at: now },
      timers: {},
      cleaned: false,
    }
    this.total += 1
    this.unbound.add(conn)
    this.unboundByIp.set(ip, pendingForIp + 1)
    const bindTimer = setTimeout(() => {
      if (!conn.bound) this.close(conn, CLOSE_BAD_TOKEN, 'bind timeout')
    }, this.bindTimeoutMs)
    bindTimer.unref?.()
    conn.timers.bind = bindTimer

    ws.on('message', (data) => {
      if (!this.takeFrame(conn)) return
      void this.onMessage(conn, data)
    })
    ws.on('close', () => this.cleanup(conn))
    ws.on('error', () => this.cleanup(conn))
  }

  takeFrame(conn) {
    const now = Date.now()
    const elapsed = Math.max(0, now - conn.frames.at) / 1000
    conn.frames.at = now
    conn.frames.tokens = Math.min(this.wsFramesPerSecond, conn.frames.tokens + elapsed * this.wsFramesPerSecond)
    if (conn.frames.tokens < 1) {
      this.close(conn, CLOSE_POLICY, 'frame rate exceeded')
      this.cleanup(conn)
      return false
    }
    conn.frames.tokens -= 1
    return true
  }

  async onMessage(conn, data) {
    let message
    try {
      message = JSON.parse(typeof data === 'string' ? data : data.toString())
    } catch { return }
    if (!conn.bound) {
      if (message?.t === MSG.bind) await this.bind(conn, message)
      return
    }
    switch (message?.t) {
      case MSG.response: this.settle(conn, message); break
      case MSG.pong: conn.lastSeen = Date.now(); break
      case MSG.ping: this.send(conn, { t: MSG.pong, at: message.at }); break
      case MSG.feedEvent: this.fanout(conn, message); break
      default: break
    }
  }

  send(conn, message) {
    if (conn.ws.readyState !== OPEN) return false
    try { conn.ws.send(JSON.stringify(message)); return true } catch { return false }
  }

  close(conn, code, reason = '') {
    try { conn.ws.close(code, reason) } catch { /* already closing */ }
  }

  releaseUnbound(conn) {
    if (!this.unbound.delete(conn)) return
    const count = (this.unboundByIp.get(conn.ip) ?? 1) - 1
    if (count <= 0) this.unboundByIp.delete(conn.ip)
    else this.unboundByIp.set(conn.ip, count)
  }

  async bind(conn, message) {
    // A v1 connector has the old access-token shape. Refuse before looking at any token.
    if (message.apiProtocol !== RELAY_PROTOCOL) {
      this.close(conn, CLOSE_BAD_PROTOCOL, 'protocol mismatch; update the desktop app')
      return
    }
    const token = typeof message.deviceToken === 'string' ? message.deviceToken : ''
    const deviceId = typeof message.deviceId === 'string' && message.deviceId !== '' ? message.deviceId : ''
    const machineId = typeof message.machineId === 'string' ? message.machineId : ''
    if (token === '' || deviceId === '' || machineId === '') {
      this.close(conn, CLOSE_BAD_TOKEN, 'missing device credential')
      return
    }
    let verified
    try {
      verified = await this.verifyDevice(token, deviceId, machineId)
    } catch (error) {
      this.logger.warn?.('[relay] device verification failed', error?.message ?? error)
      this.close(conn, CLOSE_BAD_TOKEN, 'verify unavailable')
      return
    }
    if (verified === null || verified?.record === undefined) {
      const duplicate = verified?.error === 'duplicate'
      this.close(conn, duplicate ? CLOSE_DUPLICATE_DEVICE : CLOSE_BAD_TOKEN, duplicate ? 'device id in use' : 'bad device credential')
      return
    }
    // Two binds can race on one socket; the first wins.
    if (conn.bound) return
    const record = verified.record
    const devices = this.byUser.get(record.username) ?? new Map()
    const previous = devices.get(deviceId)
    if (previous !== undefined && previous !== conn) {
      // The same credential is a reconnect: replace the stale socket. The registry refuses a
      // different machine/token for an existing device before we get here.
      this.close(previous, CLOSE_DUPLICATE_DEVICE, 'replaced')
      this.cleanup(previous)
    } else if (devices.size >= this.maxPerUser) {
      this.close(conn, CLOSE_LIMIT, 'too many connectors for this account')
      return
    }
    clearTimeout(conn.timers.bind)
    conn.timers.bind = undefined
    conn.bound = true
    conn.username = record.username
    conn.deviceId = deviceId
    conn.name = typeof message.name === 'string' && message.name !== '' ? message.name : record.name ?? deviceId
    conn.version = typeof message.version === 'string' ? message.version : ''
    conn.apiProtocol = message.apiProtocol
    conn.machineId = machineId
    conn.tokenHash = record.tokenHash
    this.releaseUnbound(conn)

    devices.set(deviceId, conn)
    this.byUser.set(record.username, devices)
    this.send(conn, { t: MSG.bound, deviceId })
    this.startPing(conn)
    this.logger.info?.(`[relay] bound ${record.username}/${deviceId} v${conn.version || '?'}`)
  }

  startPing(conn) {
    conn.timers.ping = setInterval(() => {
      if (Date.now() - conn.lastSeen > this.pongTimeoutMs) {
        this.logger.warn?.(`[relay] ${conn.deviceId} silent; closing`)
        this.close(conn, 1001, 'timeout')
        this.cleanup(conn)
        return
      }
      this.send(conn, { t: MSG.ping, at: Date.now() })
    }, this.pingMs)
    conn.timers.ping.unref?.()
  }

  settle(conn, message) {
    const pending = conn.pending.get(message.id)
    if (pending === undefined) return
    this.finishPending(conn, message.id, message.result)
  }

  finishPending(conn, id, value) {
    const pending = conn.pending.get(id)
    if (pending === undefined) return
    conn.pending.delete(id)
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener?.('abort', pending.abort)
    pending.resolve(value)
  }

  fanout(conn, message) {
    // A connector may only publish to its own device; a crafted `sub` must not reach another
    // account's phones.
    if (message.sub !== conn.deviceId) return
    const text = `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`
    for (const client of conn.feedClients) this.writeFeed(client, text)
  }

  writeFeed(client, text) {
    if (client.closed) return
    const size = Buffer.byteLength(text)
    if (client.blockedAt !== null) {
      this.enqueueFeed(client, text, size)
      return
    }
    let accepted
    try { accepted = client.res.write(text) } catch { this.closeFeed(client); return }
    if (accepted === false) {
      client.blockedAt = Date.now()
      client.bytes += size
      client.blockedTimer = setTimeout(() => this.closeFeed(client), this.sseBlockedMs)
      client.blockedTimer.unref?.()
    }
  }

  enqueueFeed(client, text, size) {
    if (client.bytes + size > this.sseMaxBytes) {
      this.closeFeed(client)
      return
    }
    client.queue.push(text)
    client.bytes += size
  }

  flushFeed(client) {
    if (client.closed) return
    client.blockedAt = null
    if (client.blockedTimer !== undefined) clearTimeout(client.blockedTimer)
    client.blockedTimer = undefined
    while (client.queue.length > 0) {
      const text = client.queue.shift()
      client.bytes -= Buffer.byteLength(text)
      let accepted
      try { accepted = client.res.write(text) } catch { this.closeFeed(client); return }
      if (accepted === false) {
        client.blockedAt = Date.now()
        client.blockedTimer = setTimeout(() => this.closeFeed(client), this.sseBlockedMs)
        client.blockedTimer.unref?.()
        return
      }
    }
    client.bytes = 0
  }

  closeFeed(client) {
    if (client.closed) return
    client.closed = true
    if (client.blockedTimer !== undefined) clearTimeout(client.blockedTimer)
    client.queue.length = 0
    client.bytes = 0
    try { client.res.end() } catch { /* already closed */ }
    client.conn.feedClients.delete(client)
    if (client.conn.feedClients.size === 0 && client.conn.feedSubscribed) {
      client.conn.feedSubscribed = false
      this.send(client.conn, { t: MSG.feedUnsubscribe })
    }
  }

  // One subscription per desktop; every phone feed for that device receives the same events.
  addFeedClient(conn, res, { sessionHash = '' } = {}) {
    if (conn === undefined || conn.bound !== true) return null
    if (conn.feedClients.size >= this.sseMaxPerDevice) return null
    const client = {
      conn,
      res,
      sessionHash,
      queue: [],
      bytes: 0,
      blockedAt: null,
      blockedTimer: undefined,
      closed: false,
    }
    conn.feedClients.add(client)
    res.once?.('drain', () => this.flushFeed(client))
    if (!conn.feedSubscribed) {
      conn.feedSubscribed = true
      this.send(conn, { t: MSG.feedSubscribe, sub: conn.deviceId })
    }
    return () => this.closeFeed(client)
  }

  closeSessionFeeds(sessionHash) {
    for (const conn of this.allConnections()) {
      for (const client of conn.feedClients) {
        if (client.sessionHash === sessionHash) this.closeFeed(client)
      }
    }
  }

  *allConnections() {
    for (const devices of this.byUser.values()) for (const conn of devices.values()) yield conn
  }

  request(conn, endpoint, payload, { signal } = {}) {
    if (conn === undefined || conn.bound !== true || conn.ws.readyState !== OPEN) {
      return Promise.reject(Object.assign(new Error('Device offline'), { code: 'relay/offline' }))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (value, error) => {
        if (settled) return
        settled = true
        if (error === undefined) resolve(value)
        else reject(error)
      }
      const timer = setTimeout(() => {
        conn.pending.delete(id)
        finish(undefined, Object.assign(new Error('Device did not answer'), { code: 'relay/timeout' }))
      }, this.requestTimeoutMs)
      timer.unref?.()
      const abort = () => {
        if (settled) return
        conn.pending.delete(id)
        clearTimeout(timer)
        // v2 only: tell the desktop to stop work it may still be doing.
        this.send(conn, { t: MSG.cancel, id })
        finish(undefined, Object.assign(new Error('Request cancelled'), { code: 'relay/cancelled' }))
      }
      const pending = { resolve: value => finish(value), timer, signal, abort }
      conn.pending.set(id, pending)
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener?.('abort', abort, { once: true })
      if (!this.send(conn, { t: MSG.request, id, endpoint, payload })) {
        conn.pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', abort)
        finish(undefined, Object.assign(new Error('Device offline'), { code: 'relay/offline' }))
      }
    })
  }

  // A revoked device is dropped and its phones are told the feed is over, rather than
  // leaving them waiting on a socket that will never answer again.
  revokeDevice(username, deviceId) {
    const conn = this.get(username, deviceId)
    if (conn !== undefined) {
      this.close(conn, CLOSE_BAD_TOKEN, 'device revoked')
      this.cleanup(conn)
    }
  }

  cleanup(conn) {
    if (conn.cleaned) return
    conn.cleaned = true
    this.total = Math.max(0, this.total - 1)
    this.releaseUnbound(conn)
    clearTimeout(conn.timers.bind)
    clearInterval(conn.timers.ping)
    for (const [id, pending] of conn.pending) {
      clearTimeout(pending.timer)
      pending.signal?.removeEventListener?.('abort', pending.abort)
      pending.resolve({ ok: false, error: { code: 'relay/offline', message: 'Device disconnected', details: {} } })
      conn.pending.delete(id)
    }
    for (const client of [...conn.feedClients]) this.closeFeed(client)
    conn.feedClients.clear()
    if (conn.bound) {
      const devices = this.byUser.get(conn.username)
      if (devices?.get(conn.deviceId) === conn) {
        devices.delete(conn.deviceId)
        if (devices.size === 0) this.byUser.delete(conn.username)
      }
    }
    conn.bound = false
  }
}
