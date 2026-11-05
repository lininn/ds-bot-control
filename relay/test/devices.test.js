import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'ds-relay-devices-'))
process.env.DSBOT_RELAY_DATA = dataDir
process.env.COOKIE_SECURE = '0'

const { issueDevice, findByToken, verifyDevice, revokeDevice, devicesOf } = await import('../src/devices.js')

const USER = { username: 'alice' }

test('a device token is issued once and only its hash is stored', () => {
  const { token, record } = issueDevice({ user: USER, deviceId: 'd1', machineId: 'm1', name: 'My Mac' })
  assert.equal(typeof token, 'string')
  assert.equal(token.length >= 40, true)
  assert.equal(record.tokenHash.length, 64)
  assert.equal(record.username, 'alice')
  assert.equal(verifyDevice(token, 'd1', 'm1')?.deviceId, 'd1')
  const saved = readFileSync(join(dataDir, 'devices.json'), 'utf8')
  assert.equal(saved.includes(token), false)
  assert.equal(saved.includes(record.tokenHash), true)
  assert.equal(devicesOf('alice').length, 1)
})

test('a token for another device or machine is refused', () => {
  const { token } = issueDevice({ user: USER, deviceId: 'd2', machineId: 'm2' })
  assert.equal(verifyDevice(token, 'd3', 'm2'), null)
  assert.equal(verifyDevice(token, 'd2', 'other'), null)
})

test('reissuing the same device/machine rotates the token and invalidates the old one', () => {
  const first = issueDevice({ user: USER, deviceId: 'd3', machineId: 'm3' })
  const second = issueDevice({ user: USER, deviceId: 'd3', machineId: 'm3' })
  assert.notEqual(first.token, second.token)
  assert.equal(findByToken(first.token), null)
  assert.equal(verifyDevice(second.token, 'd3', 'm3')?.deviceId, 'd3')
})

test('a copied relay.json with the same device id but another machine is refused', () => {
  issueDevice({ user: USER, deviceId: 'd4', machineId: 'original' })
  assert.throws(
    () => issueDevice({ user: USER, deviceId: 'd4', machineId: 'copy' }),
    error => error.code === 'device/conflict',
  )
})

test('a revoked device no longer verifies but stays in the registry', () => {
  const { token } = issueDevice({ user: USER, deviceId: 'd5', machineId: 'm5' })
  revokeDevice('alice', 'd5')
  assert.equal(verifyDevice(token, 'd5', 'm5'), null)
  assert.equal(devicesOf('alice').some(record => record.deviceId === 'd5'), false)
  assert.equal(findByToken(token)?.revokedAt !== null, true)
})

test.after(() => rmSync(dataDir, { recursive: true, force: true }))
