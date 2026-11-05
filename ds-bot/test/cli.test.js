import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { DSH_SPEC, dshArgv, parseArgs, resolveDsh, statePaths } from '../bin/ds-bot.js'

const CLI = resolve(import.meta.dirname, '../bin/ds-bot.js')

test('parseArgs reads the command and its options', () => {
  const options = parseArgs([
    'start', '--profile', 'web', '--port', '8080', '--host', '0.0.0.0', '--open',
    '--dsh', '/usr/local/bin/dsh', '--dsh-arg', '--foo', '--dsh-arg', 'bar',
    '--state-dir', '/tmp/x', '--timeout', '5', '--json',
  ])
  assert.deepEqual(options, {
    command: 'start', profile: 'web', port: 8080, host: '0.0.0.0', open: true,
    dsh: '/usr/local/bin/dsh', dshExplicit: true, dshArgs: ['--foo', 'bar'],
    stateDir: '/tmp/x', timeout: 5, json: true, setup: true,
  })
})

test('parseArgs defaults to the background web profile', () => {
  const options = parseArgs([])
  assert.equal(options.command, 'help')
  assert.equal(options.profile, 'web')
  assert.equal(options.port, undefined)
  assert.equal(options.open, false)
  assert.deepEqual(options.dshArgs, [])
  assert.equal(options.timeout, 20)
  assert.equal(options.json, false)
  assert.equal(options.setup, true)
  assert.equal(options.dshExplicit, false)
})

test('--no-setup keeps start from touching the profile', () => {
  assert.equal(parseArgs(['start', '--no-setup']).setup, false)
})

test('resolveDsh keeps an explicit dsh and falls back to npx otherwise', () => {
  assert.deepEqual(resolveDsh({ dsh: '/nope/dsh', dshExplicit: true }), { command: '/nope/dsh', prefix: [] })
  const fallback = resolveDsh({ dsh: join(tmpdir(), 'no-such-dsh-for-test'), dshExplicit: false })
  assert.equal(fallback.command, 'npx')
  assert.deepEqual(fallback.prefix, ['-y', DSH_SPEC])
  assert.equal(fallback.npx, true)
})

test('parseArgs rejects bad numbers and unknown options', () => {
  assert.throws(() => parseArgs(['start', '--port', 'nope']), /--port must be a number/)
  assert.throws(() => parseArgs(['start', '--timeout', '-1']), /--timeout must be a number/)
  assert.throws(() => parseArgs(['start', '--bogus']), /Unknown option/)
  assert.throws(() => parseArgs(['start', '--port']), /needs a value/)
})

test('dshArgv starts detachably with --no-open unless asked', () => {
  assert.deepEqual(dshArgv(parseArgs(['start'])), ['--profile', 'web', '--no-open'])
  assert.deepEqual(
    dshArgv(parseArgs(['start', '--open', '--host', '127.0.0.1', '--port', '3000', '--dsh-arg', '--trusted-host', '--dsh-arg', 'ds.test'])),
    ['--profile', 'web', '--host', '127.0.0.1', '--port', '3000', '--trusted-host', 'ds.test'],
  )
})

test('statePaths puts the pid, log and url under DSH_HOME by default', (t) => {
  const previous = process.env.DSH_HOME
  const home = '/tmp/dsh-home'
  process.env.DSH_HOME = home
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous })
  const paths = statePaths()
  assert.equal(paths.dir, join(home, 'ds-bot-web'))
  assert.equal(paths.pid, join(home, 'ds-bot-web', 'web.pid'))
  assert.equal(paths.log, join(home, 'ds-bot-web', 'web.log'))
  assert.equal(paths.url, join(home, 'ds-bot-web', 'web.url'))
  assert.equal(statePaths('/srv/bot').pid, join('/srv/bot', 'web.pid'))
})

// A stand-in dsh: ignores the profile flags and stays up until it is told to stop. Windows
// npm shims are .cmd files, and its shell has no `sleep`, so each platform gets its own form;
// both spend their time in node, and both keep "dsh" in the command line that `stop` inspects.
function fakeDsh(dir, announce) {
  const sleeper = join(dir, 'fake-dsh-sleeper.js')
  writeFileSync(sleeper, 'setInterval(() => {}, 1000)\n')
  if (process.platform === 'win32') {
    const path = join(dir, 'fake-dsh.cmd')
    const line = announce === undefined ? '' : `echo dsh web: ${announce}\r\n`
    writeFileSync(path, `@echo off\r\n${line}"${process.execPath}" "${sleeper}"\r\n`)
    return path
  }
  const path = join(dir, 'fake-dsh')
  const line = announce === undefined ? '' : `echo "dsh web: ${announce}"\n`
  writeFileSync(path, `#!/bin/sh\n${line}exec "${process.execPath}" "${sleeper}"\n`)
  chmodSync(path, 0o755)
  return path
}

test('the CLI starts, reports and stops the background web', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-cli-'))
  const state = join(dir, 'state')
  const dsh = fakeDsh(dir)
  // --no-setup keeps the stand-in dsh from being asked to add the plugin to a real profile.
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--no-setup', '--state-dir', state], { encoding: 'utf8', timeout: 20_000 })
  t.after(() => {
    run('stop')
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })

  const started = run('start', '--dsh', dsh, '--timeout', '0')
  assert.equal(started.status, 0, started.stderr)
  assert.match(started.stdout, /^started \(pid \d+\)/m)
  const pid = Number(readFileSync(join(state, 'web.pid'), 'utf8').trim())
  assert.ok(pid > 0)
  assert.equal(existsSync(join(state, 'web.log')), true)

  // A second start says it is already running instead of spawning another.
  const again = run('start', '--dsh', dsh, '--timeout', '0')
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /^already running \(pid \d+\)/m)

  const status = run('status', '--json')
  assert.equal(status.status, 0, status.stderr)
  assert.deepEqual(JSON.parse(status.stdout).running, true)

  const stopped = run('stop')
  assert.equal(stopped.status, 0, stopped.stderr)
  assert.match(stopped.stdout, /^stopped \(pid \d+\)/m)
  assert.equal(existsSync(join(state, 'web.pid')), false)

  // Nothing is running now, which status reports with exit code 3.
  assert.equal(run('status').status, 3)
})

// npm links the bin on POSIX; on Windows it writes .cmd shims instead, so there is no link.
test('the CLI still runs when npm exposes it as a symlink', { skip: process.platform === 'win32' ? 'no bin symlink on Windows' : false }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-cli-'))
  // npm links node_modules/.bin/ds-bot to the package's file; argv[1] is then the link.
  const link = join(dir, 'ds-bot-link')
  symlinkSync(CLI, link)
  const state = join(dir, 'state')
  mkdirSync(state)
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  const result = spawnSync(process.execPath, [link, 'status', '--state-dir', state], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(result.status, 3, result.stderr)
  assert.equal(result.stdout.trim(), 'stopped')
})

test('stop leaves a recycled pid alone and clears the stale pidfile', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-cli-'))
  const state = join(dir, 'state')
  mkdirSync(state)
  // The test process is alive but is not dsh.
  writeFileSync(join(state, 'web.pid'), String(process.pid))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  const stopped = spawnSync(process.execPath, [CLI, 'stop', '--state-dir', state], { encoding: 'utf8', timeout: 20_000 })
  assert.equal(stopped.status, 0, stopped.stderr)
  assert.match(stopped.stdout, /is not dsh; left it alone/)
  assert.equal(existsSync(join(state, 'web.pid')), false)
})
