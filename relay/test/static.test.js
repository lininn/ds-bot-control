import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { test } from 'node:test'
import { serveFile } from '../src/static.js'

function response() {
  const output = new Writable({
    write(chunk, _encoding, callback) {
      output.chunks.push(chunk)
      callback()
    },
  })
  output.chunks = []
  output.status = 0
  output.headers = {}
  output.writeHead = (status, headers) => {
    output.status = status
    output.headers = headers
  }
  return output
}

test('the entry is never cached while hashed assets are immutable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-relay-static-'))
  try {
    mkdirSync(join(dir, '0.2.3', 'assets'), { recursive: true })
    writeFileSync(join(dir, '0.2.3', 'index.html'), '<!doctype html>')
    writeFileSync(join(dir, '0.2.3', 'assets', 'app-abc.js'), 'x'.repeat(2_000))
    const entry = response()
    assert.equal(serveFile({ headers: {} }, entry, dir, '0.2.3', '/index.html'), true)
    assert.equal(entry.headers['cache-control'], 'no-store')
    assert.equal(entry.headers['x-content-type-options'], 'nosniff')
    await finished(entry)
    const asset = response()
    assert.equal(serveFile({ headers: {} }, asset, dir, '0.2.3', '/assets/app-abc.js'), true)
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable')
    await finished(asset)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('text assets are gzipped only when the client accepts it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-relay-static-'))
  try {
    mkdirSync(join(dir, '0.2.3', 'assets'), { recursive: true })
    writeFileSync(join(dir, '0.2.3', 'assets', 'app.js'), 'x'.repeat(2_000))
    const compressed = response()
    serveFile({ headers: { 'accept-encoding': 'gzip' } }, compressed, dir, '0.2.3', '/assets/app.js')
    assert.equal(compressed.headers['content-encoding'], 'gzip')
    assert.equal(compressed.headers.vary, 'accept-encoding')
    await finished(compressed)
    const plain = response()
    serveFile({ headers: {} }, plain, dir, '0.2.3', '/assets/app.js')
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.equal(plain.headers['content-length'], 2_000)
    await finished(plain)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a path outside the version directory is never served', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-relay-static-'))
  try {
    mkdirSync(join(dir, '0.2.3'), { recursive: true })
    writeFileSync(join(dir, '0.2.3', 'index.html'), '<!doctype html>')
    writeFileSync(join(dir, 'secret.txt'), 'no')
    assert.equal(serveFile({ headers: {} }, response(), dir, '0.2.3', '/../secret.txt'), false)
    assert.equal(serveFile({ headers: {} }, response(), dir, '0.2.3', '/missing.js'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
