#!/usr/bin/env node
// `ds-bot start|stop|restart|status`: keep the DSH web UI running in the background. The Bot
// team (and the remote-control connector) live in that process, so this is what keeps a
// computer reachable from a phone.
//
// The CLI never imports the plugin. It starts the `dsh` command the way DSH documents
// (`dsh --profile web`), detaches it, and keeps a pidfile, a log and the URL it printed.
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = `Usage: ds-bot <command> [options]

Commands:
  start      Start the web UI in the background (does nothing if it is already running)
  stop       Stop the background web UI
  restart    Stop it, then start it again
  status     Print whether it is running, with the pid, URL and log path

Options:
  --profile <name>    DSH profile to boot (default: web)
  --port <port>       Listen port; omit to use the profile's own
  --host <host>       Bind one local interface address
  --open              Open a browser as well (default: --no-open)
  --dsh <path>        The dsh executable (default: $DS_BOT_DSH, else "dsh" on PATH)
  --dsh-arg <value>   One extra argument for dsh (repeatable)
  --state-dir <dir>   Where the pidfile and log live (default: $DSH_HOME/ds-bot-web)
  --timeout <sec>     How long start waits for the port (default: 20, 0 = do not wait)
  --json              Print status as JSON
  -h, --help          Show this help

Environment:
  DSH_HOME            DSH's home; the default state directory sits under it
  DS_BOT_DSH          The dsh executable, when it is not on PATH

The web keeps serving after the shell that started it exits. On macOS or Linux a launchd or
systemd unit can call \`ds-bot start\` instead of managing it by hand.
`

const PROBE_HOSTS = new Set(['0.0.0.0', '::', ''])

function statePaths(stateDir) {
  const dir = stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ds-bot-web')
  return {
    dir,
    pid: join(dir, 'web.pid'),
    log: join(dir, 'web.log'),
    url: join(dir, 'web.url'),
  }
}

function parseArgs(argv) {
  const options = {
    command: 'help', profile: 'web', port: undefined, host: undefined, open: false,
    dsh: process.env.DS_BOT_DSH ?? 'dsh', dshArgs: [], stateDir: undefined, timeout: 20, json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('-') && options.command === 'help' && !options.seenCommand) {
      options.command = arg
      options.seenCommand = true
      continue
    }
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      index += 1
      return next
    }
    switch (arg) {
      case '-h': case '--help': options.command = 'help'; break
      case '--profile': options.profile = value(); break
      case '--port': options.port = Number(value()); break
      case '--host': options.host = value(); break
      case '--open': options.open = true; break
      case '--dsh': options.dsh = value(); break
      case '--dsh-arg': options.dshArgs.push(value()); break
      case '--state-dir': options.stateDir = value(); break
      case '--timeout': options.timeout = Number(value()); break
      case '--json': options.json = true; break
      default: throw new Error(`Unknown option: ${arg}`)
    }
  }
  if (!Number.isFinite(options.port ?? 0) || (options.port ?? 0) < 0) throw new Error('--port must be a number')
  if (!Number.isFinite(options.timeout) || options.timeout < 0) throw new Error('--timeout must be a number')
  delete options.seenCommand
  return options
}

function dshArgv(options) {
  const args = ['--profile', options.profile]
  if (!options.open) args.push('--no-open')
  if (options.host !== undefined) args.push('--host', options.host)
  if (options.port !== undefined) args.push('--port', String(options.port))
  return [...args, ...options.dshArgs]
}

function readPid(paths) {
  try {
    const pid = Number(readFileSync(paths.pid, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function alive(pid) {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A recycled pid must not be stopped: only a process still running dsh qualifies.
function looksLikeDsh(pid) {
  try {
    const text = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return /\bdsh\b|deepseek/i.test(text)
  } catch {
    return true
  }
}

function readUrl(paths) {
  try { return readFileSync(paths.url, 'utf8').trim() || undefined } catch { return undefined }
}

function writeUrl(paths, url) {
  try { if (url) writeFileSync(paths.url, url) } catch { /* the URL is a convenience only */ }
}

function clearState(paths) {
  for (const path of [paths.pid, paths.url]) {
    try { unlinkSync(path) } catch { /* already gone */ }
  }
}

function tailLog(paths, lines = 12) {
  try {
    return readFileSync(paths.log, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

function probeUrl(options) {
  if (options.port === undefined || options.port === 0) return undefined
  const host = PROBE_HOSTS.has(options.host ?? '') ? '127.0.0.1' : options.host
  return `http://${host}:${options.port}/`
}

async function waitForPort(url, timeoutSec) {
  if (url === undefined || timeoutSec <= 0) return false
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) })
      return true
    } catch { /* not listening yet */ }
    await new Promise(done => setTimeout(done, 200))
  }
  return false
}

function statusOf(paths) {
  const pid = readPid(paths)
  return {
    running: alive(pid),
    pid: alive(pid) ? pid : undefined,
    stale: pid !== undefined && !alive(pid),
    url: readUrl(paths),
    log: paths.log,
    dir: paths.dir,
  }
}

function printStatus(status, json) {
  if (json) {
    console.log(JSON.stringify(status))
    return
  }
  if (!status.running) {
    console.log('stopped')
    if (status.stale) console.log(`(removed a stale pidfile; the log is ${status.log})`)
    return
  }
  console.log(`running (pid ${status.pid})`)
  if (status.url) console.log(`url: ${status.url}`)
  console.log(`log: ${status.log}`)
}

async function start(options, paths) {
  const status = statusOf(paths)
  if (status.running) {
    console.log(`already running (pid ${status.pid})`)
    if (status.url) console.log(`url: ${status.url}`)
    return 0
  }
  clearState(paths)
  mkdirSync(paths.dir, { recursive: true })
  const fd = openSync(paths.log, 'a')
  let child
  try {
    child = spawn(options.dsh, dshArgv(options), {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: process.cwd(),
      env: process.env,
    })
  } finally {
    closeSync(fd)
  }
  child.on('error', (error) => {
    console.error(`could not start ${options.dsh}: ${error.message}`)
    if (options.dsh === 'dsh') console.error('Install DeepSeek Harness, or pass --dsh <path>.')
    process.exitCode = 1
  })
  if (child.pid === undefined) return 1
  child.unref()
  writeFileSync(paths.pid, String(child.pid))

  await new Promise(done => setTimeout(done, 400))
  if (!alive(child.pid)) {
    clearState(paths)
    console.error(`${options.dsh} exited at once. Recent log:`)
    const text = tailLog(paths)
    if (text !== '') console.error(text)
    return 1
  }

  const url = probeUrl(options)
  const ready = await waitForPort(url, options.timeout)
  writeUrl(paths, ready ? url : undefined)
  console.log(`started (pid ${child.pid})`)
  if (ready) console.log(`url: ${url}`)
  else if (url !== undefined) console.log(`no answer on ${url} yet; see ${paths.log}`)
  else console.log(`log: ${paths.log}`)
  return 0
}

async function stop(options, paths) {
  const pid = readPid(paths)
  if (!alive(pid)) {
    clearState(paths)
    console.log('stopped')
    return 0
  }
  if (!looksLikeDsh(pid)) {
    clearState(paths)
    console.log(`pid ${pid} is not dsh; left it alone and removed the stale pidfile`)
    return 0
  }
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && alive(pid)) await new Promise(done => setTimeout(done, 100))
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    while (alive(pid)) await new Promise(done => setTimeout(done, 100))
  }
  clearState(paths)
  console.log(`stopped (pid ${pid})`)
  return 0
}

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(error.message)
    console.error(USAGE)
    return 2
  }
  if (options.command === 'help' || options.command === '--help') {
    console.log(USAGE)
    return 0
  }
  const paths = statePaths(options.stateDir)
  switch (options.command) {
    case 'start': return start(options, paths)
    case 'stop': return stop(options, paths)
    case 'restart':
      await stop(options, paths)
      return start(options, paths)
    case 'status': {
      const status = statusOf(paths)
      printStatus(status, options.json)
      return status.running ? 0 : 3
    }
    default:
      console.error(`Unknown command: ${options.command}`)
      console.error(USAGE)
      return 2
  }
}

// Importing this file (from tests) must not run the CLI. npm links the bin as a symlink, so
// argv[1] is the link and the entry file is its target: resolve it before comparing.
function runAsMain() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try { return import.meta.url === pathToFileURL(realpathSync(entry)).href } catch { return false }
}
if (runAsMain()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code })
}

export { dshArgv, parseArgs, statePaths, statusOf, alive, looksLikeDsh }
