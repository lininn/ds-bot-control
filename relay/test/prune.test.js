import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pruneWebDist } from '../../scripts/prune-web-dist.mjs'

test('pruning keeps the newest two web shells and ignores non-version directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-prune-web-'))
  try {
    for (const version of ['0.2.1', '0.2.2', '0.2.3', 'tmp', 'v0.3.0']) mkdirSync(join(dir, version))
    const result = pruneWebDist(dir, 2)
    assert.deepEqual(result.removed, ['0.2.1', '0.2.2'])
    assert.deepEqual(result.kept, ['0.2.3', 'v0.3.0'])
    assert.equal(existsSync(join(dir, '0.2.1')), false)
    assert.equal(existsSync(join(dir, '0.2.2')), false)
    assert.equal(existsSync(join(dir, '0.2.3')), true)
    assert.equal(existsSync(join(dir, 'v0.3.0')), true)
    assert.equal(existsSync(join(dir, 'tmp')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruning with fewer shells than the limit removes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-prune-web-'))
  try {
    mkdirSync(join(dir, '0.3.0'))
    assert.deepEqual(pruneWebDist(dir, 2), { kept: ['0.3.0'], removed: [] })
    assert.throws(() => pruneWebDist(dir, 0), /positive integer/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
