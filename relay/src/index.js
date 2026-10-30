// The relay: a phone signs in with a blog account, picks one of its own desktops, and the
// web shell under /web-dist/<version>/ talks to that desktop through this process.
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { config, checkConfig } from './config.js'
import { DEVICE_COOKIE, blogAuth, blogVerify, clearedCookies, deviceCookie, loginAllowed, makeSession, readSession, sessionCookie } from './auth.js'
import { Hub } from './connector.js'
import { isForbiddenEndpoint } from './protocol.js'
import { hasVersion, isVersion, listVersions, mismatchPage, serveFile } from './static.js'
import { clientIp, parseCookies, readJson, readParams, redirect, sameOrigin, sendHtml, sendJson } from './util.js'

checkConfig()

const hub = new Hub({
  verifyToken: blogVerify,
  requestTimeoutMs: config.requestTimeoutMs,
  pingMs: config.pingMs,
  pongTimeoutMs: config.pongTimeoutMs,
  bindTimeoutMs: config.bindTimeoutMs,
})

// The device the signed-in user chose, else the only one they have.
function selectedDevice(req, session) {
  const devices = hub.devicesFor(session.u)
  if (devices.length === 0) return undefined
  const chosen = parseCookies(req)[DEVICE_COOKIE]
  if (typeof chosen === 'string' && chosen !== '') {
    const conn = hub.get(session.u, chosen)
    if (conn !== undefined) return conn
  }
  if (devices.length === 1) return hub.get(session.u, devices[0].deviceId)
  return undefined
}

function isForm(req) {
  return (req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')
}

// One stylesheet for the pages the relay renders itself (login, device picker, mismatch).
// Dark by default to sit beside the desktop app; light when the browser asks for it.
const PAGE_CSS = `
:root {
  color-scheme: dark light;
  --bg: #0f1115;
  --card: #16191f;
  --card-2: #12151a;
  --line: rgba(255, 255, 255, 0.09);
  --line-strong: rgba(255, 255, 255, 0.16);
  --ink: #e9ebef;
  --muted: #9aa0aa;
  --field: #0e1014;
  --accent: #4d6bfe;
  --accent-2: #7b61ff;
  --accent-ink: #ffffff;
  --danger-bg: rgba(255, 84, 112, 0.12);
  --danger-line: rgba(255, 84, 112, 0.38);
  --danger-ink: #ff9aab;
  --shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f4f5f8;
    --card: #ffffff;
    --card-2: #ffffff;
    --line: rgba(15, 17, 21, 0.09);
    --line-strong: rgba(15, 17, 21, 0.18);
    --ink: #15181d;
    --muted: #6b7280;
    --field: #f7f8fa;
    --danger-bg: rgba(220, 38, 60, 0.08);
    --danger-line: rgba(220, 38, 60, 0.28);
    --danger-ink: #c02540;
    --shadow: 0 24px 60px rgba(15, 17, 21, 0.12);
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
  background:
    radial-gradient(900px 480px at 50% -12%, rgba(77, 107, 254, 0.22), transparent 62%),
    radial-gradient(700px 420px at 105% 110%, rgba(123, 97, 255, 0.14), transparent 60%),
    var(--bg);
  color: var(--ink);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.card {
  width: min(420px, 100%);
  padding: 30px 26px 24px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: linear-gradient(160deg, var(--card), var(--card-2));
  box-shadow: var(--shadow);
  animation: rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes rise { from { opacity: 0; transform: translateY(10px) scale(0.99); } }
.brand { display: flex; align-items: center; gap: 13px; margin-bottom: 26px; }
.mark {
  width: 44px; height: 44px; flex: 0 0 auto;
  display: grid; place-items: center;
  border-radius: 13px;
  background: linear-gradient(140deg, var(--accent), var(--accent-2));
  color: var(--accent-ink);
  box-shadow: 0 8px 22px rgba(77, 107, 254, 0.35);
}
.mark svg { width: 24px; height: 24px; display: block; }
.brand h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: 0.2px; }
.brand p { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
.field { margin-bottom: 14px; }
.field label { display: block; margin-bottom: 7px; font-size: 13px; color: var(--muted); }
.field input {
  width: 100%; height: 46px; padding: 0 14px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--field);
  color: var(--ink);
  font-size: 16px; /* 16px keeps iOS from zooming the form */
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.field input::placeholder { color: var(--muted); opacity: 0.7; }
.field input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(77, 107, 254, 0.22);
}
.btn {
  width: 100%; height: 46px; margin-top: 6px;
  border: 0; border-radius: 12px;
  background: linear-gradient(140deg, var(--accent), var(--accent-2));
  color: var(--accent-ink);
  font: inherit; font-weight: 650; font-size: 15px;
  cursor: pointer;
  transition: filter 0.15s, transform 0.05s, box-shadow 0.15s;
  box-shadow: 0 10px 26px rgba(77, 107, 254, 0.28);
}
.btn:hover { filter: brightness(1.07); }
.btn:active { transform: translateY(1px); }
.btn:focus-visible { outline: 3px solid rgba(77, 107, 254, 0.4); outline-offset: 2px; }
.btn.ghost {
  background: transparent; color: var(--muted);
  border: 1px solid var(--line-strong); box-shadow: none;
  font-weight: 500;
}
.btn.ghost:hover { color: var(--ink); filter: none; }
.alert {
  margin: 0 0 16px; padding: 11px 13px;
  border: 1px solid var(--danger-line); border-radius: 11px;
  background: var(--danger-bg); color: var(--danger-ink);
  font-size: 13.5px;
}
.foot { margin: 18px 0 0; text-align: center; font-size: 12px; color: var(--muted); }
.user { margin: -14px 0 18px; font-size: 13px; color: var(--muted); }
.devices { list-style: none; margin: 0 0 18px; padding: 0; display: grid; gap: 10px; }
.device {
  width: 100%; display: flex; align-items: center; gap: 13px;
  padding: 14px; text-align: left;
  border: 1px solid var(--line-strong); border-radius: 14px;
  background: var(--field); color: inherit; font: inherit;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.12s, background 0.15s, box-shadow 0.15s;
}
.device:hover { border-color: var(--accent); transform: translateY(-1px); box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18); }
.device:focus-visible { outline: 3px solid rgba(77, 107, 254, 0.4); outline-offset: 2px; }
.device .ic {
  width: 38px; height: 38px; flex: 0 0 auto;
  display: grid; place-items: center; border-radius: 11px;
  background: rgba(77, 107, 254, 0.14); color: var(--accent);
}
.device .ic svg { width: 20px; height: 20px; }
.device .txt { min-width: 0; flex: 1 1 auto; display: grid; gap: 2px; }
.device .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.device .meta { font-size: 12.5px; color: var(--muted); }
.device .chev { color: var(--muted); font-size: 20px; line-height: 1; }
.empty {
  margin: 0 0 18px; padding: 22px 16px; text-align: center;
  border: 1px dashed var(--line-strong); border-radius: 14px;
  color: var(--muted); font-size: 13.5px;
}
@media (max-width: 420px) { .card { padding: 26px 20px 20px; border-radius: 18px; } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } .device:hover { transform: none; } }
`

const BRAND_MARK = '<span class="mark"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.4" y="7" width="17.2" height="12.6" rx="4.2" fill="currentColor" opacity="0.95"/><circle cx="8.9" cy="13.2" r="1.5" fill="#0f1115"/><circle cx="15.1" cy="13.2" r="1.5" fill="#0f1115"/><path d="M12 3.2v3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="2.9" r="1.3" fill="currentColor"/></svg></span>'

function pageShell({ title, body }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0f1115"><title>${escapeAttr(title)}</title>
<style>${PAGE_CSS}</style></head>
<body><main class="card">${body}</main></body></html>`
}

function brand(title, subtitle) {
  return `<div class="brand">${BRAND_MARK}<div><h1>${escapeAttr(title)}</h1><p>${escapeAttr(subtitle)}</p></div></div>`
}

function loginPage({ error = '', username = '' } = {}) {
  return pageShell({
    title: '登录 · DS Bot',
    body: `${brand('DS Bot', '远程控制')}
${error === '' ? '' : `<p class="alert" role="alert">${escapeAttr(error)}</p>`}
<form method="post" action="/api/login" novalidate>
<div class="field"><label for="username">账号</label><input id="username" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" value="${escapeAttr(username)}" placeholder="你的账号" autofocus required></div>
<div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="你的密码" required></div>
<button class="btn" type="submit">登录</button>
</form>
<p class="foot">用 blog 账号登录，登录后选择要控制的电脑</p>`,
  })
}

const DEVICE_ICON = '<span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2.2"/><path d="M2 20h20"/></svg></span>'

function devicesPage(session, { error = '' } = {}) {
  const devices = hub.devicesFor(session.u)
  const items = devices.map(device => `<li><form method="post" action="/api/devices/select">
<input type="hidden" name="deviceId" value="${escapeAttr(device.deviceId)}">
<button class="device" type="submit">${DEVICE_ICON}<span class="txt"><span class="name">${escapeAttr(device.name)}</span><span class="meta">在线 · v${escapeAttr(device.version)}</span></span><span class="chev" aria-hidden="true">›</span></button>
</form></li>`).join('')
  const list = items === ''
    ? '<div class="empty">没有在线电脑。请先在电脑上打开 DS Bot，并在设置 → 远程控制里登录。</div>'
    : `<ul class="devices">${items}</ul>`
  return pageShell({
    title: '选择电脑 · DS Bot',
    body: `${brand('选择电脑', '要控制哪一台？')}
<p class="user">${escapeAttr(session.n || session.u)}</p>
${error === '' ? '' : `<p class="alert" role="alert">${escapeAttr(error)}</p>`}
${list}
<form method="post" action="/api/logout"><button class="btn ghost" type="submit">退出登录</button></form>`,
  })
}

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}

async function handleLogin(req, res) {
  const form = isForm(req)
  // A browser form gets the page back with the message beside the fields; a script gets JSON.
  const fail = (status, message, username = '') => (form
    ? sendHtml(res, status, loginPage({ error: message, username }))
    : sendJson(res, status, { status: false, message }))
  if (!sameOrigin(req)) return fail(403, '请求来源不合法，请从登录页重新提交')
  if (!loginAllowed(clientIp(req))) return fail(429, '尝试过于频繁，请稍后再试')
  const body = await readParams(req)
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password.trim() : ''
  if (username === '' || password === '') return fail(400, '请输入账号和密码', username)
  let data
  try {
    data = await blogAuth(username, password)
  } catch (error) {
    console.error('[relay] blog auth failed', error?.message ?? error)
    return fail(502, '登录服务不可达，请稍后再试', username)
  }
  if (data === null) return fail(401, '账号或密码不正确', username)
  if (hub.devicesFor(data.user.username).length === 0) {
    return fail(403, '此账号还没有绑定电脑，请先在电脑上打开 DS Bot，并在设置 → 远程控制里登录', username)
  }
  const cookies = [sessionCookie(makeSession(data.user, data.accessToken)), deviceCookie('')]
  if (form) return redirect(res, '/', cookies)
  sendJson(res, 200, { status: true, user: data.user }, { 'set-cookie': cookies })
}

// A desktop app signing in to enable remote control. It has no cookie yet, and binding may
// happen before any phone signs in, so unlike /api/login this needs no connected device.
// The response carries the account's stable access token, which the connector then binds with.
async function handleDesktopLogin(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { status: false, message: 'forbidden' })
  if (!loginAllowed(clientIp(req))) return sendJson(res, 429, { status: false, message: '尝试过于频繁，请稍后再试' })
  const body = await readJson(req)
  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  const password = typeof body?.password === 'string' ? body.password.trim() : ''
  if (username === '' || password === '') return sendJson(res, 400, { status: false, message: '请输入用户名和密码' })
  let data
  try {
    data = await blogAuth(username, password)
  } catch (error) {
    console.error('[relay] blog auth failed', error?.message ?? error)
    return sendJson(res, 502, { status: false, message: '登录服务不可达，请稍后再试' })
  }
  if (data === null) return sendJson(res, 401, { status: false, message: '无效的凭证' })
  sendJson(res, 200, { status: true, accessToken: data.accessToken, user: data.user })
}

async function handleSelect(req, res, session) {
  const form = isForm(req)
  if (!sameOrigin(req)) {
    return form ? sendHtml(res, 403, devicesPage(session, { error: '请求来源不合法，请重试' })) : sendJson(res, 403, { status: false, message: 'forbidden' })
  }
  const body = await readParams(req)
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
  if (hub.get(session.u, deviceId) === undefined) {
    return form ? sendHtml(res, 404, devicesPage(session, { error: '这台电脑已离线，请刷新后重试' })) : sendJson(res, 404, { status: false, message: '没有这台电脑' })
  }
  if (form) return redirect(res, '/', [deviceCookie(deviceId)])
  sendJson(res, 200, { status: true }, { 'set-cookie': [deviceCookie(deviceId)] })
}

async function handleBot(req, res, session) {
  const conn = selectedDevice(req, session)
  if (conn === undefined) return sendJson(res, 409, { ok: false, error: { code: 'relay/no-device', message: 'No device selected', details: {} } })
  const body = await readJson(req)
  const endpoint = String(body?.endpoint ?? '')
  if (isForbiddenEndpoint(endpoint)) {
    return sendJson(res, 403, { ok: false, error: { code: 'bot/forbidden', message: 'Not available remotely', details: {} } })
  }
  try {
    const result = await hub.request(conn, endpoint, body?.payload)
    sendJson(res, 200, result)
  } catch (error) {
    const status = error?.code === 'relay/offline' ? 503 : 504
    sendJson(res, status, { ok: false, error: { code: error?.code ?? 'relay/error', message: error?.message ?? 'Relay error', details: {} } })
  }
}

function handleFeed(req, res, session) {
  const conn = selectedDevice(req, session)
  if (conn === undefined) return sendJson(res, 409, { ok: false, error: { code: 'relay/no-device', message: 'No device selected', details: {} } })
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write('event: hello\ndata: {"revision":0}\n\n')
  res.flushHeaders?.()
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n') } catch { /* closed */ }
  }, 20_000)
  keepalive.unref?.()
  const unsubscribe = hub.addFeedClient(conn, res)
  req.on('close', () => {
    clearInterval(keepalive)
    unsubscribe()
  })
}

function matchApi(pathname) {
  let match = /^\/web-dist\/([^/]+)\/api\/bot(\/feed)?$/.exec(pathname)
  if (match) return { kind: match[2] ? 'feed' : 'bot' }
  match = /^\/api\/bot(\/feed)?$/.exec(pathname)
  if (match) return { kind: match[1] ? 'feed' : 'bot' }
  return undefined
}

async function route(req, res) {
  res.setHeader('x-content-type-options', 'nosniff')
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  if (pathname === '/health') return sendJson(res, 200, { status: true })

  if (pathname === '/login' && method === 'GET') return sendHtml(res, 200, loginPage())
  if (pathname === '/api/login' && method === 'POST') return handleLogin(req, res)
  if (pathname === '/api/desktop/login' && method === 'POST') return handleDesktopLogin(req, res)
  if (pathname === '/api/logout' && method === 'POST') {
    // A browser form goes back to the login page; a script gets JSON.
    if (isForm(req)) return redirect(res, '/login', clearedCookies())
    return sendJson(res, 200, { status: true }, { 'set-cookie': clearedCookies() })
  }

  const session = readSession(req)

  if (pathname === '/devices' && method === 'GET') {
    if (session === null) return redirect(res, '/login')
    return sendHtml(res, 200, devicesPage(session))
  }
  if (pathname === '/api/devices' && method === 'GET') {
    if (session === null) return sendJson(res, 401, { status: false, message: 'unauthorized' })
    return sendJson(res, 200, { status: true, devices: hub.devicesFor(session.u) })
  }
  if (pathname === '/api/devices/select' && method === 'POST') {
    if (session === null) return sendJson(res, 401, { status: false, message: 'unauthorized' })
    return handleSelect(req, res, session)
  }

  const api = matchApi(pathname)
  if (api !== undefined) {
    if (session === null) return sendJson(res, 401, { ok: false, error: { code: 'relay/unauthorized', message: 'Sign in', details: {} } })
    if (api.kind === 'feed' && method === 'GET') return handleFeed(req, res, session)
    if (api.kind === 'bot' && method === 'POST') return handleBot(req, res, session)
    return sendJson(res, 405, { status: false, message: 'method not allowed' })
  }

  const versioned = /^\/web-dist\/([^/]+)(\/.*)?$/.exec(pathname)
  if (versioned !== null) {
    const version = versioned[1]
    if (!isVersion(version)) return sendJson(res, 404, { status: false, message: 'not found' })
    // The shell builds with relative asset paths, so it must be loaded from a directory
    // URL ending in a slash; otherwise ./assets resolves above the version directory.
    if (versioned[2] === undefined) return redirect(res, `/web-dist/${version}/`)
    const relPath = versioned[2] === '/' ? '/index.html' : versioned[2]
    if (serveFile(res, config.webStaticDir, version, relPath)) return
    if (relPath === '/index.html') {
      return sendHtml(res, 404, mismatchPage(listVersions(config.webStaticDir), version))
    }
    return sendJson(res, 404, { status: false, message: 'not found' })
  }

  if (pathname === '/' && method === 'GET') {
    if (session === null) return redirect(res, '/login')
    const conn = selectedDevice(req, session)
    if (conn === undefined) return redirect(res, '/devices')
    if (!hasVersion(config.webStaticDir, conn.version)) {
      return sendHtml(res, 409, mismatchPage(listVersions(config.webStaticDir), conn.version))
    }
    // Serve at a directory URL so the build's relative assets resolve under it.
    return redirect(res, `/web-dist/${conn.version}/`)
  }

  sendJson(res, 404, { status: false, message: 'not found' })
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('[relay] request failed', error)
    if (!res.headersSent) sendJson(res, 500, { status: false, message: 'internal error' })
    else try { res.end() } catch { /* closed */ }
  })
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  if (pathname !== '/connector') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => hub.handleConnection(ws))
})

server.listen(config.port, () => {
  console.log(`[relay] listening on :${config.port} (blog ${config.blogApiUrl || 'unset'}, static ${config.webStaticDir})`)
})

function shutdown() {
  server.close()
  wss.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

export { server, hub }
