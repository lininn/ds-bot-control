// The wire contract between the desktop connector (this package) and the remote relay.
// Kept free of imports so the relay server can copy this one file without taking a
// dependency on ds-bot.
//
// Connector → relay:  bind, response, feed-event, pong
// Relay → connector:  bound, denied, request, cancel, feed-subscribe, feed-unsubscribe, ping

// Bumped when a request/response or feed shape changes incompatibly. The relay refuses a
// connector whose protocol differs from the web bundle it serves.
// v2: bind uses a relay-issued device credential and a runtime machineId.
export const RELAY_PROTOCOL = 2

export const MSG = {
  bind: 'bind',
  bound: 'bound',
  denied: 'denied',
  request: 'request',
  response: 'response',
  cancel: 'cancel',
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
export const CLOSE_BAD_PROTOCOL = 4003

// Endpoints a phone may reach. Default deny: a new endpoint is unreachable remotely until
// someone adds it here and adds both an allowed and a refused test. The Bot API carries the
// endpoint in the request body, so this check runs in the connector before dispatch and
// again at the relay before it forwards.
const ALLOWED_ENDPOINTS = new Set([
  'state', 'models', 'efforts', 'thinking', 'exchange', 'exchange-text', 'file-text',
  'earlier', 'chat', 'send', 'resume', 'run-stats', 'usage', 'room-progress',
  'create-bot', 'update-bot', 'delete-bot', 'set-main', 'set-prefs', 'duplicate-bot',
  'create-room', 'update-room', 'delete-room', 'add-agent', 'remove-agent',
  'agent-session', 'agent-adopt', 'agent-archive', 'agent-rename', 'set-flags',
  'approval-answer', 'dismiss-question', 'dismiss-view', 'stop-member-work',
  'stop-room-work', 'goal-draft', 'goal-control', 'avatar-library', 'avatar-import',
  'avatar-delete', 'folders', 'folder-list', 'team-workspace', 'private-release',
  'memory-history', 'memory-restore', 'learning-answer', 'new-room-conversation',
  'duplicate-room',
])

export function isForbiddenEndpoint(endpoint) {
  return !ALLOWED_ENDPOINTS.has(String(endpoint ?? ''))
}

export { ALLOWED_ENDPOINTS }
