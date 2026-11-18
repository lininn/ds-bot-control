import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, parseSwitches, profilesOf, setEnabled, status, switchesIn } from '../src/host/plugins.js'

const PATCH = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: gpt

- insert:
    - id: dsh-purge
      name: dsh-purge
      inject: [ systemPrompt, tools ]
      config:
        enabled: true
        stripMnemon: true
    - id: no-switch
      name: no-switch
      config:
        other: 1
`

function homeWith(patch) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-patch-'))
  const profile = join(home, 'profiles', 'ds-bot')
  mkdirSync(profile, { recursive: true })
  if (patch !== undefined) writeFileSync(join(profile, 'cordis.patch.yml'), patch)
  return { home, profile }
}

test('parseSwitches lists only entries that carry an enabled key', () => {
  const rows = parseSwitches(PATCH)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'dsh-purge')
  assert.equal(rows[0].enabled, true)
})

test('parseSwitches reads an indented name over the id', () => {
  const text = '- id: raw\n  name: "Pretty Name"\n  config:\n    enabled: false\n'
  const [row] = parseSwitches(text)
  assert.equal(row.name, 'Pretty Name')
  assert.equal(row.enabled, false)
})

test('switchesIn reads a profile patch and tolerates a missing file', () => {
  const { home, profile } = homeWith(PATCH)
  try {
    assert.deepEqual(switchesIn(profile), [{ name: 'dsh-purge', enabled: true }])
    assert.deepEqual(switchesIn(join(home, 'nope')), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('status tags each switch with the profile it lives in', () => {
  const { home } = homeWith(PATCH)
  try {
    assert.deepEqual(status(home), { plugins: [{ profile: 'ds-bot', name: 'dsh-purge', enabled: true }] })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('setEnabled flips the value and leaves every other line as it was', () => {
  const { home, profile } = homeWith(PATCH)
  try {
    const result = setEnabled(profile, 'dsh-purge', false)
    assert.deepEqual(result, { profile: 'ds-bot', name: 'dsh-purge', enabled: false })
    const text = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(text, /enabled: false/)
    assert.match(text, /stripMnemon: true/)
    // The unrelated bundle's block is untouched.
    assert.match(text, /other: 1/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('setEnabled refuses a bundle without a switch or an unknown name', () => {
  const { home, profile } = homeWith(PATCH)
  try {
    assert.throws(() => setEnabled(profile, 'no-switch', false), /no on\/off switch/)
    assert.throws(() => setEnabled(profile, 'missing', false), /no on\/off switch/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('setEnabled reports a profile with no patch file', () => {
  const { home } = homeWith(undefined)
  try {
    assert.throws(() => setEnabled(join(home, 'profiles', 'ds-bot'), 'dsh-purge', false), /no patch file/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('profilesOf lists only directories under profiles/', () => {
  const { home } = homeWith(PATCH)
  try {
    writeFileSync(join(home, 'profiles', 'loose.txt'), 'x')
    assert.deepEqual(profilesOf(home).map(dir => dir.split('/').pop()), ['ds-bot'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('install exposes status and a guarded setEnabled', () => {
  const { home, profile } = homeWith(PATCH)
  try {
    const rt = { dshHome: home }
    install(rt)
    assert.deepEqual(rt.plugins.status(), { plugins: [{ profile: 'ds-bot', name: 'dsh-purge', enabled: true }] })
    assert.deepEqual(rt.plugins.setEnabled('ds-bot', 'dsh-purge', false), { profile: 'ds-bot', name: 'dsh-purge', enabled: false })
    // A profile name that is not under profiles/ cannot be written.
    assert.throws(() => rt.plugins.setEnabled('../escape', 'dsh-purge', true), /not here any more/)
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8').includes('enabled: false'), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
