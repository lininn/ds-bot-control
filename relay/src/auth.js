// Phone login through the blog's accounts, and the server-side session it creates. The
// cookie holds only a random id; the blog access token is used for this request and never
// stored on the phone. The desktop connector signs in through /api/desktop/login and gets a
// separate device credential from devices.js.
import { config } from './config.js'
import { createSession, readSession as readServerSession, removeSession } from './sessions.js'
import { cookieHeader, parseCookies } from './util.js'

// __Host- enforces Secure, Path=/ and no Domain. A local HTTP relay uses the plain name.
export const SESSION_COOKIE = config.cookieSecure ? '__Host-relay_session' : 'relay_session'
export const DEVICE_COOKIE = 'relay_device'

export function makeSession(user) {
  return createSession(user)
}

export function readSession(req) {
  const value = parseCookies(req)[SESSION_COOKIE]
  if (typeof value !== 'string' || value === '') return null
  return readServerSession(value)
}

export function destroySession(session) {
  if (session !== null && typeof session?.hash === 'string') removeSession(session.hash)
}

export function sessionCookie(id) {
  return cookieHeader(SESSION_COOKIE, id, { maxAgeSec: config.sessionTtlMs / 1000, secure: config.cookieSecure })
}

export function deviceCookie(deviceId) {
  return cookieHeader(DEVICE_COOKIE, deviceId, { maxAgeSec: config.sessionTtlMs / 1000, secure: config.cookieSecure })
}

// Forget a chosen device without touching the session: the device it named is no longer online.
export function clearedDeviceCookie() {
  return cookieHeader(DEVICE_COOKIE, '', { maxAgeSec: 0, secure: config.cookieSecure })
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

// { status, accessToken, user } — the user's stable access token, used only to verify the
// account. It is never put in a cookie or sent to the phone.
export async function blogAuth(username, password) {
  const data = await postBlog('/api/relay/auth', { username, password })
  if (!data?.status || typeof data.accessToken !== 'string' || !data.user) return null
  return data
}
