// Self-test for the remark rewriter, runnable without a library.
//
// Usage: node tools/tests/zotero-remark-selftest.mjs
//
// The property this tool holds is deliberately narrow, and the tests pin exactly that narrowness:
//   * it assumes NO shape for the line - no phrase parsing, no "where does the evaluation start" - so the
//     only things it can refuse are structural;
//   * an existing line may be replaced only when the caller quotes its exact current value, which is what
//     stops a line read in an earlier round from overwriting the owner's current words;
//   * every other line of `extra` is carried over as the string it was, including its line terminator;
//   * a changed verdict is PRINTED rather than refused, because the verdict is the owner's and this tool
//     promised not to decide content.
//
// Section [3] spawns the command line against a STUB library, because the exit code is what a caller
// acts on and the three answers (0 applied, 1 refused, 3 maybe-applied) are one wiring mistake apart.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  firstDifference,
  planLine,
  splitLines,
  splitRemarkValue,
  verdictNotice,
} from '../zotero-remark.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  -> ${detail}` : ''}`)
  if (!condition) failures += 1
}
const throws = (label, run, expect) => {
  try {
    run()
    check(false, label, 'nothing was thrown')
  } catch (error) {
    check(expect ? error.message.includes(expect) : true, label, expect ? error.message.slice(0, 80) : '')
  }
}

console.log('remark rewriter self-test')

// --- [1] reading a line ---------------------------------------------------------------------------

console.log('\n[1] the line, split for display only')

const full = splitRemarkValue('（一般）甲；乙；丙')
check(full.prefix === '（一般）', 'a full-width verdict is the prefix', full.prefix)
check(full.body === '甲；乙；丙', 'and everything after it is the body', full.body)
check(splitRemarkValue('(一般)甲').prefix === '(一般)', 'a half-width verdict is recognised too')
check(splitRemarkValue('甲；乙').prefix === '', 'no verdict is not an error: the prefix is simply empty')
check(splitRemarkValue('').body === '', 'an empty value has an empty body')

const crlf = splitLines('remark: a\r\nrate: 3\r\n')
check(crlf.eol === '\r\n' && crlf.lines[0] === 'remark: a', 'a CRLF field keeps its terminator', JSON.stringify(crlf.eol))
check(splitLines('a\nb').eol === '\n', 'an LF field keeps its own')
check(firstDifference('abcd', 'abXd') === 3, 'the first difference is a one-based position')
check(firstDifference('ab', 'abcd') === 3, 'a prefix of a longer string differs just past it')

console.log('\n[1b] the verdict notice is printed, never enforced')
check(verdictNotice('（一般）甲', '（不错）甲') === 'NOTE: the verdict changed, （一般） -> （不错）. The verdict is the owner\'s, not the agent\'s check to change.', 'a moved verdict is called out')
check(verdictNotice('（一般）甲', '（一般）乙') === '', 'the same verdict says nothing')
check(verdictNotice('甲', '（一般）甲').includes('none -> （一般）'), 'a verdict appearing is called out too')

// --- [2] planning the rewrite ---------------------------------------------------------------------

console.log('\n[2] one line replaced, nothing else touched')

const extraWithRate = 'remark: （一般）旧甲\nrate: 3\nISSN: 1944-9933'
const replaced = planLine({ extra: extraWithRate, nextValue: '（一般）新甲', expectCurrent: '（一般）旧甲' })
check(replaced.extra === 'remark: （一般）新甲\nrate: 3\nISSN: 1944-9933', 'the other lines are byte-identical', replaced.extra)
check(replaced.created === false && replaced.index === 0 && replaced.previous === '（一般）旧甲', 'and the replaced value is reported')

const crlfExtra = 'remark: （一般）旧甲\r\nrate: 3'
check(
  planLine({ extra: crlfExtra, nextValue: '（一般）新甲', expectCurrent: '（一般）旧甲' }).extra === 'remark: （一般）新甲\r\nrate: 3',
  'CRLF is preserved line for line',
)

const between = 'titleTranslation: 某标题\nremark: （一般）旧甲\nrate: 3'
check(
  planLine({ extra: between, nextValue: '（一般）新甲', expectCurrent: '（一般）旧甲' }).extra ===
    'titleTranslation: 某标题\nremark: （一般）新甲\nrate: 3',
  'a remark line that is not first is replaced where it stands',
)

check(
  planLine({ extra: 'Remark：旧甲', nextValue: '新甲', expectCurrent: '旧甲' }).extra === 'Remark：新甲',
  'the label keeps its own capitalisation and its full-width colon',
)
check(
  planLine({ extra: 'remark:无空格', nextValue: '新', expectCurrent: '无空格' }).extra === 'remark:新',
  'a line typed with no space after the colon keeps having none',
)

const created = planLine({ extra: 'rate: 3', nextValue: '甲；乙', create: true })
check(created.created && created.previous === '', 'a new line reports that nothing was replaced')
check(created.extra === 'remark: 甲；乙\nrate: 3', 'and is placed first, as the owner keeps it', created.extra)
check(planLine({ extra: '', nextValue: '甲', create: true }).extra === 'remark: 甲', 'an empty field becomes one line')

console.log('\n[2b] what it refuses, and why the refusal is structural')
throws(
  'replacing without quoting the current value is refused',
  () => planLine({ extra: 'remark: 甲', nextValue: '乙' }),
  '--expect-current',
)
throws(
  'a quoted value that is not what the record says is refused, with the first difference',
  () => planLine({ extra: 'remark: 甲；乙', nextValue: '丙', expectCurrent: '甲；丙' }),
  'first differ at character',
)
throws(
  'quoting a value for a record with no line is refused',
  () => planLine({ extra: 'rate: 3', nextValue: '甲', expectCurrent: '甲' }),
  'nothing to be checked against',
)
throws('no line and no --create is refused', () => planLine({ extra: 'rate: 3', nextValue: '甲' }), '--create')
throws(
  'two remark lines are refused',
  () => planLine({ extra: 'remark: 甲\nremark: 乙', nextValue: '丙', expectCurrent: '甲' }),
  'which one is the digest',
)
throws(
  'a value that would split the digest in two is a usage error',
  () => planLine({ extra: 'remark: 甲', nextValue: '乙\n丙', expectCurrent: '甲' }),
  'one line',
)

// --- [3] the command line against a stub library, not the owner's --------------------------------

console.log('\n[3] the command line against a stub library')

const scratch = mkdtempSync(join(tmpdir(), 'remark-cli-'))
const grantPath = join(scratch, 'grant.json')
const tool = fileURLToPath(new URL('../zotero-remark.mjs', import.meta.url))

const baseRecord = () => ({
  key: 'RMK00001',
  itemType: 'journalArticle',
  title: 'A paper',
  extra: 'remark: （一般）旧甲；旧乙\nrate: 3',
  tags: [{ tag: '/done' }],
  version: 12,
  collections: [],
})

const stub = {
  record: baseRecord(),
  requests: [],
  authorize: () => ({ status: 200, body: { key: 'stub-key', remember: false } }),
  patchItem: null,
}

const resetLibrary = () => {
  stub.record = baseRecord()
  stub.requests.length = 0
  stub.authorize = () => ({ status: 200, body: { key: 'stub-key', remember: false } })
  stub.patchItem = null
}

/** The library's own rule in miniature: honour the version precondition, then carry the change out. */
const patchRow = (record, patch, expectedVersion) => {
  if (String(expectedVersion) !== String(record.version)) return { status: 412 }
  Object.assign(record, patch)
  record.version += 1
  return { status: 204 }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  stub.requests.push(`${req.method} ${path}`)
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  const noContent = () => {
    res.writeHead(204)
    res.end()
  }
  const readBody = (done) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => done(raw))
  }

  if (path === '/api/') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'zotero-server-id': 'stub-server',
      'x-zotero-version': 'stub',
    })
    res.end('{}')
    return
  }
  if (path === '/api/local/authorize' && req.method === 'POST') {
    const answer = stub.authorize()
    if (answer.status !== 200) send(answer.status, { error: 'the stub declined the dialog' })
    else send(200, answer.body)
    return
  }
  const itemPath = /^\/api\/users\/0\/items\/([A-Z0-9]+)$/.exec(path)
  if (itemPath) {
    if (itemPath[1] !== stub.record.key) {
      send(404, { error: 'not found' })
      return
    }
    if (req.method === 'PATCH') {
      readBody((raw) => {
        const patch = JSON.parse(raw)
        const expected = req.headers['if-unmodified-since-version']
        const answer = stub.patchItem
          ? stub.patchItem(stub.record, patch, expected)
          : patchRow(stub.record, patch, expected)
        if (answer.status === 204) noContent()
        else send(answer.status, { error: 'the stub refused the write' })
      })
      return
    }
    send(200, { data: { ...stub.record } })
    return
  }
  send(404, { error: 'not found' })
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `127.0.0.1:${server.address().port}`
const runAsync = (args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [tool, ...args], {
      env: { ...process.env, ZOTERO_LOCAL_API: origin, ZOTERO_LOCAL_KEY_STORE: grantPath },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
const writes = () => stub.requests.filter((line) => line.startsWith('PATCH '))
const first = (text) => text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''

resetLibrary()
const readOnly = await runAsync(['--item', 'RMK00001'])
check(readOnly.status === 0, 'a read exits 0', `status ${readOnly.status}`)
check(readOnly.stdout.includes('prefix     : （一般）'), 'and shows the verdict it will not decide')
check(readOnly.stdout.includes('remark     : （一般）旧甲；旧乙'), 'and the exact value the caller must quote')
check(readOnly.stdout.includes('rate       : 3'), 'and the rate it never writes')
check(writes().length === 0, 'and sends no write', `${writes().length} write(s)`)

resetLibrary()
const planned = await runAsync(['--item', 'RMK00001', '--new-line', '（一般）新甲', '--expect-current', '（一般）旧甲；旧乙'])
check(planned.status === 0, 'a dry run exits 0', `status ${planned.status}`)
check(planned.stdout.includes('DRY RUN'), 'and says nothing was written')
check(planned.stdout.includes('     ->    : （一般）新甲'), 'and prints the new line beside the old one')
check(writes().length === 0, 'and no PATCH was sent', `${writes().length} write(s)`)

resetLibrary()
const written = await runAsync(['--item', 'RMK00001', '--new-line', '（一般）新甲', '--expect-current', '（一般）旧甲；旧乙', '--write'])
check(written.status === 0, 'a write the library accepts exits 0', `status ${written.status}`)
check(stub.record.extra === 'remark: （一般）新甲\nrate: 3', 'the line is rewritten and the rate line untouched', JSON.stringify(stub.record.extra))
check(stub.record.version === 13, 'and the record moved one version', `version ${stub.record.version}`)

resetLibrary()
const shaped = await runAsync(['--item', 'RMK00001', '--new-line', '（一般）框架可以。甲；乙', '--expect-current', '（一般）旧甲；旧乙'])
check(shaped.status === 0, 'a line of any shape is expressible: the tool parses nothing', `status ${shaped.status}`)
check(shaped.stdout.includes('甲；乙'), 'and the dry run shows exactly what would be written')

resetLibrary()
const verdictMoved = await runAsync(['--item', 'RMK00001', '--new-line', '（不错）旧甲；旧乙', '--expect-current', '（一般）旧甲；旧乙'])
check(verdictMoved.status === 0, 'a changed verdict is not refused', `status ${verdictMoved.status}`)
check(verdictMoved.stdout.includes('NOTE: the verdict changed, （一般） -> （不错）'), 'but it is printed as a note', first(verdictMoved.stdout))
check(writes().length === 0, 'and the dry run still writes nothing', `${writes().length} write(s)`)

resetLibrary()
const stale = await runAsync(['--item', 'RMK00001', '--new-line', '新甲', '--expect-current', '（一般）别的话', '--write'])
check(stale.status === 1, 'a quoted value that no longer holds is exit 1: nothing written', `status ${stale.status}`)
check(stale.stderr.includes('first differ at character'), 'and the refusal names where the two part', first(stale.stderr))
check(writes().length === 0, 'and no PATCH reached the library', `${writes().length} write(s)`)

resetLibrary()
const unquoted = await runAsync(['--item', 'RMK00001', '--new-line', '新甲', '--write'])
check(unquoted.status === 1, 'replacing without --expect-current is exit 1', `status ${unquoted.status}`)
check(unquoted.stderr.includes('--expect-current'), 'and the refusal names what is missing')
check(writes().length === 0, 'and nothing was sent', `${writes().length} write(s)`)

resetLibrary()
stub.record.extra = 'rate: 3'
const noLine = await runAsync(['--item', 'RMK00001', '--new-line', '甲', '--write'])
check(noLine.status === 1, 'a record with no remark line is exit 1 without --create', `status ${noLine.status}`)
check(noLine.stderr.includes('--create'), 'and the refusal names the way forward')

resetLibrary()
stub.record.extra = 'rate: 3'
const createdLine = await runAsync(['--item', 'RMK00001', '--new-line', '甲；乙', '--create', '--write'])
check(createdLine.status === 0, 'an added line exits 0', `status ${createdLine.status}`)
check(stub.record.extra === 'remark: 甲；乙\nrate: 3', 'and it is placed first, above the existing lines', JSON.stringify(stub.record.extra))

resetLibrary()
const split = await runAsync(['--item', 'RMK00001', '--new-line', '甲\n乙', '--expect-current', '（一般）旧甲；旧乙'])
check(split.status === 2, 'a value carrying a line break is a usage error: exit 2', `status ${split.status}`)
check(split.stderr.includes('one line'), 'and the message says why')

// 5xx that landed: the re-read shows the line, so the answer cannot be "nothing was written".
resetLibrary()
stub.patchItem = (record, patch) => {
  Object.assign(record, patch)
  record.version += 1
  return { status: 500 }
}
const landed = await runAsync(['--item', 'RMK00001', '--new-line', '新甲', '--expect-current', '（一般）旧甲；旧乙', '--write'])
check(landed.status === 3, 'a 500 that landed is exit 3, not 1', `status ${landed.status}`)
check(landed.stderr.includes('the write landed'), 'and the re-read is what settles it')
check(landed.stderr.includes('WRITTEN BUT UNCONFIRMED'), 'in the wording the skills tell an agent to look for')

resetLibrary()
stub.patchItem = () => ({ status: 500 })
const lost = await runAsync(['--item', 'RMK00001', '--new-line', '新甲', '--expect-current', '（一般）旧甲；旧乙', '--write'])
check(lost.status === 3, 'a 500 that did not land is still exit 3', `status ${lost.status}`)
check(lost.stderr.includes('does not show the line as sent'), 'and it says the re-read does not show it')

resetLibrary()
stub.patchItem = (record) => {
  record.version += 1
  return { status: 412 }
}
const raced = await runAsync(['--item', 'RMK00001', '--new-line', '新甲', '--expect-current', '（一般）旧甲；旧乙', '--write'])
check(raced.status === 1, 'a write that lost a race is exit 1', `status ${raced.status}`)
check(raced.stderr.includes('CONFLICT'), 'and it is called a conflict', first(raced.stderr))
check(raced.stderr.includes('Nothing was written'), 'and it says nothing was written')

resetLibrary()
stub.patchItem = (record) => {
  record.version += 1
  return { status: 204 }
}
const unchanged = await runAsync(['--item', 'RMK00001', '--new-line', '新甲', '--expect-current', '（一般）旧甲；旧乙', '--write'])
check(unchanged.status === 3, 'an accepted write that did not take is exit 3', `status ${unchanged.status}`)
check(unchanged.stderr.includes('does not read back as sent'), 'and it says the record differs from what was sent')

resetLibrary()
stub.patchItem = () => ({ status: 400 })
const refused = await runAsync(['--item', 'RMK00001', '--new-line', '新甲', '--expect-current', '（一般）旧甲；旧乙', '--write'])
check(refused.status === 1, 'a 4xx refusal is exit 1: nothing was written', `status ${refused.status}`)
check(refused.stderr.includes('refused the write'), 'and it says so in the library\'s own terms', first(refused.stderr))

resetLibrary()
stub.authorize = () => ({ status: 403 })
const declined = await runAsync(['--item', 'RMK00001', '--new-line', '新甲', '--expect-current', '（一般）旧甲；旧乙', '--write'])
check(declined.status === 1, 'a declined dialog is exit 1, not 3', `status ${declined.status}`)
check(writes().length === 0, 'and no PATCH reached the library', `${writes().length} write(s)`)

resetLibrary()
const writeWithoutLine = await runAsync(['--item', 'RMK00001', '--write'])
check(writeWithoutLine.status === 2, '--write without --new-line is exit 2, never a no-op write', `status ${writeWithoutLine.status}`)

server.close()

console.log(
  failures === 0
    ? '\nPASS - the tool assumes no shape, refuses only structure, and answers 0/1/3 as the header documents'
    : `\nFAIL (${failures})`,
)
process.exit(failures === 0 ? 0 : 1)
