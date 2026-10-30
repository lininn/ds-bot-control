// Small HTTP helpers over node:http. No framework.
const MAX_BODY = 256 * 1024

export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(text)
}

export function sendHtml(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

export function readBody(req, limit = MAX_BODY) {
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

export function clientIp(req) {
  return req.socket?.remoteAddress ?? 'unknown'
}

// A form or fetch that crosses origins is refused: SameSite=Lax already blocks most, and
// this closes the gap for same-site subdomains.
export function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true // curl and same-origin form posts
  try {
    const host = new URL(origin).host
    return host === req.headers.host
  } catch {
    return false
  }
}
