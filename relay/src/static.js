// Static serving of the built web shell, one directory per version under WEB_STATIC_DIR:
//   web-dist/0.2.3/index.html, web-dist/0.2.3/assets/...
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export function listVersions(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && VERSION_RE.test(entry.name))
      .map(entry => entry.name)
      .sort(compareVersions)
  } catch {
    return []
  }
}

function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split(/[.-]/).map(part => (Number.isNaN(Number(part)) ? part : Number(part)))
  const pb = b.replace(/^v/, '').split(/[.-]/).map(part => (Number.isNaN(Number(part)) ? part : Number(part)))
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    if (pa[index] === pb[index]) continue
    if (pa[index] === undefined) return -1
    if (pb[index] === undefined) return 1
    return pa[index] < pb[index] ? -1 : 1
  }
  return 0
}

export function isVersion(value) {
  return typeof value === 'string' && VERSION_RE.test(value)
}

export function hasVersion(dir, version) {
  if (!isVersion(version)) return false
  try {
    return statSync(join(resolve(dir, version), 'index.html')).isFile()
  } catch {
    return false
  }
}

// Sends the file and returns true, or returns false so the caller answers 404.
export function serveFile(res, dir, version, relPath) {
  const root = resolve(dir, version)
  const target = resolve(root, `.${relPath}`)
  if (target !== root && !target.startsWith(`${root}${sep}`)) return false
  let stat
  try { stat = statSync(target) } catch { return false }
  if (!stat.isFile()) return false
  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  createReadStream(target).pipe(res)
  return true
}

export function mismatchPage(versions, wanted) {
  const list = versions.length === 0
    ? '<li>暂无已部署的前端版本</li>'
    : versions.map(version => `<li>${escapeHtml(version)}</li>`).join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>版本不匹配</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.2rem;color:#222}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:4px}ul{padding-left:1.2rem}</style>
</head><body>
<h1>版本不匹配</h1>
<p>这台电脑运行的版本是 <code>${escapeHtml(wanted || '未知')}</code>，本站没有对应的前端。</p>
<p>已部署的版本：</p><ul>${list}</ul>
<p>请在电脑上更新 DS Bot，或联系管理员部署该版本的前端。</p>
</body></html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
}
