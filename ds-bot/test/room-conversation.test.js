import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A group's id and its memory stay while its conversation moves on to a fresh relay
// Session; a copy of a group is a new group with no conversation and no memory.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Coder', role: 'Code', sessionId: 'c', createdAt: 3 },
  },
  rooms: {
    r1: {
      id: 'r1',
      name: 'Ops',
      named: true,
      members: ['a', 'b'],
      admin: 'a',
      mode: 'admin',
      notice: 'Keep it short.',
      workDir: '/tmp/ops',
      permission: 'standard',
      relayLimit: 3,
      log: [{ who: 'User', text: 'hello', seq: 1 }],
      seq: 1,
      seen: { a: 1, b: 1 },
      paused: ['b'],
      relays: 2,
      sessions: { a: 'ga', b: 'gb' },
      segments: { a: [{ sessionId: 'ga0', endedAt: 5 }] },
    },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

async function start(team = TEAM) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-room-conversation-')))
  const home = join(root, 'bot')
  const folder = join(root, 'project')
  for (const dir of [home, folder]) mkdirSync(dir)
  // The group works in a real folder, so a copy keeps it rather than falling back.
  const seed = { ...team, rooms: { ...team.rooms } }
  if (seed.rooms.r1 !== undefined) seed.rooms.r1 = { ...seed.rooms.r1, workDir: folder }
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  // What the group remembers, in the folder its memory is kept in.
  mkdirSync(join(home, 'memory', 'groups', 'r1'), { recursive: true })
  writeFileSync(join(home, 'memory', 'groups', 'r1', 'notes.md'), '- the kettle is blue\n')
  const ctx = fakeContext()
  const archived = []
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id: 'w1', path: home } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async (sessionId) => { archived.push(sessionId) },
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const memoryFile = id => join(home, 'memory', 'groups', id, 'notes.md')
  const stop = async () => {
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, home, folder, archived, saved, memoryFile, stop }
}

test('a new group conversation keeps the group and its memory and starts the Sessions over', async (t) => {
  const { rt, folder, archived, saved, memoryFile, stop } = await start()
  t.after(stop)
  const room = rt.roomOf('r1')
  const next = await rt.newRoomConversation('r1')
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(next, room)
  assert.equal(room.id, 'r1')
  assert.equal(room.sessionId, 's1')
  // The group is found by its own id and by its current relay Session.
  assert.equal(rt.roomOf('r1'), room)
  assert.equal(rt.roomOf('s1'), room)
  // A fresh log and round state.
  assert.deepEqual(room.log, [])
  assert.equal(room.seq, 0)
  assert.deepEqual(room.seen, {})
  assert.equal(room.paused, undefined)
  assert.equal(room.relays, undefined)
  // The members' earlier Sessions there are archived and the group starts them fresh.
  assert.deepEqual(room.sessions, {})
  assert.deepEqual(room.segments, {})
  assert.ok(archived.includes('ga'))
  assert.ok(archived.includes('gb'))
  assert.ok(archived.includes('r1'))
  // Its name, members, settings, and memory stay.
  assert.equal(room.name, 'Ops')
  assert.deepEqual(room.members, ['a', 'b'])
  assert.equal(room.notice, 'Keep it short.')
  assert.equal(room.workDir, folder)
  assert.ok(existsSync(memoryFile('r1')))
  // The saved team names the new relay Session.
  assert.equal(saved().rooms.r1.sessionId, 's1')
})

test('a new group conversation waits while the group is working', async (t) => {
  const { rt, stop } = await start()
  t.after(stop)
  rt.roomProgress.set('call-1', { roomId: 'r1', replies: [] })
  await assert.rejects(rt.newRoomConversation('r1'), /in the middle of a round/)
  rt.roomProgress.delete('call-1')
  rt.live.set('ga', { turn: 1 })
  await assert.rejects(rt.newRoomConversation('r1'), /still working/)
  rt.live.delete('ga')
})

test('a copy of a group takes its members and settings but not its conversation or memory', async (t) => {
  const { rt, folder, saved, memoryFile, stop } = await start()
  t.after(stop)
  const copy = await rt.duplicateRoom('r1')

  assert.notEqual(copy.id, 'r1')
  assert.equal(copy.name, 'Ops copy')
  assert.deepEqual(copy.members, ['a', 'b'])
  assert.equal(copy.admin, 'a')
  assert.equal(copy.mode, 'admin')
  assert.equal(copy.notice, 'Keep it short.')
  assert.equal(copy.workDir, folder)
  assert.equal(copy.permission, 'standard')
  assert.equal(copy.relayLimit, 3)
  // A new conversation, not the original log or its sessions.
  assert.equal(copy.log, undefined)
  assert.equal(copy.seq, undefined)
  assert.equal(copy.sessions, undefined)
  assert.equal(rt.roomOf(copy.id), copy)
  // The copy's memory folder is new; the original keeps its own.
  assert.equal(existsSync(memoryFile(copy.id)), false)
  assert.ok(existsSync(memoryFile('r1')))
  assert.equal(saved().rooms[copy.id].name, 'Ops copy')

  const again = await rt.duplicateRoom('r1')
  assert.equal(again.name, 'Ops copy 2')
})
