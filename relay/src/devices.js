// Desktop pairings. A desktop gets one long-lived random token at sign-in; the relay keeps
// its hash, never the token. The machine id is not read from the desktop's file: the
// connector computes it at every start, which is what makes a copied relay.json useless.
import crypto from 'node:crypto'
import { join } from 'node:path'
import { config } from './config.js'
import { readJsonFile, writeJsonFile } from './storage.js'

const byToken = new Map()
const byDevice = new Map()
let loaded = false

const file = () => join(config.dataDir, 'devices.json')
const tokenHash = token => crypto.createHash('sha256').update(String(token)).digest('hex')
const deviceKey = (username, deviceId) => `${username}\u0000${deviceId}`

function load() {
  if (loaded) return
  loaded = true
  const saved = readJsonFile(file(), {})
  for (const [hash, record] of Object.entries(saved)) {
    if (record === null || typeof record !== 'object') continue
    if (typeof record.username !== 'string' || typeof record.deviceId !== 'string') continue
    record.tokenHash = hash
    byToken.set(hash, record)
    byDevice.set(deviceKey(record.username, record.deviceId), record)
  }
}

function save() {
  const saved = {}
  for (const [hash, record] of byToken) saved[hash] = record
  writeJsonFile(file(), saved)
}

export function issueDevice({ user, deviceId, machineId, name }) {
  load()
  if (typeof deviceId !== 'string' || deviceId === '') throw Object.assign(new Error('deviceId is required'), { code: 'device/invalid' })
  if (typeof machineId !== 'string' || machineId === '') throw Object.assign(new Error('machineId is required'), { code: 'device/invalid' })
  const key = deviceKey(user.username, deviceId)
  const previous = byDevice.get(key)
  // A copied relay.json keeps the same deviceId but presents a different machine. Refuse it
  // rather than silently taking the original machine offline; signing in again is the way to
  // repurpose a genuinely new computer.
  if (previous !== undefined && previous.machineId !== machineId) {
    throw Object.assign(new Error('This device id belongs to another computer'), { code: 'device/conflict' })
  }
  const token = crypto.randomBytes(32).toString('base64url')
  const hash = tokenHash(token)
  if (previous !== undefined) byToken.delete(previous.tokenHash)
  const record = {
    username: user.username,
    deviceId,
    machineId,
    tokenHash: hash,
    name: typeof name === 'string' && name !== '' ? name : deviceId,
    pairedAt: Date.now(),
    revokedAt: null,
  }
  byToken.set(hash, record)
  byDevice.set(key, record)
  save()
  return { token, record }
}

export function findByToken(token) {
  load()
  if (typeof token !== 'string' || token === '') return null
  return byToken.get(tokenHash(token)) ?? null
}

export function findDevice(username, deviceId) {
  load()
  return byDevice.get(deviceKey(username, deviceId)) ?? null
}

export function verifyDevice(token, deviceId, machineId) {
  const record = findByToken(token)
  if (record === null || record.revokedAt !== null) return null
  if (record.deviceId !== deviceId || record.machineId !== machineId) return null
  return record
}

export function revokeDevice(username, deviceId) {
  load()
  const record = byDevice.get(deviceKey(username, deviceId))
  if (record === undefined) return null
  record.revokedAt = Date.now()
  save()
  return record
}

export function devicesOf(username) {
  load()
  return [...byDevice.values()].filter(record => record.username === username && record.revokedAt === null)
}
