// Self-test for the record editor, runnable without a library.
//
// Usage: node tools/tests/zotero-edit-selftest.mjs
//
// The properties worth pinning are the refusals and the no-ops:
//   * the field list is a WHITELIST, and the fields it refuses each carry a reason rather than a bare
//     "no", because the caller has to know where to go instead;
//   * the tag list sent is the WHOLE next list, not a delta, because whether a patch's `tags`
//     replaces or merges is not something this repository has measured;
//   * a change that changes nothing is reported as nothing, so no authorization dialog is spent on it.
//
// Section [3] spawns the command line against a STUB library, because the exit code is what a caller
// acts on and the three answers (0 applied, 1 refused, 3 maybe-applied) are one wiring mistake apart.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EDITABLE_FIELDS, REFUSED_FIELDS, changedFields, computeTagChange, flattenTrashGraph, invalidFields, isDeleted, parseItemKeys, parseSetFlags, resolveAction } from '../zotero-edit.mjs'

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
    check(expect ? error.message.includes(expect) : true, label, expect ? error.message.slice(0, 70) : '')
  }
}

console.log('record editor self-test')

// --- the field whitelist ------------------------------------------------------------------------

console.log('\n[1] what may be changed, and what may not')

check(EDITABLE_FIELDS.includes('title') && EDITABLE_FIELDS.includes('DOI'), 'bibliographic fields are editable')
check(!EDITABLE_FIELDS.includes('creators') && !EDITABLE_FIELDS.includes('itemType'), 'structure is not editable')
check(
  Object.keys(REFUSED_FIELDS).every((field) => !EDITABLE_FIELDS.includes(field)),
  'no field is both editable and refused',
)
check(
  Object.values(REFUSED_FIELDS).every((reason) => reason.length > 20),
  'every refusal carries a reason rather than a bare no',
)

console.log('\n[2] reading field=value')
check(parseSetFlags(['title=A new title']).title === 'A new title', 'a simple assignment')
check(parseSetFlags(['pages=1-10']).pages === '1-10', 'a value with a dash')
check(parseSetFlags(['title=A=B']).title === 'A=B', 'a value containing "=" is kept whole, split on the first only')
check(parseSetFlags(['abstractNote=']).abstractNote === '', 'an empty value is kept: clearing a field is a real change')
throws('an assignment with no "=" is refused', () => parseSetFlags(['title']), 'field=value')
throws('an unknown field is refused', () => parseSetFlags(['titel=x']), 'takes one of')
throws('a refused field is refused WITH its reason', () => parseSetFlags(['creators=x']), 'structured')
throws('changing the item type is refused with its reason', () => parseSetFlags(['itemType=book']), 'decides which fields')

console.log('\n[3] tags are computed as a whole list')

const added = computeTagChange(['transformer'], { add: ['/done'] })
check(JSON.stringify(added.next) === '["transformer","/done"]', 'a new tag is appended after the existing ones', JSON.stringify(added.next))
check(added.added.length === 1 && !added.unchanged, 'the addition is reported')
const noop = computeTagChange(['/done'], { add: ['/done'] })
check(noop.unchanged && noop.added.length === 0, 'adding a tag that is already there changes nothing')
const removed = computeTagChange(['/done', 'transformer'], { remove: ['/done'] })
check(JSON.stringify(removed.next) === '["transformer"]', 'a removal keeps the order of the rest', JSON.stringify(removed.next))
check(removed.removed.length === 1, 'the removal is reported')
check(computeTagChange(['a'], { remove: ['zzz'] }).unchanged, 'removing a tag that is not there changes nothing')
check(
  JSON.stringify(computeTagChange(['a'], { add: ['b', 'b', 'a'] }).next) === '["a","b"]',
  'a repeated addition lands once',
)
check(JSON.stringify(computeTagChange([], {}).next) === '[]', 'no change asked for is an empty list')

console.log('\n[4] a change that changes nothing is not a write')

const record = { title: 'Attention Is All You Need', DOI: '', version: 567 }
check(changedFields(record, { title: 'Attention Is All You Need' }).length === 0, 'the same title is not a change')
check(changedFields(record, { title: 'Other' }).length === 1, 'a different title is')
check(
  changedFields(record, { DOI: '10.1234/x' })[0].from === '',
  'the "from" side of an empty field is empty rather than undefined',
)
check(changedFields(record, { DOI: '' }).length === 0, 'asking to clear an already-empty field is not a change')
check(
  changedFields({ tags: [{ tag: '/unread' }] }, { tags: [{ tag: '/done' }] }).length === 1,
  'a tag swap is a change, though both lists are one tag long - the object-array case',
)
check(
  changedFields({ tags: [{ tag: '/done' }] }, { tags: [{ tag: '/done' }] }).length === 0,
  'the same tags are not a change',
)

console.log("\n[3] the command line against a stub library, not the owner's")

const scratch = mkdtempSync(join(tmpdir(), 'edit-cli-'))
const grantPath = join(scratch, 'grant.json')
const tool = fileURLToPath(new URL('../zotero-edit.mjs', import.meta.url))

const baseRecord = () => ({
  key: 'EDIT0001',
  itemType: 'journalArticle',
  title: 'A paper',
  DOI: '10.1000/example',
  tags: [{ tag: '/unread' }, { tag: '/keep' }],
  version: 12,
  collections: [],
})

// The library the tool talks to, plus the hook a scenario replaces. A null hook means "behave like
// the thing the editor was measured against".
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
/** What to show as the detail: the first line that says something, not the whole transcript. */
const first = (text) => text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''

resetLibrary()
const planned = await runAsync(['--item', 'EDIT0001', '--set', 'title=A new title'])
check(planned.status === 0, 'a dry run exits 0', `status ${planned.status}`)
check(planned.stdout.includes('DRY RUN'), 'and says nothing was written')
check(writes().length === 0, 'and no PATCH was sent', `${writes().length} write(s)`)

resetLibrary()
const unchangedInput = await runAsync(['--item', 'EDIT0001', '--set', 'title=A paper'])
check(unchangedInput.status === 0, 'a change that changes nothing exits 0', `status ${unchangedInput.status}`)
check(unchangedInput.stdout.includes('No change'), 'and is reported as nothing to do', 'no write planned')
check(writes().length === 0, 'and no PATCH was sent for it', `${writes().length} write(s)`)

resetLibrary()
const edited = await runAsync(['--item', 'EDIT0001', '--set', 'title=A new title', '--write'])
check(edited.status === 0, 'a write the library accepts exits 0', `status ${edited.status}`)
check(stub.record.title === 'A new title', 'and the stub library holds the new value')
check(stub.record.version === 13, 'and the record moved one version', `version ${stub.record.version}`)

resetLibrary()
const tagged = await runAsync(['--item', 'EDIT0001', '--add-tag', '/done', '--remove-tag', '/unread', '--write'])
check(tagged.status === 0, 'a tag swap exits 0', `status ${tagged.status}`)
check(
  JSON.stringify(stub.record.tags) === JSON.stringify([{ tag: '/keep' }, { tag: '/done' }]),
  'and the whole next list was sent, not a delta',
  JSON.stringify(stub.record.tags),
)

// 5xx that landed: the read-back shows the value, so the answer cannot be "nothing was written".
resetLibrary()
stub.patchItem = (record, patch) => {
  Object.assign(record, patch)
  record.version += 1
  return { status: 500 }
}
const landed = await runAsync(['--item', 'EDIT0001', '--set', 'title=A new title', '--write'])
check(landed.status === 3, 'a 500 that landed is exit 3, not 1', `status ${landed.status}`)
check(landed.stderr.includes('WRITTEN BUT UNCONFIRMED'), 'and it says the write may exist', first(landed.stderr))
check(landed.stderr.includes('the write landed'), 'and the re-read is what settles it')

resetLibrary()
stub.patchItem = () => ({ status: 500 })
const lost = await runAsync(['--item', 'EDIT0001', '--set', 'title=A new title', '--write'])
check(lost.status === 3, 'a 500 that did not land is still exit 3', `status ${lost.status}`)
check(lost.stderr.includes('does not show title'), 'and it names the field the re-read does not show', first(lost.stderr))

// 412 and a version that really moved: the application edited the record while this ran.
resetLibrary()
stub.patchItem = (record) => {
  record.version += 1
  return { status: 412 }
}
const raced = await runAsync(['--item', 'EDIT0001', '--set', 'title=A new title', '--write'])
check(raced.status === 1, 'a write that lost a race is exit 1', `status ${raced.status}`)
check(raced.stderr.includes('CONFLICT'), 'and it is called a conflict', first(raced.stderr))
check(raced.stderr.includes('Nothing was written'), 'and it says nothing was written')

// Accepted, 2xx, and the record still reads the old value: the worst case, because nothing else reports it.
resetLibrary()
stub.patchItem = (record) => {
  record.version += 1
  return { status: 204 }
}
const unchanged = await runAsync(['--item', 'EDIT0001', '--set', 'title=A new title', '--write'])
check(unchanged.status === 3, 'an accepted edit that did not take is exit 3', `status ${unchanged.status}`)
check(unchanged.stderr.includes('does not read back as sent'), 'and it says the record differs from what was sent')

resetLibrary()
stub.patchItem = () => ({ status: 400 })
const refused = await runAsync(['--item', 'EDIT0001', '--set', 'title=A new title', '--write'])
check(refused.status === 1, 'a 4xx refusal is exit 1: nothing was written', `status ${refused.status}`)
check(refused.stderr.includes('refused the write'), 'and it says so in the library\'s own terms', first(refused.stderr))

resetLibrary()
stub.authorize = () => ({ status: 403 })
const declined = await runAsync(['--item', 'EDIT0001', '--set', 'title=A new title', '--write'])
check(declined.status === 1, 'a declined dialog is exit 1, not 3', `status ${declined.status}`)
check(writes().length === 0, 'and no PATCH reached the library', `${writes().length} write(s)`)

resetLibrary()
const refusedField = await runAsync(['--item', 'EDIT0001', '--set', 'creators=Someone'])
check(refusedField.status === 2, 'a refused field is a usage error: exit 2', `status ${refusedField.status}`)
check(refusedField.stderr.includes('edit it in the application'), 'and it names where to go instead', first(refusedField.stderr))

resetLibrary()
const unknownField = await runAsync(['--item', 'EDIT0001', '--set', 'publisher=Someone'])
check(unknownField.status === 2, 'a field outside the whitelist is exit 2', `status ${unknownField.status}`)

// --- keys, actions, and the trash graph ----------------------------------------------------------

console.log('\n[5] keys, actions and the trash graph')
const action = (overrides) =>
  resolveAction({ items: [], sets: [], add: [], remove: [], restore: [], note: '', text: null, purgeTags: [], ...overrides })

check(parseItemKeys(['ABCD1234,EFGH5678']).length === 2, 'one comma-separated value names two records')
check(parseItemKeys(['ABCD1234', 'ABCD1234']).join(',') === 'ABCD1234', 'a repeated key stays one record')
throws('a malformed key is a usage error', () => parseItemKeys(['abc']), 'not an item key')
throws('an empty key is a usage error', () => parseItemKeys(['ABCD1234,']), 'not an item key')

check(action({ items: ['ABCD1234'], sets: ['title=x'] }) === 'edit', 'a set is an edit')
check(action({ restore: ['ABCD1234'] }) === 'restore', '--restore is a restore')
check(action({ note: 'ABCD1234', text: '<p>x</p>' }) === 'note', '--note with --text is a note update')
check(action({ purgeTags: ['/stale'] }) === 'purge', '--purge-tag is a purge')
throws('two actions at once are refused', () => action({ items: ['ABCD1234'], sets: ['title=x'], purgeTags: ['/x'] }), 'ONE action')
throws('--item without an edit flag is refused', () => action({ items: ['ABCD1234'] }), 'pass one action')
throws('--note without --text is refused', () => action({ note: 'ABCD1234' }), 'pass --text')
throws('--text outside --note is refused', () => action({ items: ['ABCD1234'], sets: ['title=x'], text: 'x' }), 'only applies')
throws('--item outside an edit is refused', () => action({ restore: ['ABCD1234'], items: ['EFGH5678'] }), 'does not apply')

const trashGraph = {
  key: 'PARENT01',
  version: 3,
  itemType: 'book',
  title: 'A book',
  deleted: true,
  children: [
    { key: 'CHILD001', version: 4, itemType: 'note', title: '', deleted: false, children: [] },
    { key: 'CHILD002', version: 5, itemType: 'attachment', title: 'PDF', deleted: true, children: [] },
  ],
}
const flat = flattenTrashGraph(trashGraph)
check(flat.map((node) => node.key).join(',') === 'CHILD001,CHILD002,PARENT01', 'children come before their parent', flat.map((node) => node.key).join(','))
check(flat[0].children === undefined, 'the flat list drops the child lists')
check(isDeleted(true) && isDeleted(1) && isDeleted('1'), 'every shape of deleted means trashed')
check(!isDeleted(0) && !isDeleted(false) && !isDeleted(undefined), 'a live record is not trashed')

resetLibrary()
const notNote = await runAsync(['--note', 'EDIT0001', '--text', '<p>x</p>'])
check(notNote.status === 1, 'updating a record that is not a note is refused', `status ${notNote.status}`)
check(notNote.stderr.includes('not a note'), 'and the refusal says what the record is', first(notNote.stderr))

// --- the item type's own schema ------------------------------------------------------------------

console.log('\n[4] a field the item type does not have is refused before the write')
const journal = new Set(['title', 'DOI', 'publicationTitle'])
check(invalidFields({ title: 'x', DOI: '10.1/x' }, journal).length === 0, 'valid fields pass')
check(invalidFields({ publicationTitle: 'x' }, new Set(['title'])).join(',') === 'publicationTitle', 'one invalid field is named')
check(invalidFields({ publisher: 'x' }, null).length === 0, 'a build that cannot report its schema does not block the edit')

// --- restoring a trashed graph -------------------------------------------------------------------

console.log('\n[5] a restore wakes children before their parent')
const trashRows = new Map([
  ['PARENT01', { key: 'PARENT01', version: 3, itemType: 'journalArticle', title: 'A paper', deleted: 1, parentItem: '' }],
  ['CHILD001', { key: 'CHILD001', version: 4, itemType: 'note', title: '', deleted: 1, parentItem: 'PARENT01' }],
  ['CHILD002', { key: 'CHILD002', version: 5, itemType: 'attachment', title: 'PDF', deleted: 0, parentItem: 'PARENT01' }],
])
const trashWrites = []
const trashServer = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  if (path === '/api/') {
    res.writeHead(200, { 'content-type': 'application/json', 'zotero-server-id': 'stub-server' })
    res.end('{}')
    return
  }
  if (path === '/api/local/authorize' && req.method === 'POST') {
    send(200, { key: 'stub-key', remember: false })
    return
  }
  const childrenPath = /^\/api\/users\/0\/items\/([A-Z0-9]+)\/children$/.exec(path)
  if (childrenPath) {
    const rows = [...trashRows.values()].filter((row) => row.parentItem === childrenPath[1])
    send(200, rows.map((row) => ({ key: row.key, data: { ...row } })))
    return
  }
  const itemPath = /^\/api\/users\/0\/items\/([A-Z0-9]+)$/.exec(path)
  if (itemPath && trashRows.has(itemPath[1])) {
    const row = trashRows.get(itemPath[1])
    if (req.method === 'PATCH') {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const expected = req.headers['if-unmodified-since-version']
        if (String(expected) !== String(row.version)) {
          send(412, { error: 'stale' })
          return
        }
        Object.assign(row, JSON.parse(raw))
        row.version += 1
        trashWrites.push(`${row.key}@${expected}`)
        res.writeHead(204)
        res.end()
      })
      return
    }
    send(200, { data: { ...row } })
    return
  }
  send(404, { error: 'not found' })
})
await new Promise((done) => trashServer.listen(0, '127.0.0.1', done))
const trashOrigin = `127.0.0.1:${trashServer.address().port}`
const runTrash = (args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [tool, ...args], {
      env: { ...process.env, ZOTERO_LOCAL_API: trashOrigin, ZOTERO_LOCAL_KEY_STORE: grantPath },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (status) => done({ status, stdout, stderr }))
  })

const restorePlan = await runTrash(['--restore', 'PARENT01'])
check(restorePlan.status === 0, 'a dry-run restore exits 0', `status ${restorePlan.status}`)
check(!restorePlan.stdout.includes('Nothing to restore'), 'a trashed graph is not called already present')
check(trashWrites.length === 0, 'and no PATCH was sent', `${trashWrites.length} write(s)`)

const restoreRun = await runTrash(['--restore', 'PARENT01', '--write'])
check(restoreRun.status === 0, 'a restore the library accepts exits 0', `status ${restoreRun.status}`)
check(trashWrites.join(',') === 'CHILD001@4,PARENT01@3', 'the child is woken before its parent', trashWrites.join(','))
check([...trashRows.values()].every((row) => !isDeleted(row.deleted)), 'every trashed node is live afterwards')

const restoreAgain = await runTrash(['--restore', 'PARENT01', '--write'])
check(restoreAgain.status === 0 && restoreAgain.stdout.includes('Nothing to restore'), 'a live graph is already present, not rewritten')
trashServer.close()

server.close()

console.log(
  failures === 0
    ? '\nPASS - the whitelist and the no-op rule hold, and every failure path answers 0/1/3 as the header documents'
    : `\nFAIL (${failures})`,
)
process.exit(failures === 0 ? 0 : 1)
