// Small HTTP helpers over node:http. No framework.
import { isIP } from 'node:net'
import { config } from './config.js'

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(text)
}

export function sendHtml(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

export function readBody(req, limit = config.bodyLimitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function readJson(req) {
  const text = await readBody(req)
  if (text === '') return {}
  try { return JSON.parse(text) } catch { return {} }
}

export function isJson(req) {
  return String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')
}

// A login form posts urlencoded; the API accepts both.
export async function readParams(req) {
  const type = req.headers['content-type'] ?? ''
  if (type.includes('application/json')) return readJson(req)
  const text = await readBody(req)
  const params = new URLSearchParams(text)
  return Object.fromEntries(params.entries())
}

export function parseCookies(req) {
  const header = req.headers.cookie
  const map = {}
  if (typeof header !== 'string' || header === '') return map
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name !== '') map[name] = decodeURIComponent(value)
  }
  return map
}

export function cookieHeader(name, value, { maxAgeSec, secure = false, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax']
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${Math.floor(maxAgeSec)}`)
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function redirect(res, location, cookies = []) {
  const headers = { location, 'cache-control': 'no-store' }
  if (cookies.length > 0) headers['set-cookie'] = cookies
  res.writeHead(303, headers)
  res.end()
}

function normalizeIp(value) {
  const text = String(value ?? '').trim()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text)
  return mapped ? mapped[1] : text
}

function ipv4Number(value) {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    const number = Number(part)
    if (!Number.isInteger(number) || number < 0 || number > 255) return null
    result = result * 256 + number
  }
  return result
}

function ipv6Number(value) {
  let text = value.toLowerCase()
  if (text.includes('.')) {
    const last = text.slice(text.lastIndexOf(':') + 1)
    const v4 = ipv4Number(last)
    if (v4 === null) return null
    text = `${text.slice(0, text.lastIndexOf(':'))}:${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  if (groups.length !== 8) return null
  let result = 0n
  for (const group of groups) {
    const number = Number.parseInt(group, 16)
    if (!Number.isInteger(number) || number < 0 || number > 0xffff) return null
    result = (result << 16n) + BigInt(number)
  }
  return result
}

function inCidr(ip, cidr) {
  const [network, prefixText] = cidr.split('/')
  const prefix = prefixText === undefined ? undefined : Number(prefixText)
  const family = isIP(ip)
  if (family === 0 || isIP(network) !== family) return false
  if (family === 4) {
    const value = ipv4Number(ip)
    const base = ipv4Number(network)
    if (value === null || base === null) return false
    const bits = prefix === undefined ? 32 : prefix
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (value & mask) === (base & mask)
  }
  const value = ipv6Number(ip)
  const base = ipv6Number(network)
  if (value === null || base === null) return false
  const bits = prefix === undefined ? 128 : prefix
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false
  const shift = BigInt(128 - bits)
  return (value >> shift) === (base >> shift)
}

function trusted(ip) {
  return config.trustedProxies.some(cidr => inCidr(ip, cidr))
}

// The address the limits and the logs use. With a trusted reverse proxy, X-Forwarded-For is
// read from the right: nginx appends the peer it saw, so the leftmost value is whatever the
// client chose to send. A request from an untrusted socket ignores the header entirely.
export function clientIp(req) {
  const peer = normalizeIp(req.socket?.remoteAddress ?? '') || 'unknown'
  if (!config.trustProxy || !trusted(peer)) return peer
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded !== 'string' || forwarded === '') return peer
  const hops = forwarded.split(',').map(value => normalizeIp(value)).filter(value => isIP(value) !== 0)
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    if (!trusted(hops[index])) return hops[index]
  }
  return hops[0] ?? peer
}

// A form or fetch that crosses origins is refused: SameSite=Lax already blocks most, and
// this closes the gap for same-site subdomains. State-changing requests must say where they
// came from; only the desktop sign-in is exempt because the connector has no browser origin.
export function sameOrigin(req, { allowMissing = false } = {}) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return allowMissing
  try {
    const url = new URL(origin)
    return url.host === req.headers.host && (url.protocol === 'http:' || url.protocol === 'https:')
  } catch {
    return false
  }
}
