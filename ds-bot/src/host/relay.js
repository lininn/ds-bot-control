// Remote control: the connector the desktop app runs so a phone, signed in on the relay's
// website, can drive this machine's team. It holds one outbound WebSocket to the relay and
// turns the relay's requests into calls on the Bot API in this process, so a phone never
// needs the local DSH cookie.
//
// The user turns this on in Settings → Remote control: they paste the relay address, sign in
// with a blog account, and the relay-issued device credential is kept in <home>/relay.json.
// The `relay` key of the plugin config is optional and only supplies defaults:
//   { enabled?: boolean, url?: string, token?: string, deviceName?: string }
// `enabled: false` (or `relay: false`) hides the feature; a config `token` is a fallback for
// a deployment that pairs machines without the settings page.
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOSE_BAD_PROTOCOL, CLOSE_BAD_TOKEN, CLOSE_DUPLICATE_DEVICE, MSG, RELAY_PROTOCOL, isForbiddenEndpoint } from '../shared/relay-protocol.js'

const require = createRequire(import.meta.url)
const VERSION = require('../../package.json').version

const OPEN = 1
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
// The relay pings every 15 s and drops a connector it has not heard from in 45 s. A socket
// can still go silent without ever emitting `close` (a half-open connection, a dead proxy),
// so the connector reconnects itself after this much silence instead of waiting for the OS.
const IDLE_WATCHDOG_MS = 60_000
// A TCP/TLS handshake that never completes (a black-holed proxy, a host that accepts and then
// says nothing) leaves the socket in CONNECTING forever, so the connector gives up and retries.
const CONNECT_TIMEOUT_MS = 20_000
// A duplicate device id means another host is running with the same relay.json. Backing off
// this far keeps the two from fighting over the id; a manual reconnect still tries at once.
const OCCUPIED_BACKOFF_ATTEMPT = 10

// The device's relay state lives in one file under the team's home: the id that pairs this
// machine across restarts, and the relay-issued device credential. `relay.json` is readable
// by the owner only. It deliberately does not store the blog access token, and the machine
// id in it is never used to bind: that is recomputed at every start.
export const RELAY_FILE = 'relay.json'

// Where a fresh install points by default; `relay.url` or DS_BOT_RELAY_URL overrides it, and
// the settings page can change it. A deployment that runs its own relay sets one of those.
export const DEFAULT_RELAY_URL = 'https://ds.d-1.top'

export function readRelayFile(home) {
  try {
    const saved = JSON.parse(readFileSync(join(home, RELAY_FILE), 'utf8'))
    if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) return saved
  } catch { /* first run, or an unreadable file */ }
  return {}
}

export function saveRelayFile(home, saved) {
  try {
    mkdirSync(home, { recursive: true })
    const target = join(home, RELAY_FILE)
    writeFileSync(target, JSON.stringify(saved, null, 2), { mode: 0o600 })
    chmodSync(target, 0o600)
  } catch { /* keep it in memory; the settings page still works this run */ }
  return saved
}

// A base URL the user pasted may be http(s) or ws(s); the connector needs the socket URL
// and the desktop sign-in needs the HTTP one. Both are derived from the same origin.
export function relayUrls(base) {
  const url = String(base ?? '').trim().replace(/\/+$/, '')
  if (url === '') return undefined
  const socketBase = /^wss?:\/\//i.test(url) ? url : /^https?:\/\//i.test(url) ? url.replace(/^http/i, 'ws') : undefined
  if (socketBase === undefined) return undefined
  // The pasted address may already name the socket endpoint; strip it for the HTTP side.
  const httpBase = socketBase.replace(/^ws/i, 'http').replace(/\/connector$/, '')
  const socket = socketBase.endsWith('/connector') ? socketBase : `${socketBase}/connector`
  return { socket, login: `${httpBase}/api/desktop/login` }
}

// A stable fingerprint of this machine, computed at every start and sent with bind. It is
// never read from relay.json, so copying that file to another computer does not copy the
// machine identity. Platform UUIDs are preferred; the fallback hashes the hostname and the
// first non-internal MAC address, which differs on a real second machine.
export function detectMachineId() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 2_000 })
      const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1]
      if (uuid !== undefined && uuid !== '') return uuid
    }
    if (process.platform === 'linux') {
      const id = readFileSync('/etc/machine-id', 'utf8').trim()
      if (id !== '') return id
    }
  } catch { /* fall through to the host fingerprint */ }
  const macs = []
  const interfaces = networkInterfaces()
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal === false && typeof address.mac === 'string' && address.mac !== '') macs.push(address.mac)
    }
  }
  const material = [process.platform, process.arch, hostname(), ...macs.sort()].join('|')
  return `sha256:${createHash('sha256').update(material).digest('hex')}`
}

// macOS calls a Mac with no DNS name `bogon`, which is what `hostname()` returns; the name in
// System Settings is the one the person recognizes and the one the phone's device picker shows.
export function computerName() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2_000 }).trim()
      if (out !== '') return out
    }
    if (process.platform === 'win32' && process.env.COMPUTERNAME) return process.env.COMPUTERNAME
  } catch { /* fall back to the hostname */ }
  return hostname()
}

// The relay connector and the settings page share this controller. `login` asks the relay
// for the account's access token, `logout` forgets it, and either restarts the socket.
export function createRelayController({
  home,
  config = {},
  handle,
  subscribeFeed,
  version = VERSION,
  apiProtocol = RELAY_PROTOCOL,
  defaultDeviceName = computerName,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  logger = console,
  random = Math.random,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  env = process.env,
  defaultUrl = DEFAULT_RELAY_URL,
  // Why this host cannot change the team, or undefined when it owns it (store.js `readOnly`).
  // Only the owner runs the connector: a copy of the team opened in a second window must not
  // bind the same device id and take turns kicking the real owner offline.
  readOnly = () => undefined,
  // The machine this file belongs to, used to rotate a pairing id that was copied here.
  machineId = detectMachineId,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
}) {
  let saved = readRelayFile(home)
  let connector
  // Both platform lookups are deferred and memoised: a person who never turns on remote control
  // should not pay for an `ioreg`/`scutil` call on every start.
  let resolvedName
  let resolvedMachine
  const defaultName = () => {
    if (resolvedName !== undefined) return resolvedName
    const value = typeof defaultDeviceName === 'function' ? defaultDeviceName() : defaultDeviceName
    resolvedName = typeof value === 'string' && value !== '' ? value : hostname()
    return resolvedName
  }
  const machine = () => {
    if (resolvedMachine !== undefined) return resolvedMachine
    const value = typeof machineId === 'function' ? machineId() : machineId
    resolvedMachine = typeof value === 'string' ? value : ''
    return resolvedMachine
  }
  // Resolved on first use, never at load, so merely opening the team writes nothing. The
  // device id is the local handle a person recognizes; the relay decides whether the current
  // machine may use it by comparing the runtime machine id at bind.
  const deviceId = () => {
    if (typeof saved.deviceId === 'string' && saved.deviceId !== '') return saved.deviceId
    saved = saveRelayFile(home, { ...saved, deviceId: randomUUID() })
    return saved.deviceId
  }

  // A saved address beats the profile, the environment and the built-in default, in that order.
  // An empty string at any level is "not set", so a blank DS_BOT_RELAY_URL cannot hide the default.
  const urlAt = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  const configuredUrl = () => urlAt(saved.url) ?? urlAt(config.url) ?? urlAt(env.DS_BOT_RELAY_URL) ?? urlAt(defaultUrl) ?? ''
  // A logout sets `disabled`, which opts out of a credential that a profile config still carries.
  const token = () => {
    if (saved.disabled === true) return ''
    if (typeof saved.deviceToken === 'string' && saved.deviceToken !== '') return saved.deviceToken
    return typeof config.token === 'string' ? config.token : ''
  }
  const storedName = () => (typeof saved.deviceName === 'string' && saved.deviceName !== '' ? saved.deviceName : '')
  const deviceName = () => {
    const name = storedName()
    if (name !== '') {
      // A name written before this build is the OS hostname (`bogon` on an offline Mac);
      // replace just that placeholder with the computer name and write it once.
      const fallback = defaultName()
      if (name === hostname() && fallback !== hostname()) {
        saved = saveRelayFile(home, { ...saved, deviceName: fallback })
        return saved.deviceName
      }
      return name
    }
    if (typeof config.deviceName === 'string' && config.deviceName !== '') return config.deviceName
    return defaultName()
  }

  const locked = () => readOnly() !== undefined

  const reconnector = () => {
    connector?.stop()
    connector = undefined
    // Another host owns the team; it runs the connector. This one shows why instead.
    if (locked()) return
    const target = relayUrls(configuredUrl())
    if (target === undefined || token() === '') return
    connector = createConnector({
      url: target.socket,
      token: token(),
      deviceName: deviceName(),
      version,
      apiProtocol,
      deviceId: deviceId(),
      machineId: machine(),
      handle,
      subscribeFeed,
      WebSocketImpl,
      logger,
      random,
      setTimeoutImpl,
      clearTimeoutImpl,
      connectTimeoutMs,
    })
    connector.start()
  }

  // What the settings page shows: `connected`, `connecting`, `reconnecting`, `occupied` (this
  // device id is live in another host), `expired` (the relay rejected the token), `read-only`
  // (another dsh owns this team) or `idle` (not signed in, or switched off).
  const relayState = () => {
    if (locked()) return 'read-only'
    if (token() === '' || relayUrls(configuredUrl()) === undefined) return 'idle'
    return connector?.state ?? 'idle'
  }

  const status = () => ({
    configured: relayUrls(configuredUrl()) !== undefined,
    bound: token() !== '',
    username: typeof saved.username === 'string' ? saved.username : '',
    url: configuredUrl(),
    deviceName: deviceName(),
    relayConnected: connector?.connected === true,
    state: relayState(),
  })

  const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

  return {
    status,
    async login({ username, password, url } = {}) {
      const name = typeof username === 'string' ? username.trim() : ''
      const secret = typeof password === 'string' ? password : ''
      if (name === '' || secret === '') throw invalid('Enter your account and password')
      if (typeof url === 'string' && url.trim() !== '') saved = { ...saved, url: url.trim().replace(/\/+$/, '') }
      const target = relayUrls(configuredUrl())
      if (target === undefined) throw invalid('Enter the relay address first')
      let response
      try {
        response = await fetchImpl(target.login, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: name, password: secret, deviceId: deviceId(), machineId: machine(), name: deviceName() }),
          signal: AbortSignal.timeout(20_000),
        })
      } catch {
        throw invalid('Could not reach the relay. Check the address and that it is running.')
      }
      let data
      try { data = await response.json() } catch { data = null }
      if (data?.status === true && typeof data.deviceToken === 'string' && data.deviceToken !== '') {
        // Drop any old access token and recorded machine id from a previous build.
        const { token: _oldToken, machineId: _oldMachine, ...rest } = saved
        saved = saveRelayFile(home, {
          ...rest,
          url: configuredUrl(),
          deviceToken: data.deviceToken,
          deviceId: typeof data.deviceId === 'string' && data.deviceId !== '' ? data.deviceId : deviceId(),
          username: typeof data.user?.username === 'string' ? data.user.username : name,
          deviceName: deviceName(),
          disabled: false,
        })
        reconnector()
        return status()
      }
      throw invalid(typeof data?.message === 'string' && data.message !== '' ? data.message : 'Sign-in failed')
    },
    logout() {
      connector?.stop()
      connector = undefined
      const { token: _oldToken, deviceToken: _oldDeviceToken, machineId: _oldMachine, ...rest } = saved
      saved = saveRelayFile(home, { ...rest, username: '', disabled: true })
      return status()
    },
    start: reconnector,
    // A manual retry from the settings page: drops the current socket and any backoff, then
    // dials again. It is how a host that was `occupied` recovers as soon as the other one quits.
    reconnect() {
      reconnector()
      return status()
    },
    stop() {
      connector?.stop()
      connector = undefined
    },
  }
}

const REFUSED = { ok: false, error: { code: 'bot/forbidden', message: 'Not available remotely', details: {} } }

// The connector's transport and dispatch loop, separate from install() so tests can drive it
// with a stand-in WebSocket and a plain `handle`.
export function createConnector({
  url,
  token,
  deviceName = hostname(),
  version = VERSION,
  apiProtocol = RELAY_PROTOCOL,
  deviceId,
  machineId = '',
  handle,
  subscribeFeed,
  WebSocketImpl = globalThis.WebSocket,
  logger = console,
  random = Math.random,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  watchdogMs = IDLE_WATCHDOG_MS,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
}) {
  let socket
  let stopped = false
  // Why the connector stopped for good: only a rejected token cannot be retried.
  let stoppedReason = ''
  // The relay said another host already owns this device id. It clears once we bind again.
  let occupied = false
  let attempt = 0
  let retryTimer
  let connectTimer
  let watchdogTimer
  let unsubscribeFeed
  let feedSubscribed = false
  // Requests the relay may still cancel, by id. Aborting passes through to rt.handle.
  const inflight = new Map()

  const send = (message) => {
    if (socket?.readyState !== OPEN) return false
    try { socket.send(JSON.stringify(message)); return true } catch (error) {
      logger?.warn?.('relay send failed', error)
      return false
    }
  }

  const answer = async (message) => {
    const id = message.id
    if (isForbiddenEndpoint(message.endpoint)) {
      send({ t: MSG.response, id, result: REFUSED })
      return
    }
    const entry = { controller: new AbortController(), cancelled: false }
    inflight.set(id, entry)
    let result
    try {
      result = await handle(String(message.endpoint ?? ''), message.payload, entry.controller.signal)
    } catch (error) {
      result = { ok: false, error: { code: error?.code ?? 'bot/error', message: error?.message ?? String(error), details: {} } }
    } finally {
      inflight.delete(id)
    }
    // The phone went away while this was running. Its request was cancelled, so an answer
    // now would be an orphan frame the relay no longer has a promise for.
    if (!entry.cancelled) send({ t: MSG.response, id, result })
  }

  const cancel = (message) => {
    const entry = inflight.get(message.id)
    if (entry === undefined) return
    inflight.delete(message.id)
    entry.cancelled = true
    entry.controller.abort()
  }

  const abortInflight = () => {
    for (const entry of inflight.values()) {
      entry.cancelled = true
      entry.controller.abort()
    }
    inflight.clear()
  }

  const startFeed = (message) => {
    if (feedSubscribed) return
    feedSubscribed = true
    unsubscribeFeed = subscribeFeed((event, data) => send({ t: MSG.feedEvent, sub: message?.sub, event, data }))
  }

  const stopFeed = () => {
    feedSubscribed = false
    unsubscribeFeed?.()
    unsubscribeFeed = undefined
  }

  const onMessage = (event) => {
    let message
    try {
      const text = typeof event?.data === 'string' ? event.data : String(event?.data ?? '')
      message = JSON.parse(text)
    } catch { return }
    switch (message?.t) {
      case MSG.request: void answer(message); break
      case MSG.cancel: cancel(message); break
      case MSG.feedSubscribe: startFeed(message); break
      case MSG.feedUnsubscribe: stopFeed(); break
      case MSG.ping: send({ t: MSG.pong, at: message.at }); break
      case MSG.bound: attempt = 0; occupied = false; break
      default: break
    }
  }

  const scheduleRetry = () => {
    // One pending retry is enough: several close/error/timeout events for the same dead
    // socket must not create a reconnect storm.
    if (stopped || retryTimer !== undefined) return
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 10))
    const delay = cap / 2 + random() * (cap / 2)
    attempt += 1
    retryTimer = setTimeoutImpl(() => {
      retryTimer = undefined
      connect()
    }, delay)
    retryTimer?.unref?.()
  }

  const clearConnectTimer = () => {
    if (connectTimer !== undefined) clearTimeoutImpl(connectTimer)
    connectTimer = undefined
  }

  const clearWatchdog = () => {
    if (watchdogTimer !== undefined) clearTimeoutImpl(watchdogTimer)
    watchdogTimer = undefined
  }

  // Every inbound frame proves the link is alive, so re-arm from zero. A socket that has been
  // replaced or abandoned by the time the timer fires is left alone.
  const armWatchdog = (ws) => {
    clearWatchdog()
    if (stopped || socket !== ws) return
    watchdogTimer = setTimeoutImpl(() => {
      watchdogTimer = undefined
      if (stopped || socket !== ws) return
      logger?.warn?.(`relay silent for ${Math.round(watchdogMs / 1_000)}s; reconnecting`)
      abandon(ws)
    }, watchdogMs)
    watchdogTimer?.unref?.()
  }

  // Retire a socket without waiting for `close`: clear its timer, drop the feed and schedule a
  // retry. The `abandoned` flag makes the later `close` event a no-op so a retry is never
  // scheduled twice for the same connection.
  const abandon = (ws) => {
    if (ws?.abandoned === true) return
    if (ws !== undefined) ws.abandoned = true
    clearConnectTimer()
    clearWatchdog()
    stopFeed()
    if (socket === ws) socket = undefined
    try { ws?.close() } catch { /* already closed */ }
    scheduleRetry()
  }

  function connect() {
    if (stopped) return
    let next
    try {
      next = new WebSocketImpl(url)
    } catch (error) {
      logger?.warn?.('relay connect failed', error)
      scheduleRetry()
      return
    }
    socket = next
    // A handshake that never completes would otherwise sit here forever and never retry.
    clearConnectTimer()
    connectTimer = setTimeoutImpl(() => {
      connectTimer = undefined
      if (stopped || socket !== next || next.readyState === OPEN) return
      logger?.warn?.(`relay did not open within ${Math.round(connectTimeoutMs / 1_000)}s; reconnecting`)
      abandon(next)
    }, connectTimeoutMs)
    connectTimer?.unref?.()
    next.addEventListener?.('open', () => {
      if (socket !== next) return
      clearConnectTimer()
      // A new connection is in; unless the relay says otherwise, we own this id again.
      occupied = false
      armWatchdog(next)
      send({ t: MSG.bind, role: 'connector', kind: 'dsbot', deviceId, machineId, name: deviceName, version, apiProtocol, deviceToken: token })
    })
    next.addEventListener?.('message', (event) => {
      // A socket we already abandoned or replaced must not feed replies into the new one.
      if (socket !== next) return
      armWatchdog(next)
      onMessage(event)
    })
    next.addEventListener?.('close', (event) => {
      if (next.abandoned === true) return
      next.abandoned = true
      clearConnectTimer()
      clearWatchdog()
      stopFeed()
      abortInflight()
      if (socket === next) socket = undefined
      const code = event?.code
      if (code === CLOSE_BAD_TOKEN) {
        // The account's token is wrong or revoked; retrying cannot help until a new sign-in.
        stopped = true
        stoppedReason = 'expired'
        logger?.warn?.('relay rejected the token; sign in again')
        return
      }
      if (code === CLOSE_BAD_PROTOCOL) {
        // The relay and this build speak different protocols; retrying would loop forever
        // until the app is updated. Show that instead of a generic reconnect.
        stopped = true
        stoppedReason = 'incompatible'
        logger?.warn?.('relay rejected the protocol; update DS Bot')
        return
      }
      if (code === CLOSE_DUPLICATE_DEVICE) {
        // Another host is bound with this device id (usually the team folder opened twice).
        // Retry far apart rather than fast, so the two do not take turns kicking each other;
        // the settings page shows "occupied" and offers a manual reconnect.
        occupied = true
        attempt = Math.max(attempt, OCCUPIED_BACKOFF_ATTEMPT)
        logger?.warn?.('relay says this device is in use by another host; waiting')
        scheduleRetry()
        return
      }
      scheduleRetry()
    })
    // A failed handshake sometimes reports `error` without a following `close`; without this
    // the stale socket would stay in place and `start()` would never open a new one.
    next.addEventListener?.('error', () => {
      logger?.warn?.('relay socket errored; reconnecting')
      abandon(next)
    })
  }

  return {
    start() {
      if (!stopped && socket === undefined && retryTimer === undefined) connect()
    },
    stop() {
      stopped = true
      clearConnectTimer()
      clearWatchdog()
      if (retryTimer !== undefined) clearTimeoutImpl(retryTimer)
      retryTimer = undefined
      stopFeed()
      abortInflight()
      // Mark it first so the close event that our own close() triggers does not retry.
      if (socket !== undefined) socket.abandoned = true
      try { socket?.close() } catch { /* already closed */ }
      socket = undefined
    },
    // `connected` is the bound socket; `state` is what the settings page renders. `occupied`
    // outlives a retry wait so a duplicate-id host stays visibly parked instead of flapping.
    get connected() {
      return socket?.readyState === OPEN
    },
    get state() {
      if (stopped) return stoppedReason === 'expired' || stoppedReason === 'incompatible' ? stoppedReason : 'stopped'
      if (socket?.readyState === OPEN) return 'connected'
      if (socket !== undefined) return 'connecting'
      if (retryTimer !== undefined) return occupied ? 'occupied' : 'reconnecting'
      return 'idle'
    },
  }
}

export function install(rt) {
  const config = rt.config?.relay
  // `relay: false` or `enabled: false` in the profile turns the feature off completely.
  if (config === false || config?.enabled === false) return
  const { ctx } = rt

  rt.relay = createRelayController({
    home: rt.home,
    config: config ?? {},
    handle: (endpoint, payload, signal) => rt.handle(endpoint, payload, signal),
    subscribeFeed: subscriber => rt.subscribeFeed(subscriber),
    readOnly: () => rt.readOnly?.(),
    logger: ctx.logger ?? console,
  })
  ctx.effect(() => {
    let disposed = false
    // The store claims `state.lock` on its first load. Starting before that would let a second
    // window believe it owns the team and bind the same device id, so wait for the claim.
    Promise.resolve(rt.load?.())
      .catch(error => (ctx.logger ?? console).warn?.('ds-bot: relay start after load failed: %s', error))
      .then(() => { if (!disposed) rt.relay.start() })
    return () => {
      disposed = true
      rt.relay.stop()
    }
  }, 'ds-bot: relay connector')
}
