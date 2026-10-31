#!/usr/bin/env node
// `ds-bot start|stop|restart|status`: keep the DSH web UI running in the background. The Bot
// team (and the remote-control connector) live in that process, so this is what keeps a
// computer reachable from a phone.
//
// The CLI never imports the plugin. It starts the `dsh` command the way DSH documents
// (`dsh --profile web`), detaches it, and keeps a pidfile, a log and the URL it printed.
// When dsh is not installed it runs the pinned release through npx and adds this plugin to
// the profile, so a single global install of the package is enough.
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The DSH release this package is built for. The desktop app pins the same line, and dsh-update
// offers it in the UI. When dsh is not on PATH, npx runs this exact version instead of "latest".
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const DSH_SPEC = `@deepseek-ai/dsh@${process.env.DS_BOT_DSH_VERSION ?? PKG.dsBot?.verifiedDsh ?? 'latest'}`

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
  --dsh <path>        The dsh executable (default: $DS_BOT_DSH, then "dsh" on PATH, then npx)
  --dsh-arg <value>   One extra argument for dsh (repeatable)
  --state-dir <dir>   Where the pidfile and log live (default: $DSH_HOME/ds-bot-web)
  --timeout <sec>     How long start waits for the URL dsh prints (default: 20, 0 = do not wait)
  --json              Print status as JSON
  --no-setup          Do not add @lininn/ds-bot to the profile when it is missing
  -h, --help          Show this help

Environment:
  DSH_HOME            DSH's home; the default state directory sits under it
  DS_BOT_DSH          The dsh executable, when it is not on PATH
  DS_BOT_DSH_VERSION  The npx fallback version (default: the dsBot.verifiedDsh in package.json)

When dsh is not installed, start runs it through npx and adds this plugin to the profile, so
one \`npm install -g @lininn/ds-bot\` is enough. The web keeps serving after the shell that
started it exits. On macOS or Linux a launchd or systemd unit can call \`ds-bot start\`.
`

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
    dsh: process.env.DS_BOT_DSH ?? 'dsh', dshExplicit: process.env.DS_BOT_DSH !== undefined,
    dshArgs: [], stateDir: undefined, timeout: 20, json: false, setup: true,
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
      case '--dsh': options.dsh = value(); options.dshExplicit = true; break
      case '--dsh-arg': options.dshArgs.push(value()); break
      case '--state-dir': options.stateDir = value(); break
      case '--timeout': options.timeout = Number(value()); break
      case '--json': options.json = true; break
      case '--no-setup': options.setup = false; break
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

// Use an explicit dsh if given, else one on PATH, else the pinned release through npx. The
// returned prefix goes before the dsh arguments: empty for a direct call, the npx preamble
// otherwise, so the same code runs `plugin add` and boot.
function resolveDsh(options) {
  if (options.dshExplicit) return { command: options.dsh, prefix: [] }
  try {
    execFileSync(options.dsh, ['--version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
      shell: process.platform === 'win32',
    })
    return { command: options.dsh, prefix: [] }
  } catch {
    return { command: 'npx', prefix: ['-y', DSH_SPEC], npx: true }
  }
}

function profilePackage(profile) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', profile, 'package.json')
}

function hasPlugin(profile) {
  try {
    const pkg = JSON.parse(readFileSync(profilePackage(profile), 'utf8'))
    return Boolean(pkg.dependencies?.['@lininn/ds-bot'])
  } catch {
    return false
  }
}

// A fresh install has dsh but not this plugin in its profile. Add it once, so `ds-bot start`
// works on its own; --no-setup keeps that off for a profile managed by something else.
function ensurePlugin(options, dsh) {
  if (!options.setup || hasPlugin(options.profile)) return
  console.error(`adding @lininn/ds-bot to the ${options.profile} profile`)
  try {
    execFileSync(dsh.command, [...dsh.prefix, 'plugin', '--profile', options.profile, 'add', '@lininn/ds-bot'], {
      stdio: 'inherit', shell: process.platform === 'win32',
    })
  } catch {
    console.error(`could not add @lininn/ds-bot to the ${options.profile} profile; run it once by hand:`)
    console.error(`  dsh plugin --profile ${options.profile} add @lininn/ds-bot`)
    throw new Error('setup failed')
  }
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
// The full command line of a process, as the platform can report it. Windows has no `ps`,
// so it asks PowerShell for Win32_Process.CommandLine; a pid that is gone prints nothing.
function commandLine(pid) {
  const [command, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]]
    : ['ps', ['-p', String(pid), '-o', 'args=']]
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
}

function looksLikeDsh(pid) {
  try {
    return /\bdsh\b|deepseek/i.test(commandLine(pid))
  } catch {
    return true
  }
}

// Windows has no signals: a .cmd shim is a shell around the real process, so the tree goes.
// On POSIX the child is spawned detached, so it leads its own process group; signalling the
// group also stops a grandchild such as the real dsh under npx.
function terminate(pid, signal = 'SIGTERM') {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
    return
  }
  try { process.kill(-pid, signal) } catch {
    try { process.kill(pid, signal) } catch { /* already gone */ }
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

function logSize(paths) {
  try { return statSync(paths.log).size } catch { return 0 }
}

// dsh prints the page it serves once it is listening: `dsh web: http://127.0.0.1:3080/?token=…`.
// The token is new on every run, so only the bytes this run appended are considered.
const LOG_URL = /dsh web:\s*(\S+)/g

function logUrl(paths, from = 0) {
  let text
  try { text = readFileSync(paths.log).subarray(from).toString('utf8') } catch { return undefined }
  let last
  for (const match of text.matchAll(LOG_URL)) last = match[1]
  return last
}

async function waitForUrl(paths, from, timeoutSec) {
  if (timeoutSec <= 0) return undefined
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    const url = logUrl(paths, from)
    if (url !== undefined) return url
    await new Promise(done => setTimeout(done, 200))
  }
  return undefined
}

function statusOf(paths) {
  const pid = readPid(paths)
  const running = alive(pid)
  return {
    running,
    pid: running ? pid : undefined,
    stale: pid !== undefined && !running,
    // A server started by an older version, or by hand, left its URL only in the log.
    url: readUrl(paths) ?? (running ? logUrl(paths) : undefined),
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

  let dsh
  try {
    dsh = resolveDsh(options)
  } catch (error) {
    console.error(`could not look up dsh: ${error.message}`)
    return 1
  }
  if (dsh.npx) console.error(`dsh not found; running it through npx (${DSH_SPEC})`)
  try {
    ensurePlugin(options, dsh)
  } catch {
    return 1
  }

  const from = logSize(paths)
  const fd = openSync(paths.log, 'a')
  let child
  try {
    child = spawn(dsh.command, [...dsh.prefix, ...dshArgv(options)], {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: process.cwd(),
      env: process.env,
      // npm installs `dsh` and npx as .cmd shims on Windows, and Node refuses to spawn one.
      shell: process.platform === 'win32' && !/\.exe$/i.test(dsh.command),
    })
  } finally {
    closeSync(fd)
  }
  child.on('error', (error) => {
    console.error(`could not start ${dsh.command}: ${error.message}`)
    if (dsh.npx) console.error(`Check the network for npx (${DSH_SPEC}), or pass --dsh <path>.`)
    process.exitCode = 1
  })
  if (child.pid === undefined) return 1
  child.unref()
  writeFileSync(paths.pid, String(child.pid))

  await new Promise(done => setTimeout(done, 400))
  if (!alive(child.pid)) {
    clearState(paths)
    console.error(`${dsh.command} exited at once. Recent log:`)
    const text = tailLog(paths)
    if (text !== '') console.error(text)
    return 1
  }

  const url = await waitForUrl(paths, from, options.timeout)
  writeUrl(paths, url)
  console.log(`started (pid ${child.pid})`)
  if (url !== undefined) console.log(`url: ${url}`)
  else console.log(`no url yet in ${paths.log}; it appears there once dsh is listening`)
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
  terminate(pid)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && alive(pid)) await new Promise(done => setTimeout(done, 100))
  if (alive(pid)) {
    terminate(pid, 'SIGKILL')
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

export { dshArgv, parseArgs, statePaths, statusOf, alive, looksLikeDsh, resolveDsh, hasPlugin, DSH_SPEC }
