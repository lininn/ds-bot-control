import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bundleRunning, bundleVersion, chooseTarget, installBundle, installDecision, installPlan, installedIn } from '../src/install-app.mjs'

const appAt = folder => join(folder, 'DeepSeek Bot.app')
const executable = bundle => join(bundle, 'Contents', 'MacOS', 'DeepSeek Bot')

test('a packaged macOS app outside the application folders is installed', () => {
  const plan = installPlan({ isPackaged: true, platform: 'darwin', execPath: executable('/Users/a/Desktop/DeepSeek Bot.app'), env: {}, home: '/Users/a' })
  assert.equal(plan.bundle, '/Users/a/Desktop/DeepSeek Bot.app')
  assert.equal(plan.name, 'DeepSeek Bot.app')
  assert.deepEqual(plan.folders, ['/Applications', '/Users/a/Applications'])
})

test('an installed app, a development run and a throwaway run are left alone', () => {
  const plan = options => installPlan({ isPackaged: true, platform: 'darwin', env: {}, home: '/Users/a', ...options })
  assert.equal(plan({ execPath: executable('/Applications/DeepSeek Bot.app') }), undefined)
  assert.equal(plan({ execPath: executable('/Users/a/Applications/DeepSeek Bot.app') }), undefined)
  assert.equal(installPlan({ isPackaged: false, platform: 'darwin', execPath: executable('/Users/a/Desktop/DeepSeek Bot.app'), env: {} }), undefined)
  assert.equal(plan({ execPath: executable('/Users/a/Desktop/DeepSeek Bot.app'), env: { DS_BOT_HOME: '/tmp/throwaway' } }), undefined)
  assert.equal(plan({ execPath: executable('/Users/a/Desktop/DeepSeek Bot.app'), env: { DS_BOT_NO_INSTALL: '1' } }), undefined)
  assert.equal(installPlan({ isPackaged: true, platform: 'win32', execPath: executable('/Users/a/Desktop/DeepSeek Bot.app'), env: {} }), undefined)
})

test('a folder counts as an application folder by itself, not by a parent of it', () => {
  const folders = ['/Applications', '/Users/a/Applications']
  assert.equal(installedIn('/Applications/DeepSeek Bot.app', folders), true)
  assert.equal(installedIn('/Users/a/Applications/DeepSeek Bot.app', folders), true)
  assert.equal(installedIn('/Applications/Sub/DeepSeek Bot.app', folders), false)
  assert.equal(installedIn('/Users/a/Desktop/DeepSeek Bot.app', folders), false)
})

test('the target is the first application folder the user can write to', () => {
  const plan = { name: 'DeepSeek Bot.app', folders: ['/Applications', '/Users/a/Applications'] }
  assert.equal(chooseTarget({ ...plan, writable: () => true }), '/Applications/DeepSeek Bot.app')
  assert.equal(chooseTarget({ ...plan, writable: folder => folder !== '/Applications' }), '/Users/a/Applications/DeepSeek Bot.app')
  assert.equal(chooseTarget({ ...plan, writable: () => false }), '/Users/a/Applications/DeepSeek Bot.app')
})

test('a missing copy is installed, an equal or newer one is opened, and an older one is replaced', async () => {
  const plan = { bundle: '/Users/a/Desktop/DeepSeek Bot.app', name: 'DeepSeek Bot.app', folders: ['/Applications'] }
  const decide = options => installDecision(plan, { version: '0.2.9', run: async () => ({}), writable: () => true, running: async () => false, ...options })
  assert.deepEqual(await decide({ exists: () => false }), { action: 'install', source: plan.bundle, target: '/Applications/DeepSeek Bot.app' })
  assert.deepEqual(await decide({ exists: () => true, installedVersion: async () => '0.2.9' }), { action: 'open', target: '/Applications/DeepSeek Bot.app' })
  assert.deepEqual(await decide({ exists: () => true, installedVersion: async () => '0.2.10' }), { action: 'open', target: '/Applications/DeepSeek Bot.app' })
  assert.deepEqual(await decide({ exists: () => true, installedVersion: async () => '0.2.8' }), { action: 'replace', source: plan.bundle, target: '/Applications/DeepSeek Bot.app' })
})

test('an older installed app that is open is not replaced under its processes', async () => {
  const plan = { bundle: '/Users/a/Desktop/DeepSeek Bot.app', name: 'DeepSeek Bot.app', folders: ['/Applications'] }
  const decision = await installDecision(plan, {
    version: '0.2.9', run: async () => ({}), writable: () => true,
    exists: () => true, installedVersion: async () => '0.2.8', running: async () => true,
  })
  assert.deepEqual(decision, { action: 'busy', target: '/Applications/DeepSeek Bot.app' })
})

test('a bundle version comes from Info.plist, or is undefined when it cannot be read', async () => {
  const run = async () => { throw new Error('no plist') }
  assert.equal(await bundleVersion('/Applications/DeepSeek Bot.app', run), undefined)
  const reads = async (command, args) => {
    assert.equal(command, '/usr/libexec/PlistBuddy')
    assert.deepEqual(args.slice(0, 2), ['-c', 'Print :CFBundleShortVersionString'])
    return { stdout: '0.2.9\n', stderr: '' }
  }
  assert.equal(await bundleVersion('/Applications/DeepSeek Bot.app', reads), '0.2.9')
})

test('an open app is seen through pgrep, and a pgrep miss means it is not running', async () => {
  assert.equal(await bundleRunning('/Applications/DeepSeek Bot.app', async () => ({ stdout: '123\n' })), true)
  assert.equal(await bundleRunning('/Applications/DeepSeek Bot.app', async () => { const error = new Error('no match'); error.code = 1; throw error }), false)
})

// ditto copies the bundle; the commands themselves are the ones this process would run.
const copier = (calls) => async (command, args) => {
  calls.push([command, args])
  if (command === 'ditto') cpSync(args[0], args[1], { recursive: true })
  return { stdout: '', stderr: '' }
}

function writeApp(bundle, content) {
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(bundle, 'Contents', 'MacOS', 'DeepSeek Bot'), content)
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-install-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  const source = appAt(join(root, 'Download'))
  writeApp(source, 'new')
  return { root, source, target: appAt(join(root, 'Applications')) }
}

test('the bundle is copied beside the target, has its quarantine removed, and is renamed into place', async (t) => {
  const { source, target } = setup(t)
  const calls = []
  await installBundle({ source, target, run: copier(calls) })
  assert.equal(readFileSync(join(target, 'Contents', 'MacOS', 'DeepSeek Bot'), 'utf8'), 'new')
  assert.deepEqual(calls.map(([command]) => command), ['ditto', 'xattr'])
  assert.deepEqual(readdirSync(join(target, '..')).filter(name => name.startsWith('.')), [])
})

test('an older app is replaced as a whole, and a failed copy leaves it as it was', async (t) => {
  const { source, target } = setup(t)
  writeApp(target, 'old')
  await installBundle({ source, target, run: copier([]) })
  assert.equal(readFileSync(join(target, 'Contents', 'MacOS', 'DeepSeek Bot'), 'utf8'), 'new')

  writeApp(target, 'keep')
  const failing = async (command, args) => {
    if (command === 'ditto') {
      cpSync(args[0], args[1], { recursive: true })
      throw new Error('the copy failed')
    }
    return { stdout: '', stderr: '' }
  }
  await assert.rejects(installBundle({ source, target, run: failing }), /the copy failed/)
  assert.equal(readFileSync(join(target, 'Contents', 'MacOS', 'DeepSeek Bot'), 'utf8'), 'keep')
  assert.deepEqual(readdirSync(join(target, '..')).filter(name => name.startsWith('.')), [])
})

test('the source bundle and its download folder are not changed', async (t) => {
  const { root, source, target } = setup(t)
  await installBundle({ source, target, run: copier([]) })
  assert.equal(existsSync(join(target, 'Contents', 'MacOS', 'DeepSeek Bot')), true)
  assert.equal(readFileSync(join(source, 'Contents', 'MacOS', 'DeepSeek Bot'), 'utf8'), 'new')
  assert.deepEqual(readdirSync(join(root, 'Download')), ['DeepSeek Bot.app'])
})
