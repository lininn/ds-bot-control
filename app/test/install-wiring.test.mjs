import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TEXT, t } from '../src/start/text.mjs'

// The rebuild on upstream v0.2.7 kept install-app.mjs and its tests but lost the main-process
// wiring, so downloaded Mac apps ran translocated forever and vanished with their folder. This
// guards the wiring itself; install-app.test.mjs covers what the installer does.
const main = readFileSync(fileURLToPath(new URL('../src/main.mjs', import.meta.url)), 'utf8')

test('a downloaded macOS app is installed before the app starts', () => {
  assert.equal(main.includes("from './install-app.mjs'"), true)
  assert.equal(main.includes('installPlan({ isPackaged: app.isPackaged, execPath: process.execPath })'), true)
  assert.equal(main.includes('if (pendingInstall !== undefined) { await installAndRelaunch(pendingInstall); return }'), true)
  assert.equal(main.includes('async function installAndRelaunch('), true)
})

test('the install dialogs exist in both languages', () => {
  for (const lang of ['zh', 'en']) {
    for (const key of ['dialog.installBusy', 'dialog.installFailed']) {
      assert.equal(typeof TEXT[lang][key], 'string', `${lang} ${key}`)
      assert.notEqual(t(lang, key), key)
    }
  }
  assert.match(t('en', 'dialog.installBusy', { target: '/Applications/DS Bot.app' }), /\/Applications\/DS Bot\.app/)
  assert.match(t('zh', 'dialog.installFailed', { message: 'denied' }), /denied/)
})
