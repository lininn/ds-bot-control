import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { MIGRATION_LOG } from '../src/host/migrate.js'

const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', model: 'deepseek/deepseek-chat', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {
    r1: {
      id: 'r1', name: 'Ops', named: true, members: ['a', 'b'], admin: 'a', mode: 'admin', notice: '',
      log: [], seq: 0, seen: {}, relays: 2, relayLimit: 3,
    },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
  // A field this release does not know is the user's, not ours to drop.
  customField: { keep: true },
})

function open(home) {
  const ctx = fakeContext()
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  return { ctx, call }
}

const homeWith = (saved) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-migration-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(saved))
  return home
}
const backups = home => readdirSync(home).filter(name => /^state\.json\.bak-\d+$/.test(name))

test('the first new-baseline launch keeps the old team and records the retired relay settings', async (t) => {
  const home = homeWith(team())
  mkdirSync(join(home, 'memory', 'groups', 'r1'), { recursive: true })
  writeFileSync(join(home, 'memory', 'groups', 'r1', 'notes.md'), '- keep me\n')
  const { ctx, call } = open(home)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })

  const state = (await call('state', {})).value
  assert.equal(state.bots.find(bot => bot.id === 'a').name, 'Chief')
  assert.equal(state.rooms.find(room => room.id === 'r1').name, 'Ops')

  const [backup] = backups(home)
  assert.ok(backup !== undefined, 'a backup of the old team was made')
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const old = JSON.parse(readFileSync(join(home, backup), 'utf8'))
  // The backup is the team before the new baseline touched it.
  assert.equal(old.rooms.r1.relays, 2)
  assert.equal(old.rooms.r1.relayLimit, 3)
  assert.deepEqual(old.customField, { keep: true })
  // The team keeps its bots, its group, its model settings, and the field we do not know.
  assert.equal(saved.version, 1)
  assert.equal(saved.bots.a.model, 'deepseek/deepseek-chat')
  assert.equal(saved.rooms.r1.name, 'Ops')
  assert.deepEqual(saved.customField, { keep: true })
  assert.equal(saved.rooms.r1.relays, undefined)
  assert.equal(saved.rooms.r1.relayLimit, undefined)
  assert.equal(readFileSync(join(home, 'memory', 'groups', 'r1', 'notes.md'), 'utf8'), '- keep me\n')
  // The migration log names both retired settings.
  const log = readFileSync(join(home, MIGRATION_LOG), 'utf8')
  assert.match(log, /r1: relays=2/)
  assert.match(log, /r1: relayLimit=3/)
})

test('a later launch finds the backup and does not make another', async (t) => {
  const home = homeWith(team())
  const first = open(home)
  await first.call('state', {})
  await first.ctx.dispose()
  const [backup] = backups(home)
  assert.ok(backup !== undefined)

  const second = open(home)
  t.after(async () => { await second.ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await second.call('state', {})
  assert.deepEqual(backups(home), [backup])
})

// chmod does not make a folder unwritable on Windows, so the copy cannot be made to fail there.
test('a migration that cannot be backed up leaves state.json untouched', { skip: process.platform === 'win32' && 'chmod does not make a folder unwritable on Windows' }, async (t) => {
  const home = homeWith(team())
  const original = readFileSync(join(home, 'state.json'), 'utf8')
  chmodSync(home, 0o500)
  const { ctx, call } = open(home)
  // Dispose first: the plugin may still write under the home while it shuts down.
  t.after(async () => {
    await ctx.dispose()
    chmodSync(home, 0o700)
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })

  const answer = await call('state', {})
  assert.notEqual(answer.ok, true)
  assert.equal(readFileSync(join(home, 'state.json'), 'utf8'), original)
  assert.equal(existsSync(join(home, MIGRATION_LOG)), false)
})
