// The wire contract between the desktop connector (this package) and the remote relay.
// Kept free of imports so the relay server can copy this one file without taking a
// dependency on ds-bot.
//
// Connector → relay:  bind, response, feed-event, pong
// Relay → connector:  bound, denied, request, feed-subscribe, feed-unsubscribe, ping

// Bumped when a request/response or feed shape changes incompatibly. The relay refuses a
// connector whose protocol differs from the web bundle it serves.
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

// Close codes the connector must not retry: the token is wrong, or another live connection
// already claims this deviceId.
export const CLOSE_BAD_TOKEN = 4001
export const CLOSE_DUPLICATE_DEVICE = 4002

// Endpoints a phone may never reach. The Bot API carries these in the request body, so the
// check runs where the body is known: in the connector, before dispatch.
const FORBIDDEN_PREFIXES = ['provider-', 'secret-', 'diagnostics', 'connector-', 'relay-']
const FORBIDDEN_EXACT = new Set([
  // Reads provider names and whether each key is set, and opens a host folder dialog.
  'providers',
  'folder-pick',
  // Replaces the running Harness or the app; only the desktop window does these.
  'update-install',
  'dsh-update-install',
])

export function isForbiddenEndpoint(endpoint) {
  const name = String(endpoint ?? '')
  if (FORBIDDEN_EXACT.has(name)) return true
  return FORBIDDEN_PREFIXES.some(prefix => name.startsWith(prefix))
}
