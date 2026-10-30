// Copy of ds-bot/src/shared/relay-protocol.js: the wire contract between the desktop
// connector and this relay. Kept here so the relay takes no dependency on ds-bot.
export const RELAY_PROTOCOL = 1

export const MSG = {
  bind: 'bind',
  bound: 'bound',
  denied: 'denied',
  request: 'request',
  response: 'response',
  feedSubscribe: 'feed-subscribe',
  feedUnsubscribe: 'feed-unsubscribe',
  feedEvent: 'feed-event',
  ping: 'ping',
  pong: 'pong',
}

export const CLOSE_BAD_TOKEN = 4001
export const CLOSE_DUPLICATE_DEVICE = 4002
export const CLOSE_BAD_PROTOCOL = 4003

const FORBIDDEN_PREFIXES = ['provider-', 'secret-', 'diagnostics', 'connector-', 'relay-']
const FORBIDDEN_EXACT = new Set(['providers', 'folder-pick', 'update-install', 'dsh-update-install'])

// The connector also enforces this; the relay refuses early so a bad endpoint never reaches
// a desktop.
export function isForbiddenEndpoint(endpoint) {
  const name = String(endpoint ?? '')
  if (FORBIDDEN_EXACT.has(name)) return true
  return FORBIDDEN_PREFIXES.some(prefix => name.startsWith(prefix))
}
