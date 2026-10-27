#!/usr/bin/env node
// Self-test for the shared failure voice, offline: every function here is pure or takes its sink as
// an argument, so none of it needs a library, a network, or a process to leave.
//
// What this file pins is the part that can be wrong silently: which fields a block carries, that a
// plain error keeps the one line it always had, that the cause line appears only when it adds
// something, and that the two exit codes stay apart. The reverse controls at the end are deliberate:
// they assert that a block WITHOUT a field does not grow one, so an assertion that reads a `fix` line
// cannot pass on a block that has none.
import { readFileSync } from 'node:fs'
import { Refusal, UsageError, refusalLines, reportFailure } from '../refusal.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures += 1
}
const same = (actual, expected, label) => check(actual === expected, label, actual === expected ? '' : `got ${JSON.stringify(actual)}`)

console.log('refusal self-test')

console.log('\n[1] a plain failure keeps the one line it always had')
const plain = refusalLines(new Error('boom'))
same(plain.length, 1, 'nothing is added to an error that knows no next action')
same(plain[0], 'ERROR   : boom', 'and the label sits in the same column as the rest of the suite')
same(refusalLines('a thrown string')[0], 'ERROR   : a thrown string', 'a thrown non-Error still renders')
same(refusalLines(new Error('boom'))[0].indexOf(':'), 8, 'the colon lands on the eighth column, like `library : `')

console.log('\n[2] a refusal carries only the fields it has')
const noRecord = new Refusal('the library has no record under the key NOTAKEY1 (404)', {
  fix: 'a key is copied from a search result; search the record by title and read its key',
})
const lines = refusalLines(noRecord)
same(lines.length, 2, 'what happened, and the one thing to do')
same(lines[0], 'ERROR   : the library has no record under the key NOTAKEY1 (404)', 'the message is the first field')
same(lines[1]?.startsWith('fix     : '), true, 'and the remedy is the second')
check(!lines.some((line) => line.startsWith('try')), 'no `try` line when no command is known - negative control')
check(!lines.some((line) => line.startsWith('checked')), 'and no `checked` line either')

const withCommand = new Refusal('openalex has no record for 10.1/x', {
  fix: 'ask the other channel',
  command: 'node "C:\\preset\\tools\\metadata.mjs" --doi 10.1/x --source crossref',
})
same(refusalLines(withCommand)[2], 'try     : node "C:\\preset\\tools\\metadata.mjs" --doi 10.1/x --source crossref', 'a known command is offered under `try`, exactly as it must be typed')

const withChecked = new Refusal('cannot start Zotero', { checked: ['C:\\Program Files\\Zotero\\zotero.exe (registry)', 'PATH'] })
same(refusalLines(withChecked)[1], 'checked : C:\\Program Files\\Zotero\\zotero.exe (registry)', 'places looked at are listed')
same(refusalLines(withChecked)[2], '          PATH', 'each on its own line, indented under the value column')

console.log('\n[3] the cause appears only when it adds something')
const socket = Object.assign(new Error('the create was sent'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
same(refusalLines(socket)[0], 'ERROR   : the create was sent (cause: ECONNRESET)', 'a socket code is worth appending')
const named = Object.assign(new Error('the reference library is not answering'), {
  code: 'ECONNREFUSED',
  cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
})
check(!refusalLines(named)[0].includes('cause:'), 'a message that already names the code does not repeat it - negative control')
const noCode = Object.assign(new Error('something'), { cause: new Error('connect ECONNREFUSED') })
same(refusalLines(noCode)[0], 'ERROR   : something (cause: connect ECONNREFUSED)', 'a cause with only a message still says what it was, as the write tools already promised')
same(refusalLines(new Error('something'))[0], 'ERROR   : something', 'and no cause at all adds nothing - negative control')

console.log('\n[4] the two exits stay apart')
const printed = []
const sink = (text) => printed.push(text)
same(reportFailure(new Error('boom'), { write: sink }), 1, 'a failed request is exit 1')
same(printed[0], '\nERROR   : boom', 'written as one block, with a blank line in front of it')
same(reportFailure(new Refusal('refused', { fix: 'do this' }), { write: sink }), 1, 'a refusal is exit 1 too: it is still nothing written')
printed.length = 0
same(reportFailure(new UsageError('pass one of --outline, --extract or --render'), { usage: 'usage: node tools/zotero-pdf.mjs --item <key> --outline', write: sink }), 2, 'a malformed command line is exit 2')
check(
  printed[0].startsWith('pass one of --outline, --extract or --render\nusage: node tools/zotero-pdf.mjs --item <key> --outline'),
  'and keeps its usage block directly underneath, as one paragraph',
  printed[0],
)
check(
  printed[0].includes(`This script is at ${process.argv[1]}`),
  'plus the absolute path the reader can actually run: a relative tools/... names nothing in a study workspace',
  printed[0],
)
check(
  printed[0].includes('does not resolve in a study workspace'),
  'and says why the relative form is not enough',
)
check(!printed[0].includes('ERROR'), 'a malformed command is not reported as a failure block - negative control')
printed.length = 0
same(reportFailure(new UsageError('bad flag'), { write: sink }), 2, 'a usage error without a usage block still exits 2')
check(printed[0].startsWith('bad flag'), 'and prints its message first', printed[0])
check(printed[0].includes('This script is at'), 'with the same path line, so no usage error is a dead end')

console.log('\n[5] alignment survives multi-line values')
const multi = new Refusal('first line\nsecond line', { fix: 'do this\nthen that' })
const multiLines = refusalLines(multi)
same(multiLines[0], 'ERROR   : first line', 'the message starts on the label line')
same(multiLines[1], '          second line', 'and continues under the value column')
same(multiLines[2], 'fix     : do this', 'the next field still starts at the label column')
same(multiLines[3], '          then that', 'with its own continuation aligned')

console.log('\n[6] the module is a voice, not a channel')
const source = readFileSync(new URL('../refusal.mjs', import.meta.url), 'utf8')
check(!/^import /m.test(source), 'it imports nothing: no network, no filesystem, no child process')
check(!/process\.exit/.test(source), 'and it never leaves: the caller owns the exit code')
check(/export function refusalLines/.test(source), 'the shape is a pure function')
check(/instanceof Refusal/.test(source), 'and the extra fields are read from a type, not from a message - a 404 is not parsed')
const ensure = readFileSync(new URL('../zotero-ensure.mjs', import.meta.url), 'utf8')
check(ensure.includes('fix     : '), 'the launcher already prints this column, so the two cannot drift apart')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exitCode = failures === 0 ? 0 : 1
