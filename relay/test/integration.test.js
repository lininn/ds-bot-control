// End to end: a real relay process, a blog stub for auth, a fake desktop connector and a
// phone. Proves login, device selection, the api/bot request path and the SSE feed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { WebSocket } from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'src', 'index.js')
const USER = { username: 'alice', displayName: 'Alice', isAdmin: true }
const TOKEN = 'access-token-1'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function startBlog() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      let json = {}
      try { json = JSON.parse(body) } catch { /* empty */ }
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/relay/auth' && json.username === 'alice' && json.password === 'secret') {
        res.end(JSON.stringify({ status: true, accessToken: TOKEN, user: USER }))
      } else if (req.url === '/api/relay/verify' && json.accessToken === TOKEN) {
        res.end(JSON.stringify({ status: true, user: USER }))
      } else {
        res.end(JSON.stringify({ status: false, message: 'no' }))
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function waitFor(healthUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(healthUrl)
      if (response.ok) return
    } catch { /* not yet */ }
    await sleep(50)
  }
  throw new Error('relay did not start')
}

test('a logged-in phone drives a fake desktop through the relay', { timeout: 20_000 }, async (t) => {
  const staticDir = mkdtempSync(join(tmpdir(), 'ds-relay-web-'))
  mkdirSync(join(staticDir, '0.2.3'))
  writeFileSync(join(staticDir, '0.2.3', 'index.html'), '<!doctype html><title>shell</title>')
  const blog = await startBlog()
  const blogPort = blog.address().port
  const port = await freePort()
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      BLOG_API_URL: `http://127.0.0.1:${blogPort}`,
      SESSION_SECRET: 'test-secret',
      WEB_STATIC_DIR: staticDir,
      PING_MS: '60000',
      PONG_TIMEOUT_MS: '120000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const cleanup = async () => {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    blog.close()
    rmSync(staticDir, { recursive: true, force: true })
  }
  t.after(cleanup)

  await waitFor(`http://127.0.0.1:${port}/health`)
  const base = `http://127.0.0.1:${port}`

  // The desktop connector binds and answers requests and feed subscriptions.
  const connector = new WebSocket(`ws://127.0.0.1:${port}/connector`)
  const bound = new Promise((resolve, reject) => {
    connector.once('error', reject)
    connector.on('open', () => connector.send(JSON.stringify({
      t: 'bind', role: 'connector', kind: 'dsbot', accessToken: TOKEN, deviceId: 'dev-1',
      name: 'My Mac', version: '0.2.3', apiProtocol: 1,
    })))
    connector.on('message', (data) => {
      const message = JSON.parse(data.toString())
      if (message.t === 'bound') resolve(message)
      if (message.t === 'request') {
        connector.send(JSON.stringify({ t: 'response', id: message.id, result: { ok: true, value: { echo: message.endpoint } } }))
      }
      if (message.t === 'feed-subscribe') {
        connector.send(JSON.stringify({ t: 'feed-event', sub: 'dev-1', event: 'live', data: { at: 1 } }))
      }
    })
  })
  t.after(() => connector.close())
  assert.equal((await bound).deviceId, 'dev-1')

  // The phone logs in; the set-cookie carries the session.
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'secret' }),
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')

  const devices = await fetch(`${base}/api/devices`, { headers: { cookie } }).then(response => response.json())
  assert.deepEqual(devices.devices.map(device => device.deviceId), ['dev-1'])

  // A desktop signs in to enable remote control: it gets the account's token and needs no
  // device to be online yet.
  const desktop = await fetch(`${base}/api/desktop/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'secret' }),
  })
  assert.equal(desktop.status, 200)
  const desktopLogin = await desktop.json()
  assert.equal(desktopLogin.accessToken, TOKEN)
  assert.equal(desktopLogin.user.username, 'alice')
  const refusedDesktop = await fetch(`${base}/api/desktop/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'wrong' }),
  })
  assert.equal(refusedDesktop.status, 401)

  // The shell is served from the versioned directory.
  const shell = await fetch(`${base}/web-dist/0.2.3/index.html`)
  assert.equal(shell.status, 200)
  assert.equal((await shell.text()).includes('shell'), true)
  // The shell must load from a directory URL so its relative assets resolve.
  const root = await fetch(`${base}/`, { headers: { cookie }, redirect: 'manual' })
  assert.equal(root.status, 303)
  assert.equal(root.headers.get('location'), '/web-dist/0.2.3/')
  const noSlash = await fetch(`${base}/web-dist/0.2.3`, { redirect: 'manual' })
  assert.equal(noSlash.status, 303)
  assert.equal(noSlash.headers.get('location'), '/web-dist/0.2.3/')

  // A request under the shell's own base path reaches the connector.
  const call = await fetch(`${base}/web-dist/0.2.3/api/bot`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'state', payload: {} }),
  })
  assert.deepEqual(await call.json(), { ok: true, value: { echo: 'state' } })

  // Forbidden endpoints are refused before the desktop sees them.
  const refused = await fetch(`${base}/api/bot`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'provider-key', payload: {} }),
  })
  assert.equal(refused.status, 403)

  // The feed starts with hello and then the connector's event.
  const controller = new AbortController()
  t.after(() => controller.abort())
  const feed = await fetch(`${base}/api/bot/feed`, { headers: { cookie }, signal: controller.signal })
  const reader = feed.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes('event: live')) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  assert.equal(text.includes('event: hello'), true)
  assert.equal(text.includes('event: live'), true)
})

test('login is refused when the account has no connected desktop', { timeout: 15_000 }, async (t) => {
  const staticDir = mkdtempSync(join(tmpdir(), 'ds-relay-web-'))
  const blog = await startBlog()
  const port = await freePort()
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      BLOG_API_URL: `http://127.0.0.1:${blog.address().port}`,
      SESSION_SECRET: 'test-secret',
      WEB_STATIC_DIR: staticDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    blog.close()
    rmSync(staticDir, { recursive: true, force: true })
  })
  await waitFor(`http://127.0.0.1:${port}/health`)
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'secret' }),
  })
  assert.equal(login.status, 403)
})
