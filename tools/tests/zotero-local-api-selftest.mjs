// Unit self-test for the shared local-API module, runnable without a library.
//
// Usage: node tools/tests/zotero-local-api-selftest.mjs
//
// This module is the one place every reference-library tool goes through, so its contracts are worth
// pinning here rather than from a caller:
//
//   * WHICH STATUSES MEAN "ACCEPTED". A `PATCH` answers 204 when it succeeds, and the first real write
//     this preset ever made was reported as a refusal because only 200 counted - a write tool saying
//     the library refused a change it had already applied.
//   * THAT A WRITE CANNOT HAPPEN WITHOUT AN OPENED GATE. The server id comes from `open()`, and a
//     write carrying no server id is malformed. The guard fires before any request, which is what
//     makes this part testable without a reference manager running.
//   * WHEN THE OWNER IS ASKED, and only then. "Allow" covers one write and is never written down;
//     "Always Allow" is kept per library and reused without asking; a key the library rejects is
//     discarded, so a grant the owner revoked recovers by itself. The transport is injectable for
//     exactly this reason: without it the asking could only be tested by holding a dialog open.
//   * WHERE IT TALKS TO. `ZOTERO_LOCAL_API` is the seam a read has, so the command-line path that
//     decides before it opens the write gate can be tested against a stub library. A malformed value
//     must throw rather than fall back: talking to the reference manager while a test believed it was
//     talking to a stub is the one failure this seam must not have.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import {
  APP_NAME,
  createWriteGate,
  emptyGrantStore,
  grantFilePath,
  isWriteAccepted,
  keptGrant,
  libraryUnreachable,
  localOrigin,
  localRequest,
  mayHaveLanded,
  parseGrantStore,
  reportUnconfirmed,
  withGrant,
  withoutGrant,
} from '../zotero-local-api.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures += 1
}

/** The first line of a multi-line message, which is all a detail column can hold. */
const firstLine = (text) => String(text).split(/\r?\n/)[0]

/** Run one reporter and collect what it wrote to stderr, without letting it reach the terminal. */function captureStderr(run) {
  const original = console.error
  const lines = []
  console.error = (...args) => lines.push(args.map((part) => String(part)).join(' '))
  try {
    return { code: run(), text: lines.join('\n') }
  } finally {
    console.error = original
  }
}

console.log('local API module self-test')

console.log('\n[1] any 2xx is an accepted write')

check(isWriteAccepted(200), '200 with a body is accepted')
check(isWriteAccepted(204), '204 with NO body is accepted - this is what a successful PATCH answers')
check(isWriteAccepted(201), 'any other 2xx is accepted too')
check(!isWriteAccepted(199), 'below 200 is not')
check(!isWriteAccepted(300), '300 is not')
check(!isWriteAccepted(401), '401 is not: the key was rejected')
check(!isWriteAccepted(412), '412 is not: the version precondition failed')
check(!isWriteAccepted(429), '429 is not: too many dialogs')
check(!isWriteAccepted(500), '500 is not')

console.log('\n[1b] a failed write is either refused or open - never silently "nothing happened"')

check(mayHaveLanded(0), 'a request that got no answer may have landed')
check(mayHaveLanded(500), '500 may have landed: HTTP names a response, not an effect')
check(mayHaveLanded(503), '503 as well')
check(!mayHaveLanded(400), '400 is a refusal')
check(!mayHaveLanded(401), '401 is a refusal')
check(!mayHaveLanded(404), '404 is a refusal')
check(!mayHaveLanded(412), '412 is a refusal')

const withKey = captureStderr(() => reportUnconfirmed({ key: 'ABCDEFGH', what: 'the title change' }))
check(withKey.code === 3, 'a write that may exist exits 3, never 1', String(withKey.code))
check(withKey.text.includes('WRITTEN BUT UNCONFIRMED'), 'and says so in the words the skills tell an agent to look for')
check(withKey.text.includes('ABCDEFGH'), 'naming the key to read instead of resending')
const noKey = captureStderr(() => reportUnconfirmed({ what: 'the create' }))
check(noKey.code === 3 && noKey.text.includes('SENT BUT UNCONFIRMED'), 'a write with no key found says "sent", not "written"')

console.log('\n[2] a write cannot happen without an opened gate')

const gate = createWriteGate({ appName: 'self-test' })
let refused = ''
try {
  await gate.write('PATCH', '/api/users/0/items/AAAAAAA', { title: 'x' })
} catch (error) {
  refused = error.message
}
check(/not opened/.test(refused), 'writing before open() is refused, and says why', refused)
check(refused !== '', 'and it refuses rather than attempting a request without the server id')

const unauthorized = createWriteGate({ appName: 'self-test' })
let second = ''
try {
  await unauthorized.write('DELETE', '/api/users/0/items/AAAAAAA')
} catch (error) {
  second = error.message
}
check(/not opened/.test(second), 'the guard covers every method, not only PATCH')

console.log('\n[3] where a lasting grant is kept')

const savedStorePath = process.env.ZOTERO_LOCAL_KEY_STORE
process.env.ZOTERO_LOCAL_KEY_STORE = 'D:\\tmp\\grant.json'
check(grantFilePath() === 'D:\\tmp\\grant.json', 'an explicit store path wins over the default', grantFilePath())
delete process.env.ZOTERO_LOCAL_KEY_STORE
const fallbackPath = grantFilePath()
check(fallbackPath.includes('dsh-autoresearch'), "the default lives in this preset's own directory", fallbackPath)
check(fallbackPath.endsWith('zotero-local-api-key.json'), 'and names the grant file', fallbackPath)
if (savedStorePath !== undefined) process.env.ZOTERO_LOCAL_KEY_STORE = savedStorePath

console.log('\n[4] a grant file is read defensively, because the safe direction is to ask again')

const readable = JSON.stringify({
  version: 1,
  grants: {
    srv1: { key: 'k1', appName: 'x', createdAt: 'now' },
    srv2: { key: '' },
    srv3: { noKey: true },
  },
})
check(keptGrant(parseGrantStore(readable), 'srv1') === 'k1', 'a well-formed entry is read')
check(keptGrant(parseGrantStore(readable), 'srv2') === null, 'an entry with an empty key is dropped')
check(keptGrant(parseGrantStore(readable), 'srv3') === null, 'an entry with no key at all is dropped')
check(Object.keys(parseGrantStore(readable).grants).length === 1, 'only usable entries survive')

for (const [label, text] of [
  ['truncated JSON', '{"version":1,"grants":{'],
  ['a JSON array', '[]'],
  ['a bare string', '"hello"'],
  ['an unknown version', '{"version":2,"grants":{"srv1":{"key":"k1"}}}'],
  ['a null body', 'null'],
]) {
  check(Object.keys(parseGrantStore(text).grants).length === 0, `${label} reads as "no grant kept" rather than throwing`)
}

console.log('\n[5] a grant belongs to the library that issued it, and the helpers do not mutate')

const two = withGrant(withGrant(emptyGrantStore(), 'srv1', { key: 'k1', appName: 'a', createdAt: 't' }), 'srv2', {
  key: 'k2',
  appName: 'a',
  createdAt: 't',
})
check(keptGrant(two, 'srv1') === 'k1' && keptGrant(two, 'srv2') === 'k2', 'each library keeps its own key')
check(keptGrant(two, 'srv3') === null, 'a library with no grant has none')
check(keptGrant(withoutGrant(two, 'srv1'), 'srv1') === null, 'dropping one grant removes only that one')
check(keptGrant(withoutGrant(two, 'srv1'), 'srv2') === 'k2', 'the other library keeps its grant')

const untouched = emptyGrantStore()
withGrant(untouched, 'srv1', { key: 'k1', appName: 'a', createdAt: 't' })
withoutGrant(untouched, 'srv1')
check(Object.keys(untouched.grants).length === 0, 'both helpers return a new store instead of editing the one they were given')

/** A grant store in memory, so the grant handling is exercised without touching a file. */
function memoryStore(initial = emptyGrantStore()) {
  let held = initial
  return {
    saves: [],
    load: () => held,
    save(store) {
      held = store
      this.saves.push(store)
    },
  }
}

/**
 * A reference manager that answers from a script instead of a dialog: each entry of `keys` is one
 * dialog, and `answer` decides the status of the nth write.
 */
function fakeManager({ serverId = 'srv1', keys = [], answer = 200 } = {}) {
  const dialogs = []
  const writes = []
  return {
    dialogs,
    writes,
    transport: {
      serverInfo: async () => ({ id: serverId, version: 'test' }),
      localRequest: async (method, path, options = {}) => {
        if (path === '/api/local/authorize') {
          const next = keys.shift()
          if (next === undefined) throw new Error('the test script ran out of keys: too many dialogs')
          dialogs.push(JSON.parse(options.body).appName)
          return { status: 200, headers: {}, text: JSON.stringify({ key: next.key, remember: next.remember }) }
        }
        writes.push({ method, path, key: options.headers['Zotero-API-Key'] })
        const status = typeof answer === 'function' ? answer(writes.length - 1) : answer
        return { status, headers: {}, text: '' }
      },
    },
  }
}

console.log('\n[6] the owner is asked once per library, not once per run')

const keptStore = memoryStore()
const firstRun = fakeManager({ keys: [{ key: 'kept-1', remember: true }] })
const gate1 = createWriteGate({ appName: APP_NAME, store: keptStore, transport: firstRun.transport })
const opened1 = await gate1.open()
check(opened1.kept === false, 'a library with no grant on file says so', String(opened1.kept))
const wrote1 = await gate1.write('PATCH', '/api/users/0/items/AAAAAAAA', { title: 'x' })
check(wrote1.status === 200, 'its first write is accepted', `status=${wrote1.status}`)
check(firstRun.dialogs.length === 1, 'after asking the owner once', `${firstRun.dialogs.length} dialog(s)`)
check(keptGrant(keptStore.load(), 'srv1') === 'kept-1', 'and the lasting answer is written down')

const laterRun = fakeManager()
const gate2 = createWriteGate({ appName: APP_NAME, store: keptStore, transport: laterRun.transport })
const opened2 = await gate2.open()
check(opened2.kept === true, 'a later run finds the grant on file', String(opened2.kept))
const wrote2 = await gate2.write('PATCH', '/api/users/0/items/AAAAAAAA', { title: 'y' })
check(wrote2.status === 200, 'and its write is accepted', `status=${wrote2.status}`)
check(laterRun.dialogs.length === 0, 'without asking again - which is the whole point of keeping it', `${laterRun.dialogs.length} dialog(s)`)
check(laterRun.writes[0].key === 'kept-1', 'because the kept key is what it sent', laterRun.writes[0].key)

console.log('\n[7] "Allow" covers one write and is never written down')

const singleStore = memoryStore()
const singleRun = fakeManager({ keys: [{ key: 'one-shot-1', remember: false }, { key: 'one-shot-2', remember: false }] })
const gate3 = createWriteGate({ appName: APP_NAME, store: singleStore, transport: singleRun.transport })
await gate3.open()
await gate3.write('PATCH', '/api/users/0/items/AAAAAAAA', { title: 'x' })
check(singleStore.saves.length === 0, 'nothing was written down', `${singleStore.saves.length} save(s)`)
check(keptGrant(singleStore.load(), 'srv1') === null, 'and no grant is on file')
await gate3.write('PATCH', '/api/users/0/items/AAAAAAAA', { title: 'y' })
check(singleRun.dialogs.length === 2, 'a second write asks again, because the first key was spent by it', `${singleRun.dialogs.length} dialog(s)`)
check(singleRun.writes[1].key === 'one-shot-2', 'and the second answer is the one used', singleRun.writes[1].key)

console.log('\n[8] a grant the owner revoked is discovered, not assumed away')

const revokedStore = memoryStore(withGrant(emptyGrantStore(), 'srv1', { key: 'stale', appName: 'x', createdAt: 't' }))
const dropped = []
const revokedRun = fakeManager({ keys: [{ key: 'fresh', remember: true }], answer: (i) => (i === 0 ? 401 : 200) })
const gate4 = createWriteGate({
  appName: APP_NAME,
  store: revokedStore,
  transport: revokedRun.transport,
  onGrantDropped: ({ serverId }) => dropped.push(serverId),
})
await gate4.open()
const afterRevoke = await gate4.write('PATCH', '/api/users/0/items/AAAAAAAA', { title: 'x' })
check(afterRevoke.status === 200, 'the rejected grant is replaced and the write goes through', `status=${afterRevoke.status}`)
check(revokedRun.dialogs.length === 1, 'by asking the owner once', `${revokedRun.dialogs.length} dialog(s)`)
check(dropped.length === 1 && dropped[0] === 'srv1', 'and the loss is reported rather than hidden', dropped.join(','))
check(keptGrant(revokedStore.load(), 'srv1') === 'fresh', 'the new answer is what is on file now', String(keptGrant(revokedStore.load(), 'srv1')))

console.log('\n[9] the asking has a ceiling')

const ceilingStore = memoryStore(withGrant(emptyGrantStore(), 'srv1', { key: 'stale', appName: 'x', createdAt: 't' }))
const ceilingRun = fakeManager({ keys: [{ key: 'a', remember: true }, { key: 'b', remember: true }], answer: 401 })
const gate5 = createWriteGate({ appName: APP_NAME, store: ceilingStore, transport: ceilingRun.transport })
await gate5.open()
let ceilingError = ''
let ceilingRefused = false
try {
  await gate5.write('PATCH', '/api/users/0/items/AAAAAAAA', { title: 'x' })
} catch (error) {
  ceilingError = error.message
  ceilingRefused = error.refused === true
}
check(/401/.test(ceilingError), 'a library that rejects every key ends as an error rather than a loop', ceilingError)
check(ceilingRefused, 'and the error is marked refused, so a tool can answer exit 1 rather than "may exist"')
check(ceilingRun.dialogs.length === 2, 'after at most two dialogs', `${ceilingRun.dialogs.length} dialog(s)`)
check(keptGrant(ceilingStore.load(), 'srv1') === null, 'and the grant it could not use is not left on file')

console.log('\n[10] every write helper names itself the same way')

check(APP_NAME === 'DSH autoresearch preset', 'the shared name is the one the owner sees', APP_NAME)
for (const file of [
  'zotero-write.mjs',
  'zotero-edit.mjs',
  'zotero-collection.mjs',
  'zotero-link-attachments.mjs',
]) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  check(source.includes('appName: APP_NAME'), `${file} uses the shared name`)
  check(!/appName: '/.test(source), `${file} declares no name of its own`)
}

console.log('\n[11] where it talks to, which is the seam a read has')

const originalAddress = process.env.ZOTERO_LOCAL_API
delete process.env.ZOTERO_LOCAL_API
const defaultOrigin = localOrigin()
check(
  defaultOrigin.host === '127.0.0.1' && defaultOrigin.port === 23119,
  'with no override it talks to the reference manager',
  `${defaultOrigin.host}:${defaultOrigin.port}`,
)

process.env.ZOTERO_LOCAL_API = '127.0.0.1:23999'
const overridden = localOrigin()
check(
  overridden.host === '127.0.0.1' && overridden.port === 23999,
  'an override is honoured - this is how a stub library is reached',
  `${overridden.host}:${overridden.port}`,
)

process.env.ZOTERO_LOCAL_API = 'not-an-address'
let malformed = ''
try {
  localOrigin()
} catch (error) {
  malformed = error.message
}
check(/host:port/.test(malformed), 'a malformed address throws rather than falling back to the real library', malformed)

if (originalAddress === undefined) delete process.env.ZOTERO_LOCAL_API
else process.env.ZOTERO_LOCAL_API = originalAddress
check(process.env.ZOTERO_LOCAL_API === originalAddress, 'and the environment is left as it was found')

console.log('\n[12] a library that never answered says what to do about it')

const unreachable = libraryUnreachable(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
check(unreachable !== null && unreachable.message.includes('is not answering'), 'ECONNREFUSED becomes a sentence about the library', firstLine(unreachable.message))
check(unreachable.code === 'ECONNREFUSED', 'and the code survives, so a caller can still classify the failure', String(unreachable.code))
check(unreachable.cause instanceof Error, 'the transport error is kept as the cause rather than replaced')
check(unreachable.message.includes('zotero-ensure.mjs'), 'the way out is named, by path, because a relative tools/... resolves to nothing')
check(unreachable.message.includes('not read by path'), 'and the alternative this exists to prevent is named too')
check(libraryUnreachable(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).message.includes('not answering'), 'a name that does not resolve is the same class')
check(libraryUnreachable(Object.assign(new Error('x'), { code: 'EHOSTUNREACH' })).message.includes('not answering'), 'so is a host that cannot be reached')

const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
check(libraryUnreachable(reset) === reset, 'a reset is NOT translated: it can arrive mid-request, where "never up" would be a false statement')
const timedOut = Object.assign(new Error('nothing answered within 2000 ms'), { code: 'ETIMEDOUT' })
check(libraryUnreachable(timedOut) === timedOut, 'and a probe timeout is not translated either, for the same reason')

process.env.ZOTERO_LOCAL_API = '127.0.0.1:23998'
const behindSeam = libraryUnreachable(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
check(behindSeam.message.includes('ZOTERO_LOCAL_API'), 'behind the seam the message names the seam', firstLine(behindSeam.message))
check(!behindSeam.message.includes('zotero-ensure.mjs'), 'and does not offer to start an application this run is not talking to')
if (originalAddress === undefined) delete process.env.ZOTERO_LOCAL_API
else process.env.ZOTERO_LOCAL_API = originalAddress

// The wiring, against a socket that is closed rather than a fake error: a predicate that is never called
// is the shape of every "it should have said" defect.
const closedPort = await new Promise((done) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => done(port))
  })
})
process.env.ZOTERO_LOCAL_API = `127.0.0.1:${closedPort}`
let wired = null
try {
  await localRequest('GET', '/api/')
} catch (error) {
  wired = error
}
// The prose, not the code: a raw `connect ECONNREFUSED 127.0.0.1:<port>` also carries the code and the
// port, so an assertion on those two alone passes with the translation switched off. The wording this
// run sees is the SEAM one - a closed port here is only reachable by naming it, and naming it is what
// keeps this test off the real library - so the sentence is matched by its shape, not by one branch's
// exact words.
const sentenceAboutTheLibrary = (text) => /(is not answering|did not answer)/.test(String(text))
check(
  wired !== null && wired.code === 'ECONNREFUSED' && sentenceAboutTheLibrary(wired.message),
  'a request to a closed port really does reach the translation, prose and all',
  firstLine(wired?.message ?? ''),
)
check((wired?.message ?? '').includes(String(closedPort)), 'and names the address it tried', firstLine(wired?.message ?? ''))
if (originalAddress === undefined) delete process.env.ZOTERO_LOCAL_API
else process.env.ZOTERO_LOCAL_API = originalAddress

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
