// The registry of desktops and their one WebSocket each. A phone's request becomes a
// `request` frame; the desktop's answer settles the pending promise by id. Feed events fan
// out to every SSE client of that device.
import { randomUUID } from 'node:crypto'
import { CLOSE_BAD_PROTOCOL, CLOSE_BAD_TOKEN, CLOSE_DUPLICATE_DEVICE, MSG, RELAY_PROTOCOL } from './protocol.js'

const OPEN = 1

export class Hub {
  constructor({ verifyToken, requestTimeoutMs, pingMs, pongTimeoutMs, bindTimeoutMs, logger = console }) {
    this.verifyToken = verifyToken
    this.requestTimeoutMs = requestTimeoutMs
    this.pingMs = pingMs
    this.pongTimeoutMs = pongTimeoutMs
    this.bindTimeoutMs = bindTimeoutMs
    this.logger = logger
    // username -> Map<deviceId, conn>
    this.byUser = new Map()
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

  handleConnection(ws) {
    const conn = {
      ws,
      bound: false,
      username: '',
      deviceId: '',
      name: '',
      version: '',
      apiProtocol: 0,
      pending: new Map(),
      feedClients: new Set(),
      feedSubscribed: false,
      lastSeen: Date.now(),
      timers: {},
      cleaned: false,
    }
    const bindTimer = setTimeout(() => {
      if (!conn.bound) this.close(conn, CLOSE_BAD_TOKEN, 'bind timeout')
    }, this.bindTimeoutMs)
    bindTimer.unref?.()
    conn.timers.bind = bindTimer

    ws.on('message', (data) => { void this.onMessage(conn, data) })
    ws.on('close', () => this.cleanup(conn))
    ws.on('error', () => this.cleanup(conn))
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

  async bind(conn, message) {
    const accessToken = typeof message.accessToken === 'string' ? message.accessToken : ''
    const deviceId = typeof message.deviceId === 'string' && message.deviceId !== '' ? message.deviceId : ''
    if (accessToken === '' || deviceId === '') {
      this.close(conn, CLOSE_BAD_TOKEN, 'missing identity')
      return
    }
    if (message.apiProtocol !== RELAY_PROTOCOL) {
      this.close(conn, CLOSE_BAD_PROTOCOL, 'protocol mismatch')
      return
    }
    let user
    try {
      user = await this.verifyToken(accessToken)
    } catch (error) {
      this.logger.warn?.('[relay] verify failed', error?.message ?? error)
      this.close(conn, CLOSE_BAD_TOKEN, 'verify unavailable')
      return
    }
    if (user === null || user === undefined) {
      this.close(conn, CLOSE_BAD_TOKEN, 'bad token')
      return
    }
    // Two binds can race on one socket; the first wins.
    if (conn.bound) return
    clearTimeout(conn.timers.bind)
    conn.timers.bind = undefined
    conn.bound = true
    conn.username = user.username
    conn.deviceId = deviceId
    conn.name = typeof message.name === 'string' && message.name !== '' ? message.name : deviceId
    conn.version = typeof message.version === 'string' ? message.version : ''
    conn.apiProtocol = message.apiProtocol

    const devices = this.byUser.get(user.username) ?? new Map()
    const previous = devices.get(deviceId)
    if (previous !== undefined && previous !== conn) {
      this.close(previous, CLOSE_DUPLICATE_DEVICE, 'replaced')
      this.cleanup(previous)
    }
    devices.set(deviceId, conn)
    this.byUser.set(user.username, devices)
    this.send(conn, { t: MSG.bound, deviceId })
    this.startPing(conn)
    this.logger.info?.(`[relay] bound ${user.username}/${deviceId} v${conn.version || '?'}`)
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
    conn.pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.resolve(message.result)
  }

  fanout(conn, message) {
    const text = `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`
    for (const res of conn.feedClients) {
      try { res.write(text) } catch { conn.feedClients.delete(res) }
    }
  }

  request(conn, endpoint, payload) {
    if (conn === undefined || conn.bound !== true || conn.ws.readyState !== OPEN) {
      return Promise.reject(Object.assign(new Error('Device offline'), { code: 'relay/offline' }))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id)
        reject(Object.assign(new Error('Device did not answer'), { code: 'relay/timeout' }))
      }, this.requestTimeoutMs)
      timer.unref?.()
      conn.pending.set(id, { resolve, timer })
      if (!this.send(conn, { t: MSG.request, id, endpoint, payload })) {
        conn.pending.delete(id)
        clearTimeout(timer)
        reject(Object.assign(new Error('Device offline'), { code: 'relay/offline' }))
      }
    })
  }

  // One subscription per desktop; every phone feed for that device receives the same events.
  addFeedClient(conn, res) {
    conn.feedClients.add(res)
    if (!conn.feedSubscribed) {
      conn.feedSubscribed = true
      this.send(conn, { t: MSG.feedSubscribe, sub: conn.deviceId })
    }
    return () => {
      conn.feedClients.delete(res)
      if (conn.feedClients.size === 0 && conn.feedSubscribed) {
        conn.feedSubscribed = false
        this.send(conn, { t: MSG.feedUnsubscribe })
      }
    }
  }

  cleanup(conn) {
    if (conn.cleaned) return
    conn.cleaned = true
    clearTimeout(conn.timers.bind)
    clearInterval(conn.timers.ping)
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error: { code: 'relay/offline', message: 'Device disconnected', details: {} } })
    }
    conn.pending.clear()
    for (const res of conn.feedClients) {
      try { res.end() } catch { /* already closed */ }
    }
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
