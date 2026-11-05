// macOS runs a downloaded zip's app from a translocated, read-only path: the app is never in
// the Applications folder, and it dies when the folder it was opened from goes away. The app
// copies itself into Applications at its first start and starts again from there, so that a
// downloaded copy behaves like an installed app: the zip and the unzipped copy can be deleted.
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { installFolder } from './move-data.mjs'
import { isNewer } from './updates.mjs'

const execFileAsync = promisify(execFile)
const QUARANTINE = 'com.apple.quarantine'

/** Where an installed app belongs: the system folder first, then the user's own. */
export function applicationFolders({ home = homedir(), applications = '/Applications' } = {}) {
  return [resolve(applications), resolve(join(home, 'Applications'))]
}

/** True when the bundle already sits in one of the application folders. */
export function installedIn(bundle, folders) {
  const folder = resolve(dirname(bundle))
  return folders.some(candidate => resolve(candidate) === folder)
}

/**
 * What a macOS run has to do before it starts, or undefined when it is already installed
 * (or is a development or throwaway run, which installs nothing).
 * @param {{ isPackaged: boolean, platform?: string, execPath: string, env?: NodeJS.ProcessEnv, home?: string, applications?: string }} options
 * @returns {{ bundle: string, name: string, folders: string[] } | undefined}
 */
export function installPlan({ isPackaged, platform = process.platform, execPath, env = process.env, home = homedir(), applications = '/Applications' }) {
  if (platform !== 'darwin' || !isPackaged) return undefined
  if (env.DS_BOT_HOME || env.DS_BOT_NO_INSTALL === '1') return undefined
  const bundle = installFolder(execPath, platform)
  if (!bundle.endsWith('.app')) return undefined
  const folders = applicationFolders({ home, applications })
  if (installedIn(bundle, folders)) return undefined
  return { bundle, name: basename(bundle), folders }
}

function writableFolder(folder) {
  try {
    accessSync(folder, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The first application folder the user can write to; the user's own folder otherwise. */
export function chooseTarget({ name, folders, writable = writableFolder }) {
  return join(folders.find(folder => writable(folder)) ?? folders[folders.length - 1], name)
}

/** The version of an app bundle: what its Info.plist says, or undefined when it cannot be read. */
export async function bundleVersion(bundle, run = execFileAsync) {
  try {
    const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(bundle, 'Contents', 'Info.plist')])
    const version = stdout.trim()
    return version === '' ? undefined : version
  } catch {
    return undefined
  }
}

/** True when an app of that bundle is open. */
export async function bundleRunning(bundle, run = execFileAsync) {
  const pattern = `${join(bundle, 'Contents', 'MacOS').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/`
  try {
    const { stdout } = await run('pgrep', ['-f', pattern])
    return stdout.trim() !== ''
  } catch {
    // pgrep exits 1 when nothing matches.
    return false
  }
}

/**
 * How the run should reach the application folder: copy this bundle ('install'), replace an
 * older app there ('replace'), just open what is there ('open'), or stop because that app is
 * open and would lose its files under it ('busy').
 * @param {{ bundle: string, name: string, folders: string[] }} plan
 */
export async function installDecision(plan, {
  version, run = execFileAsync, exists = existsSync, writable = writableFolder,
  installedVersion = target => bundleVersion(target, run),
  running = target => bundleRunning(target, run),
} = {}) {
  const target = chooseTarget({ name: plan.name, folders: plan.folders, writable })
  if (!exists(target)) return { action: 'install', source: plan.bundle, target }
  const installed = await installedVersion(target)
  if (installed !== undefined && (installed === version || isNewer(installed, version))) return { action: 'open', target }
  // Replacing a running app takes the files of its processes away, which macOS ends with
  // SIGBUS. The user quits it and opens this copy again.
  if (await running(target)) return { action: 'busy', target }
  return { action: 'replace', source: plan.bundle, target }
}

/**
 * Copy an app bundle beside its target with ditto (which keeps the signature and every
 * attribute), then rename it into place. An app already there is kept until the new one is
 * whole, so a copy that fails leaves the installed app as it was.
 * @param {{ source: string, target: string, run?: typeof execFileAsync }} options
 */
export async function installBundle({ source, target, run = execFileAsync }) {
  const folder = dirname(target)
  mkdirSync(folder, { recursive: true })
  const name = basename(target)
  const staging = join(folder, `.${name}.installing-${String(process.pid)}`)
  const replaced = join(folder, `.${name}.replaced-${String(process.pid)}`)
  rmSync(staging, { recursive: true, force: true })
  try {
    await run('ditto', [source, staging])
    // A copy of a download is quarantined; an app that the user installed is not.
    await run('xattr', ['-dr', QUARANTINE, staging]).catch(() => {})
    if (existsSync(target)) {
      rmSync(replaced, { recursive: true, force: true })
      renameSync(target, replaced)
      try {
        renameSync(staging, target)
      } catch (error) {
        renameSync(replaced, target)
        throw error
      }
      rmSync(replaced, { recursive: true, force: true })
    } else {
      renameSync(staging, target)
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return target
}

/** Open the installed app; the run that installed it ends. */
export async function openBundle(target, run = execFileAsync) {
  await run('open', [target])
}
