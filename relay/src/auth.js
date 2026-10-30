// Phone login through the blog's accounts, and the signed session cookie it issues.
// The desktop connector's access token is verified by the same blog endpoints.
import crypto from 'node:crypto'
import { config } from './config.js'
import { cookieHeader, parseCookies } from './util.js'

export const SESSION_COOKIE = 'relay_session'
export const DEVICE_COOKIE = 'relay_device'

// A missing SESSION_SECRET keeps development working; production sets it so sessions survive.
const secret = config.sessionSecret !== '' ? config.sessionSecret : crypto.randomBytes(32).toString('hex')

function sign(payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

export function makeSession(user, accessToken) {
  const now = Date.now()
  const payload = Buffer.from(JSON.stringify({
    u: user.username,
    n: user.displayName ?? '',
    t: accessToken,
    i: now,
    e: now + config.sessionTtlMs,
  })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function readSession(req) {
  const value = parseCookies(req)[SESSION_COOKIE]
  if (typeof value !== 'string' || value === '') return null
  const dot = value.lastIndexOf('.')
  if (dot < 0) return null
  const payload = value.slice(0, dot)
  const signature = value.slice(dot + 1)
  const expected = sign(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof session?.u !== 'string' || !session.e || session.e < Date.now()) return null
    return session
  } catch {
    return null
  }
}

export function sessionCookie(token) {
  return cookieHeader(SESSION_COOKIE, token, { maxAgeSec: config.sessionTtlMs / 1000, secure: config.cookieSecure })
}

export function deviceCookie(deviceId) {
  return cookieHeader(DEVICE_COOKIE, deviceId, { maxAgeSec: config.sessionTtlMs / 1000, secure: config.cookieSecure })
}

export function clearedCookies() {
  return [cookieHeader(SESSION_COOKIE, '', { maxAgeSec: 0, secure: config.cookieSecure }), cookieHeader(DEVICE_COOKIE, '', { maxAgeSec: 0, secure: config.cookieSecure })]
}

async function postBlog(path, body, timeoutMs = 10_000) {
  const response = await fetch(`${config.blogApiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return response.json()
}

// { status, accessToken, user } — the user's stable access token, shared with the desktop.
export async function blogAuth(username, password) {
  const data = await postBlog('/api/relay/auth', { username, password })
  if (!data?.status || typeof data.accessToken !== 'string' || !data.user) return null
  return data
}

// { status, user } for a connector's access token.
export async function blogVerify(accessToken) {
  const data = await postBlog('/api/relay/verify', { accessToken })
  if (!data?.status || !data.user) return null
  return data.user
}

// A simple per-IP login limit; one relay process keeps this in memory.
const attempts = new Map()
export function loginAllowed(ip) {
  const now = Date.now()
  let entry = attempts.get(ip)
  if (entry === undefined || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + 60_000 }
    attempts.set(ip, entry)
  }
  entry.count += 1
  return entry.count <= 10
}
