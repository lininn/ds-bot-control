// Copy of ds-bot/src/shared/relay-protocol.js: the wire contract between the desktop
// connector and this relay. Kept here so the relay takes no dependency on ds-bot.
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

export const CLOSE_BAD_TOKEN = 4001
export const CLOSE_DUPLICATE_DEVICE = 4002
export const CLOSE_BAD_PROTOCOL = 4003

// Default deny. The connector enforces the same list; the relay refuses early so a bad
// endpoint never reaches a desktop. Keep both copies in step with
// ds-bot/src/shared/relay-protocol.js.
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
