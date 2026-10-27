// Self-test for tools/zotero-ensure.mjs. Runs with no reference manager running and none installed.
//
// Usage: node tools/tests/zotero-ensure-selftest.mjs
//
// NOTHING HERE MAY START THE REFERENCE MANAGER, and two structural facts keep that true: a launch only
// happens when nothing answers AND `ZOTERO_LOCAL_API` is unset AND `ZOTERO_EXE` is not `off`, and every
// command line this file runs sets `ZOTERO_LOCAL_API`, so the seam refuses before any process could be
// started. That is also why the launch branch is tested here as a DECISION (`nextAction`) rather than as
// a run: the one thing this file cannot pin is a real cold start, and it says so instead of faking it.
//
// What is pinned:
//   * WHERE THE APPLICATION COULD BE, in the order it is looked for. Measured on the owner's machine:
//     the uninstall registry key records the directory, and `zotero` is NOT on `PATH` - so a lookup by
//     command name alone would find nothing on the one machine this preset is used on.
//   * THAT AN ADDRESS NAMED BY THE SEAM IS NEVER LAUNCHED FOR. A test that believes it is talking to a
//     stub must never wake the real application; the reverse control for this section is deleting the
//     seam case in `nextAction`.
//   * THAT THE ANSWER IS ONE OF TWO, never a third: an answer, or a report the owner can act on.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import {
  executableCandidates,
  findExecutable,
  launchDisabled,
  nextAction,
  parseProcessList,
} from '../zotero-ensure.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures += 1
}

const tool = fileURLToPath(new URL('../zotero-ensure.mjs', import.meta.url))

console.log('zotero-ensure self-test')

console.log('\n[1] where the application could be, most specific first')

const windowsEnv = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local',
  PATH: 'C:\\Windows\\system32;C:\\tools',
}
const plain = executableCandidates({ platform: 'win32', env: windowsEnv, registry: () => '' })
check(
  plain[0].path === 'C:\\Program Files\\Zotero\\zotero.exe',
  'the standard install directory is a candidate',
  plain[0].path,
)
check(plain.every((candidate) => candidate.path.toLowerCase().endsWith('zotero.exe')), 'every Windows candidate is an executable')
check(
  plain.some((candidate) => candidate.from === 'PATH'),
  'PATH is searched too, even though it is empty on the owner\'s machine',
)
check(
  plain.filter((candidate) => candidate.path === plain[0].path).length === 1,
  'and a directory named twice does not produce the same candidate twice',
)

const withRegistry = executableCandidates({
  platform: 'win32',
  env: windowsEnv,
  registry: () => 'D:\\Apps\\Zotero',
})
check(
  withRegistry[0].path === 'D:\\Apps\\Zotero\\zotero.exe' && withRegistry[0].from === 'the uninstall registry key',
  'the recorded install directory wins over the standard one - this is how the owner\'s machine resolves',
  withRegistry[0].path,
)

const withOverride = executableCandidates({
  platform: 'win32',
  env: { ...windowsEnv, ZOTERO_EXE: 'E:\\portable\\zotero.exe' },
  registry: () => 'D:\\Apps\\Zotero',
})
check(withOverride[0].path === 'E:\\portable\\zotero.exe', 'ZOTERO_EXE wins over every other source', withOverride[0].path)

const switchedOff = executableCandidates({ platform: 'win32', env: { ...windowsEnv, ZOTERO_EXE: 'off' }, registry: () => '' })
check(
  switchedOff.every((candidate) => candidate.from !== 'ZOTERO_EXE'),
  'ZOTERO_EXE=off is a switch, not a path',
)

const mac = executableCandidates({ platform: 'darwin', env: { PATH: '/usr/local/bin:/usr/bin' }, registry: () => '' })
check(
  mac.some((candidate) => candidate.path === '/Applications/Zotero.app/Contents/MacOS/zotero'),
  'macOS gets the bundle path, since the application is not a command there either',
)
check(
  mac.some((candidate) => candidate.path === '/usr/local/bin/zotero'),
  'and PATH is still searched',
  mac.map((candidate) => candidate.path).join(' · '),
)

console.log('\n[2] the first candidate that exists is the one to start')

const picked = findExecutable({
  platform: 'win32',
  env: windowsEnv,
  registry: () => 'D:\\Apps\\Zotero',
  exists: (path) => path === 'C:\\Program Files\\Zotero\\zotero.exe',
})
check(picked.found.path === 'C:\\Program Files\\Zotero\\zotero.exe', 'an existing standard path is found', picked.found.path)
check(picked.found.from === 'the standard install directory', 'and the report says where it came from')

const missing = findExecutable({ platform: 'win32', env: windowsEnv, registry: () => '', exists: () => false })
check(missing.found === null, 'nothing on disk is reported as no executable, not as an error')
check(missing.candidates.length > 0, 'and the places it looked are carried out, so the report can name them')

console.log('\n[3] the switch that forbids launching is not a path')

check(launchDisabled({ ZOTERO_EXE: 'off' }) === true, 'off means probe only')
check(launchDisabled({ ZOTERO_EXE: ' OFF ' }) === true, 'and the case and the spaces do not matter')
check(launchDisabled({ ZOTERO_EXE: 'C:\\Program Files\\Zotero\\zotero.exe' }) === false, 'a path is not the switch')
check(launchDisabled({}) === false, 'and neither is an unset variable')

console.log('\n[4] a process listing says whether the application is already there')

check(
  parseProcessList('zotero.exe                   12304 Console                    1     12,345 K'),
  'a listed image name means the process is there',
)
check(!parseProcessList('信息: 没有运行的任务匹配指定标准。'), 'a localized "no tasks match" carries no image name, so it reads as absent')
check(!parseProcessList(''), 'and an empty listing is absent')
check(!parseProcessList('node.exe                     999  Console   1    1,000 K'), 'another program is not it')

console.log('\n[5] the decision, which is where the launch policy lives')

const decision = (overrides) =>
  nextAction({ answering: false, override: '', launchOff: false, executable: { path: 'zotero.exe' }, dryRun: false, ...overrides })
check(decision({ answering: true }) === 'answering', 'an answer ends the question')
check(decision({ answering: true, override: '127.0.0.1:9' }) === 'answering', 'and it wins even when a seam is set')
check(decision({ override: '127.0.0.1:23999' }) === 'refuse-seam', 'a seam address is never launched for')
check(decision({ launchOff: true }) === 'refuse-off', 'ZOTERO_EXE=off never launches')
check(decision({ executable: null }) === 'cannot-start', 'no executable is reported, not attempted')
check(decision({ dryRun: true }) === 'plan', 'a dry run stops at the plan')
check(decision({}) === 'launch', 'and only the unremarkable case launches')

console.log('\n[6] the command line against a STUB library that answers')

const stub = createServer((request, response) => {
  if (request.url === '/api/') {
    response.writeHead(200, { 'Zotero-Server-ID': 'STUB0001', 'X-Zotero-Version': '10.0.6' })
    response.end('{}')
    return
  }
  response.writeHead(404)
  response.end('{}')
})
await new Promise((done) => stub.listen(0, '127.0.0.1', done))
const stubPort = stub.address().port

const runAsync = (args, env) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [tool, ...args], { env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
const first = (text) => text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''

const answered = await runAsync([], { ZOTERO_LOCAL_API: `127.0.0.1:${stubPort}` })
check(answered.status === 0, 'a library that answers is exit 0', `status ${answered.status}`)
check(answered.stdout.includes('already answering'), 'and says so in one word the discipline can quote', first(answered.stdout))
check(answered.stdout.includes('STUB0001'), 'and names the library it reached, so a wrong library is visible')
check(!answered.stdout.includes('started'), 'and does not claim to have started anything')
stub.close()

console.log('\n[7] the command line against an address this run was pointed at')

const deadPort = await new Promise((done) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => done(port))
  })
})
const refused = await runAsync([], {
  ZOTERO_LOCAL_API: `127.0.0.1:${deadPort}`,
  // A real, existing executable: if the seam were missing, this run would launch it.
  ZOTERO_EXE: process.execPath,
})
check(refused.status === 1, 'nothing answering is exit 1, not a third answer', `status ${refused.status}`)
check(refused.stdout.includes('not launched'), 'and it says it did not launch', first(refused.stdout))
check(refused.stdout.includes('ZOTERO_LOCAL_API'), 'naming the seam that forbade it')
check(!refused.stdout.includes('would start'), 'and it does not offer to start the application behind the seam')

console.log('\n[8] usage')

const badWait = await runAsync(['--wait', '0'], { ZOTERO_LOCAL_API: `127.0.0.1:${deadPort}` })
check(badWait.status === 2, 'a wait below one second is a usage error', `status ${badWait.status}`)
check(badWait.stderr.includes('1 to 300'), 'and says what the bound is', first(badWait.stderr))
const badFlag = await runAsync(['--frobnicate'], { ZOTERO_LOCAL_API: `127.0.0.1:${deadPort}` })
check(badFlag.status === 2, 'an unknown flag is a usage error too', `status ${badFlag.status}`)

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
