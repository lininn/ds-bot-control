// Environment for one relay instance. See relay/README.md.
const env = process.env

function number(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
  port: number(env.PORT, 8787),
  // The blog's origin; /api/relay/auth and /api/relay/verify live under it.
  blogApiUrl: (env.BLOG_API_URL ?? '').replace(/\/+$/, ''),
  // Signs the phone's session cookie. Set it in production so sessions survive a restart.
  sessionSecret: env.SESSION_SECRET ?? '',
  sessionTtlMs: number(env.SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000),
  cookieSecure: env.COOKIE_SECURE === '1' || env.COOKIE_SECURE === 'true',
  // Where the built @lininn/ds-web versions are unpacked (one directory per version).
  webStaticDir: env.WEB_STATIC_DIR ?? new URL('../web-dist', import.meta.url).pathname,
  requestTimeoutMs: number(env.REQUEST_TIMEOUT_MS, 120_000),
  pingMs: number(env.PING_MS, 15_000),
  pongTimeoutMs: number(env.PONG_TIMEOUT_MS, 45_000),
  bindTimeoutMs: number(env.BIND_TIMEOUT_MS, 30_000),
}

export function checkConfig(logger = console) {
  if (!config.blogApiUrl) throw new Error('BLOG_API_URL is required')
  if (!config.sessionSecret) logger.warn?.('[relay] SESSION_SECRET is unset; a random secret is used and sessions end on restart')
  return config
}
