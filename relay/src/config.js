// Environment for one relay instance. See relay/README.md.
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.env

function number(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const flag = (value, fallback) => (value === undefined ? fallback : value === '1' || value === 'true')

export const config = {
  port: number(env.PORT, 8787),
  // The blog's origin; /api/relay/auth and /api/relay/verify live under it.
  blogApiUrl: (env.BLOG_API_URL ?? '').replace(/\/+$/, ''),
  // Sessions and the device registry. Defaults beside the source; deployments set this to a
  // writable StateDirectory so ProtectSystem=strict does not make it read-only.
  dataDir: env.DSBOT_RELAY_DATA ?? fileURLToPath(new URL('../data', import.meta.url)),
  sessionTtlMs: number(env.SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000),
  sessionIdleMs: number(env.SESSION_IDLE_MS, 24 * 60 * 60 * 1000),
  // Secure by default; a local HTTP development relay sets COOKIE_SECURE=0.
  cookieSecure: flag(env.COOKIE_SECURE, true),
  // Where the built @lininn/ds-web versions are unpacked (one directory per version).
  webStaticDir: env.WEB_STATIC_DIR ?? fileURLToPath(new URL('../web-dist', import.meta.url)),
  requestTimeoutMs: number(env.REQUEST_TIMEOUT_MS, 120_000),
  pingMs: number(env.PING_MS, 15_000),
  pongTimeoutMs: number(env.PONG_TIMEOUT_MS, 45_000),
  bindTimeoutMs: number(env.BIND_TIMEOUT_MS, 30_000),
  bodyLimitBytes: number(env.BODY_LIMIT_BYTES, 1024 * 1024),
  trustProxy: flag(env.TRUST_PROXY, false),
  trustedProxies: (env.TRUSTED_PROXIES ?? '127.0.0.1/8,::1/128').split(',').map(value => value.trim()).filter(Boolean),
  maxConnectorPerUser: number(env.MAX_CONNECTOR_PER_USER, 10),
  maxConnectors: number(env.MAX_CONNECTORS, 1000),
  maxUnbound: number(env.MAX_UNBOUND, 2000),
  maxUnboundPerIp: number(env.MAX_UNBOUND_PER_IP, 100),
  wsMaxPayload: number(env.WS_MAX_PAYLOAD, 1024 * 1024),
  wsFramesPerSecond: number(env.WS_FRAMES_PER_SECOND, 100),
  sseMaxPerDevice: number(env.SSE_MAX_PER_DEVICE, 4),
  sseMaxBytes: number(env.SSE_MAX_BYTES, 4 * 1024 * 1024),
  sseBlockedMs: number(env.SSE_BLOCKED_MS, 30_000),
}

export function checkConfig(logger = console) {
  if (!config.blogApiUrl) throw new Error('BLOG_API_URL is required')
  // Fail at start rather than discovering on the first login that a strict unit cannot write
  // the session table. The probe also catches a directory mounted read-only.
  try {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
    accessSync(config.dataDir, constants.W_OK)
    const probe = join(config.dataDir, `.write-probe-${randomUUID()}`)
    writeFileSync(probe, '', { mode: 0o600 })
    rmSync(probe, { force: true })
  } catch (error) {
    throw new Error(`DSBOT_RELAY_DATA is not writable: ${config.dataDir}: ${error?.message ?? error}`)
  }
  if (config.maxConnectorPerUser < 1 || config.maxConnectors < 1) throw new Error('connector limits must be positive')
  logger.info?.(`[relay] data ${config.dataDir}`)
  return config
}
