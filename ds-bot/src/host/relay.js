// Remote control: the connector the desktop app runs so a phone, signed in on the relay's
// website, can drive this machine's team. It holds one outbound WebSocket to the relay and
// turns the relay's requests into calls on the Bot API in this process, so a phone never
// needs the local DSH cookie.
//
// The user turns this on in Settings → Remote control: they paste the relay address, sign in
// with a blog account, and the token is kept in <home>/relay.json. The `relay` key of the
// plugin config is optional and only supplies defaults:
//   { enabled?: boolean, url?: string, token?: string, deviceName?: string }
// `enabled: false` (or `relay: false`) hides the feature; a config `token` is a fallback for
// a deployment that pairs machines without the settings page.
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOSE_BAD_TOKEN, CLOSE_DUPLICATE_DEVICE, MSG, RELAY_PROTOCOL, isForbiddenEndpoint } from '../shared/relay-protocol.js'

const require = createRequire(import.meta.url)
const VERSION = require('../../package.json').version

const OPEN = 1
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000

// The device's relay state lives in one file under the team's home: the id that pairs this
// machine across restarts, and the account it signed in with. `relay.json` is readable by
// the owner only; it holds the account's access token.
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
    writeFileSync(join(home, RELAY_FILE), JSON.stringify(saved, null, 2), { mode: 0o600 })
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

// The relay connector and the settings page share this controller. `login` asks the relay
// for the account's access token, `logout` forgets it, and either restarts the socket.
export function createRelayController({
  home,
  config = {},
  handle,
  subscribeFeed,
  version = VERSION,
  apiProtocol = RELAY_PROTOCOL,
  defaultDeviceName = hostname(),
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  logger = console,
  random = Math.random,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  env = process.env,
  defaultUrl = DEFAULT_RELAY_URL,
}) {
  let saved = readRelayFile(home)
  let connector
  // Generated only when a connector actually binds, so loading the plugin writes nothing.
  const deviceId = () => {
    if (typeof saved.deviceId === 'string' && saved.deviceId !== '') return saved.deviceId
    saved = saveRelayFile(home, { ...saved, deviceId: randomUUID() })
    return saved.deviceId
  }

  // A saved address beats the profile, the environment and the built-in default, in that order.
  // An empty string at any level is "not set", so a blank DS_BOT_RELAY_URL cannot hide the default.
  const urlAt = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  const configuredUrl = () => urlAt(saved.url) ?? urlAt(config.url) ?? urlAt(env.DS_BOT_RELAY_URL) ?? urlAt(defaultUrl) ?? ''
  // A logout sets `disabled`, which opts out of a token that a profile config still carries.
  const token = () => {
    if (saved.disabled === true) return ''
    if (typeof saved.token === 'string' && saved.token !== '') return saved.token
    return typeof config.token === 'string' ? config.token : ''
  }
  const deviceName = () => (typeof saved.deviceName === 'string' && saved.deviceName !== '' ? saved.deviceName : typeof config.deviceName === 'string' && config.deviceName !== '' ? config.deviceName : defaultDeviceName)

  const reconnector = () => {
    connector?.stop()
    connector = undefined
    const target = relayUrls(configuredUrl())
    if (target === undefined || token() === '') return
    connector = createConnector({
      url: target.socket,
      token: token(),
      deviceName: deviceName(),
      version,
      apiProtocol,
      deviceId: deviceId(),
      handle,
      subscribeFeed,
      WebSocketImpl,
      logger,
      random,
      setTimeoutImpl,
      clearTimeoutImpl,
    })
    connector.start()
  }

  const status = () => ({
    configured: relayUrls(configuredUrl()) !== undefined,
    bound: token() !== '',
    username: typeof saved.username === 'string' ? saved.username : '',
    url: configuredUrl(),
    deviceName: deviceName(),
    relayConnected: connector?.connected === true,
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
          body: JSON.stringify({ username: name, password: secret }),
          signal: AbortSignal.timeout(20_000),
        })
      } catch {
        throw invalid('Could not reach the relay. Check the address and that it is running.')
      }
      let data
      try { data = await response.json() } catch { data = null }
      if (data?.status === true && typeof data.accessToken === 'string' && data.accessToken !== '') {
        saved = saveRelayFile(home, {
          ...saved,
          url: configuredUrl(),
          token: data.accessToken,
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
      saved = saveRelayFile(home, { ...saved, token: '', username: '', disabled: true })
      return status()
    },
    start: reconnector,
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
  handle,
  subscribeFeed,
  WebSocketImpl = globalThis.WebSocket,
  logger = console,
  random = Math.random,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  let socket
  let stopped = false
  let attempt = 0
  let retryTimer
  let unsubscribeFeed
  let feedSubscribed = false

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
    let result
    try {
      result = await handle(String(message.endpoint ?? ''), message.payload)
    } catch (error) {
      result = { ok: false, error: { code: error?.code ?? 'bot/error', message: error?.message ?? String(error), details: {} } }
    }
    send({ t: MSG.response, id, result })
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
      case MSG.feedSubscribe: startFeed(message); break
      case MSG.feedUnsubscribe: stopFeed(); break
      case MSG.ping: send({ t: MSG.pong, at: message.at }); break
      case MSG.bound: attempt = 0; break
      default: break
    }
  }

  const scheduleRetry = () => {
    if (stopped) return
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt)
    const delay = cap / 2 + random() * (cap / 2)
    attempt += 1
    retryTimer = setTimeoutImpl(() => {
      retryTimer = undefined
      connect()
    }, delay)
    retryTimer?.unref?.()
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
    next.addEventListener?.('open', () => {
      send({ t: MSG.bind, role: 'connector', kind: 'dsbot', deviceId, name: deviceName, version, apiProtocol, accessToken: token })
    })
    next.addEventListener?.('message', onMessage)
    next.addEventListener?.('close', (event) => {
      stopFeed()
      if (socket === next) socket = undefined
      const code = event?.code
      if (code === CLOSE_BAD_TOKEN || code === CLOSE_DUPLICATE_DEVICE) {
        // Retrying cannot help: the token is wrong, or another window already owns this id.
        stopped = true
        logger?.warn?.(`relay closed the connection (${code}); not retrying`)
        return
      }
      scheduleRetry()
    })
    next.addEventListener?.('error', () => { /* a close event follows */ })
  }

  return {
    start() {
      if (!stopped && socket === undefined && retryTimer === undefined) connect()
    },
    stop() {
      stopped = true
      if (retryTimer !== undefined) clearTimeoutImpl(retryTimer)
      retryTimer = undefined
      stopFeed()
      try { socket?.close() } catch { /* already closed */ }
      socket = undefined
    },
    get connected() {
      return socket?.readyState === OPEN
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
    logger: ctx.logger ?? console,
  })
  ctx.effect(() => {
    rt.relay.start()
    return () => rt.relay.stop()
  }, 'ds-bot: relay connector')
}
