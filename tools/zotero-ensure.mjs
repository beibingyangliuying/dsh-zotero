#!/usr/bin/env node
// Make the reference library answer, or say in one look why it cannot.
//
// WHY THIS EXISTS
//
// Seven helpers reach the owner's library through its local API and through nothing else. When the
// application is not running, every one of them fails the same way, and a bare `ECONNREFUSED` names no
// next step: it reads like a broken instrument, which is how a caller talks itself into reading the
// library by another route - the database file, or the stored attachments picked out by path. Those
// routes lose the record key, so what they read can be written onto nothing, compared against no note,
// and checked by no reader. The missing piece is therefore an instrument that makes the application
// answer, not a fallback that reads around it.
//
// WHAT IT WILL AND WILL NOT DO
//
//   * It starts the application when nothing answers AND no process is running. Nothing else: it never
//     writes a preference, never kills or restarts the application, and never starts a second copy - the
//     application is single-instance, so a launch while it runs only raises its window.
//   * It does NOT launch when `ZOTERO_LOCAL_API` names an address. That seam means "a stub library, or
//     another instance", and a test that believes it is talking to a stub must never wake the real
//     application. `ZOTERO_EXE=off` disables launching and keeps the probe.
//   * `--dry-run` prints the command instead of running it. The default is a REAL launch, the opposite
//     of the write helpers: their dry run protects the owner's data, while a dry-run default here would
//     make the one thing this command exists for the thing it does not do.
//
// EXIT CODES
//
//   0  the library answers - already, or after this started it (also: a dry run of the launch plan)
//   1  it does not answer, and nothing this command can do will change that without the owner
//   2  usage
//
// There is no third answer. A write gets one, because HTTP names a response and not an effect; starting
// a process has no "may have happened", and an exit code meaning "probably fine in a moment" would only
// invite the retry loop this command exists to replace.
//
// Usage: node tools/zotero-ensure.mjs [--wait 30] [--dry-run] [--help]
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localOrigin, localRequest } from './zotero-local-api.mjs'
import { UsageError, reportFailure } from './refusal.mjs'

const DEFAULT_WAIT_SECONDS = 30
const MAX_WAIT_SECONDS = 300
const POLL_INTERVAL_MS = 500
const PROBE_TIMEOUT_MS = 2000
/**
 * How long to wait when the process is ALREADY there but nothing answers.
 *
 * That state has two causes this command cannot tell apart: the owner opened the application a moment
 * ago and it is still coming up, or its local API is switched off. A short grace gives the first cause
 * its chance; the full wait would make the second one cost half a minute every time.
 */
const GRACE_WHEN_RUNNING_MS = 5000

const USAGE =
  'Usage: node tools/zotero-ensure.mjs [--wait 30] [--dry-run] [--help]\n' +
  '       0 = the library answers | 1 = it does not, and this command cannot make it | 2 = usage\n'

/** The Windows uninstall keys, HKLM as well as HKCU: an install can be per-user or per-machine. */
const WINDOWS_UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zotero',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Zotero',
]

/**
 * Every place an install could be, most specific first, without touching the disk.
 *
 * The Windows registry comes before the standard directories because that is where this preset
 * MEASURED the application on its owner's machine (`InstallLocation`), and `zotero` is not on `PATH`
 * there - so a lookup by command name would find nothing on the one machine the preset is used on.
 *
 * @param {{platform?: string, env?: object, registry?: () => string}} [options] The seams: `registry`
 *   answers with an install directory or `''`, so the order can be tested without a registry.
 * @returns {Array<{path: string, from: string}>} Candidate executables, in the order to try them.
 */
export function executableCandidates({ platform = process.platform, env = process.env, registry = registryInstallLocation } = {}) {
  const candidates = []
  const override = String(env.ZOTERO_EXE ?? '').trim()
  if (override !== '' && override.toLowerCase() !== 'off') candidates.push({ path: override, from: 'ZOTERO_EXE' })
  if (platform === 'win32') {
    const location = String(registry() ?? '').trim()
    if (location !== '') candidates.push({ path: join(location, 'zotero.exe'), from: 'the uninstall registry key' })
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (String(base ?? '').trim() !== '') {
        candidates.push({ path: join(base, 'Zotero', 'zotero.exe'), from: 'the standard install directory' })
      }
    }
  }
  if (platform === 'darwin') {
    candidates.push({ path: '/Applications/Zotero.app/Contents/MacOS/zotero', from: 'the standard install location' })
  }
  const command = platform === 'win32' ? 'zotero.exe' : 'zotero'
  // The separator and the joiner follow the platform being DESCRIBED, not the one running: this
  // function is asked about `darwin` from a Windows machine in its own self-test, and `path.delimiter`
  // would answer with the host's ';' and turn that whole PATH into one nonsense entry.
  const separator = platform === 'win32' ? ';' : ':'
  const joinPath = platform === 'win32' ? join : posix.join
  for (const directory of String(env.PATH ?? '').split(separator)) {
    if (directory.trim() !== '') candidates.push({ path: joinPath(directory, command), from: 'PATH' })
  }
  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = `${candidate.path.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The first candidate that exists.
 *
 * @param {{platform?: string, env?: object, registry?: () => string, exists?: (path: string) => boolean}} [options]
 *   `exists` is the disk seam.
 * @returns {{found: {path: string, from: string}|null, candidates: Array<{path: string, from: string}>}}
 *   `candidates` is carried out on failure so the caller can say where it looked instead of "not found".
 */
export function findExecutable({ exists = existsSync, ...options } = {}) {
  const candidates = executableCandidates(options)
  const found = candidates.find((candidate) => exists(candidate.path)) ?? null
  return { found, candidates }
}

/** Whether `ZOTERO_EXE=off` was asked for: probe only, never launch. */
export function launchDisabled(env = process.env) {
  return String(env.ZOTERO_EXE ?? '').trim().toLowerCase() === 'off'
}

/**
 * Whether the application's process is present.
 *
 * Only the wording depends on this, never the decision to launch: a launch while it runs is harmless
 * (single instance), so an unreadable process list must not be a reason to do nothing.
 *
 * @param {{platform?: string, run?: (platform: string) => string}} [options] `run` is the seam.
 * @returns {boolean} True when the process is there.
 */
export function processRunning({ platform = process.platform, run = runProcessList } = {}) {
  try {
    return parseProcessList(run(platform))
  } catch {
    return false
  }
}

/**
 * Read a process listing for the application's image name.
 *
 * A localized `tasklist` answers "no tasks match" in its own language, and that line carries no image
 * name either, so the name alone decides: it is present exactly when a process is.
 *
 * @param {string} output What the listing command printed.
 * @returns {boolean} True when a process with that image name is listed.
 */
export function parseProcessList(output) {
  return /\bzotero(\.exe)?\b/i.test(String(output))
}

/** @returns {string} The process listing, or throws when the platform has no command for it. */
function runProcessList(platform) {
  const command = platform === 'win32' ? 'tasklist' : 'pgrep'
  const args = platform === 'win32' ? ['/FI', 'IMAGENAME eq zotero.exe', '/NH'] : ['-x', 'zotero']
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * The install directory the Windows uninstall key records, or `''`.
 *
 * Read with `reg` rather than a new dependency: one value, one format, and a failure means "try the
 * standard directories next" rather than an error.
 *
 * @returns {string} The recorded directory, or `''` when the key or the value is absent.
 */
function registryInstallLocation() {
  for (const key of WINDOWS_UNINSTALL_KEYS) {
    try {
      const output = execFileSync('reg', ['query', key, '/v', 'InstallLocation'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const match = output.match(/InstallLocation\s+REG_\w+\s+(.+)/)
      if (match) return match[1].trim()
    } catch {
      // The key is not there, or this platform has no `reg`; both mean "not found this way".
    }
  }
  return ''
}

/**
 * One bounded look at the address.
 *
 * @returns {Promise<{answering: boolean, version?: string, serverId?: string, reason?: string}>} The
 *   answer, never a throw: "nothing is listening" is the expected case, not a failure of this command.
 */
async function probe() {
  try {
    const res = await localRequest('GET', '/api/', { timeoutMs: PROBE_TIMEOUT_MS })
    const serverId = res.headers['zotero-server-id'] ?? ''
    if (res.status === 200 && serverId !== '') {
      return { answering: true, version: res.headers['x-zotero-version'] ?? '?', serverId }
    }
    return { answering: false, reason: `it answered HTTP ${res.status}` }
  } catch (error) {
    return { answering: false, reason: error?.code ?? String(error?.message ?? error) }
  }
}

/** Sleep, so the poll loop reads as a loop rather than as a chain of timers. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll until the library answers or the ceiling passes.
 *
 * @param {number} ceilingMs How long to keep asking.
 * @returns {Promise<{answering: boolean, waitedMs: number, answer?: object}>} What happened.
 */
async function waitForAnswer(ceilingMs) {
  const startedAt = Date.now()
  for (;;) {
    const answer = await probe()
    if (answer.answering) return { answering: true, waitedMs: Date.now() - startedAt, answer }
    if (Date.now() - startedAt + POLL_INTERVAL_MS >= ceilingMs) return { answering: false, waitedMs: Date.now() - startedAt }
    await sleep(POLL_INTERVAL_MS)
  }
}

/** Print one `key : value` line; the helpers all report this way and an agent reads it as data. */
function column(key, value) {
  console.log(`${key.padEnd(7)} : ${value}`)
}

/**
 * Start the application and do not wait for it.
 *
 * Unref'd and detached: this command exits as soon as the library answers, and the application must not
 * die with it. A launch failure is reported rather than swallowed, because "I could not start it" is a
 * different answer from "it started and did not answer".
 *
 * @param {string} executable The path to launch.
 * @returns {Error|null} The asynchronous spawn error, if one arrives before the command returns.
 */
function launch(executable) {
  let error = null
  try {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', (failure) => {
      error = failure
    })
    child.unref()
  } catch (failure) {
    error = failure
  }
  return error
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{waitSeconds: number, dryRun: boolean}} What to do.
 * @throws {UsageError} On an unknown flag or a wait outside 1..300 seconds.
 */
function parseArgs(argv) {
  const options = { waitSeconds: DEFAULT_WAIT_SECONDS, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE.trimEnd())
      process.exit(0)
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--wait') {
      const value = Number(argv[index + 1])
      if (!Number.isInteger(value) || value < 1 || value > MAX_WAIT_SECONDS) {
        throw new UsageError(`--wait takes whole seconds from 1 to ${MAX_WAIT_SECONDS}, got '${argv[index + 1]}'`)
      }
      options.waitSeconds = value
      index += 1
    } else {
      throw new UsageError(`unknown argument '${arg}'`)
    }
  }
  return options
}

/**
 * Report the state that needs the owner, and return exit 1.
 *
 * @param {string} address Where the library was asked.
 * @param {{startedByUs: boolean, executable: string}} how What this command did about it.
 * @param {number} waitedMs How long it already waited.
 * @returns {number} Always 1.
 */
function reportNotAnswering(address, how, waitedMs) {
  column('state', 'not answering')
  column('address', address)
  // Re-read the process list rather than trusting the launch: a launch that produced no process is
  // exactly the fact the owner needs, and it is the one direction a guess must not take.
  column('process', processRunning() ? 'running' : 'not running')
  if (how.startedByUs) column('opened', `${how.executable} (detached by this command)`)
  column('waited', `${(waitedMs / 1000).toFixed(1)} s`)
  console.log(
    'fix     : if Zotero has been open for a while, its local API is off - Settings, Advanced,\n' +
      '          "Allow other applications on this computer to communicate with Zotero"\n' +
      '          (the preference is extensions.zotero.httpServer.localAPI.enabled)',
  )
  console.log('        : if it was started moments ago, run this command again')
  console.log('        : the library is unavailable until then; it is not read any other way')
  return 1
}

/**
 * What this command does next, as a pure decision over what it observed.
 *
 * The order IS the policy: an answer ends the question; a seam or a switch that forbids launching turns
 * "nothing answered" into a report rather than an attempt; a missing executable is reported with the
 * places it looked; a dry run stops at the plan. Keeping the policy here rather than in the command's
 * control flow is what lets the launch branch be tested on a machine where launching must never happen.
 *
 * @param {{answering: boolean, override: string, launchOff: boolean, executable: object|null,
 *   dryRun: boolean}} observation What the probe and the lookups found.
 * @returns {'answering'|'refuse-seam'|'refuse-off'|'cannot-start'|'plan'|'launch'} The action.
 */
export function nextAction({ answering, override, launchOff, executable, dryRun }) {
  if (answering) return 'answering'
  if (String(override ?? '').trim() !== '') return 'refuse-seam'
  if (launchOff) return 'refuse-off'
  if (!executable) return 'cannot-start'
  if (dryRun) return 'plan'
  return 'launch'
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const origin = localOrigin()
  const address = `${origin.host}:${origin.port}`
  const override = String(process.env.ZOTERO_LOCAL_API ?? '').trim()
  const launchOff = launchDisabled()

  const first = await probe()
  let found = null
  let candidates = []
  if (!first.answering && override === '' && !launchOff) ({ found, candidates } = findExecutable())

  const action = nextAction({ answering: first.answering, override, launchOff, executable: found, dryRun: options.dryRun })
  switch (action) {
    case 'answering': {
      column('state', 'already answering')
      column('address', address)
      column('library', `Zotero ${first.version} · server ${first.serverId}`)
      return 0
    }
    case 'refuse-seam': {
      column('state', 'not launched')
      column('address', address)
      column('reason', `ZOTERO_LOCAL_API names this address (${first.reason}), so this run is pointed at a`)
      console.log('        stub library or another instance; waking the reference manager is exactly what')
      console.log('        that seam exists to prevent')
      return 1
    }
    case 'refuse-off': {
      column('state', 'not launched')
      column('address', address)
      column('reason', 'ZOTERO_EXE=off asks this command to probe and never launch')
      return 1
    }
    case 'cannot-start': {
      column('state', 'cannot start')
      column('reason', `no Zotero executable was found (${first.reason} on ${address})`)
      column('checked', candidates.map((candidate) => `${candidate.path} (${candidate.from})`).join('\n          '))
      console.log("fix     : set ZOTERO_EXE to the application's executable")
      return 1
    }
    case 'plan': {
      column('state', 'would start')
      column('opened', `${found.path} (found by ${found.from})`)
      column('address', address)
      console.log(`command : ${found.path}   # detached, no arguments`)
      return 0
    }
    default:
      break
  }

  const alreadyRunning = processRunning()
  let startedByUs = false
  if (!alreadyRunning) {
    const failure = launch(found.path)
    if (failure) {
      column('state', 'cannot start')
      column('reason', String(failure.message ?? failure))
      column('opened', `${found.path} (found by ${found.from})`)
      return 1
    }
    startedByUs = true
  }

  const ceilingMs = alreadyRunning ? GRACE_WHEN_RUNNING_MS : options.waitSeconds * 1000
  const waited = await waitForAnswer(ceilingMs)
  if (!waited.answering) return reportNotAnswering(address, { startedByUs, executable: found.path }, waited.waitedMs)

  column('state', startedByUs ? 'started' : 'already running')
  if (startedByUs) column('opened', `${found.path} (found by ${found.from})`)
  column('address', address)
  column('waited', `${(waited.waitedMs / 1000).toFixed(1)} s`)
  column('library', `Zotero ${waited.answer.version} · server ${waited.answer.serverId}`)
  return 0
}

// NOT `await main()`. This module is a command, and the self-test imports its pure functions; a pending
// top-level await here would leave an importable module mid-evaluation.
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.exitCode = reportFailure(error, { usage: USAGE })
    })
}
