// Self-test for the attachment-link tool, runnable without the library.
//
// Usage: node tools/tests/zotero-link-selftest.mjs
//
// Two properties are load-bearing. A destination is derived from the parent title in a form the
// filesystem accepts, so a title carrying a colon or a question mark cannot produce an unusable
// path. And an existing destination is NEVER overwritten: the tool converts, recovers an identical
// file, or reports a conflict and leaves both copies alone.
//
// Section [3] spawns the command line against a STUB library and real temporary files, because the
// failure that costs the most here is a link that was created and reported as a failure - the next
// run would answer it with a second link. Each conversion is asserted by what the stub library holds
// afterwards, not only by what the tool printed.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WAKE_NOTE_MARKER,
  classifyConflict,
  classifyDestination,
  destinationFor,
  sanitizeFilename,
  selectCandidates,
  summarize,
} from '../zotero-link-attachments.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  -> ${detail}` : ''}`)
  if (!condition) failures += 1
}

console.log('attachment link self-test')

// --- the file name ------------------------------------------------------------------------------

check(sanitizeFilename('A/B:C*D?E"F<G>H|I') === 'ABCDEFGHI', 'every character a filesystem rejects is stripped')
check(sanitizeFilename('  A   B  ') === 'A B', 'runs of whitespace collapse and the ends are trimmed')
check(sanitizeFilename('Title...') === 'Title', 'trailing dots are stripped')
check(sanitizeFilename('Title . . ') === 'Title', 'a trailing dot-and-space tail is stripped')
check(sanitizeFilename('') === 'untitled', 'an empty title falls back to a default')
check(sanitizeFilename('   ', 'K3Y') === 'K3Y', 'the fallback can be the item key')
check(sanitizeFilename('Nothing to strip') === 'Nothing to strip', 'a title needing no change is returned as-is')

// --- the destination ----------------------------------------------------------------------------

check(
  destinationFor({ targetDir: 'D:\\Store', parentTitle: 'X: Y', fallbackKey: 'K3Y' }) === 'D:\\Store\\X Y.pdf',
  'the destination joins the sanitized title and the extension',
  destinationFor({ targetDir: 'D:\\Store', parentTitle: 'X: Y', fallbackKey: 'K3Y' }),
)
check(
  destinationFor({ targetDir: 'D:\\Store\\', parentTitle: 'X', fallbackKey: 'K3Y' }) === 'D:\\Store\\X.pdf',
  'a trailing separator on the target directory does not double up',
  destinationFor({ targetDir: 'D:\\Store\\', parentTitle: 'X', fallbackKey: 'K3Y' }),
)
check(
  destinationFor({ targetDir: 'D:\\Store', parentTitle: '', fallbackKey: 'K3Y' }) === 'D:\\Store\\K3Y.pdf',
  'a missing parent title falls back to the item key',
  destinationFor({ targetDir: 'D:\\Store', parentTitle: '', fallbackKey: 'K3Y' }),
)

// --- which attachments may be converted ---------------------------------------------------------

const userLibrary = { type: 'user', id: 1 }
const groupLibrary = { type: 'group', id: 2 }
const fixture = [
  { key: 'STORED01', library: userLibrary, data: { linkMode: 'imported_file', contentType: 'application/pdf', parentItem: 'P1' } },
  { key: 'URLPDF01', library: userLibrary, data: { linkMode: 'imported_url', contentType: 'application/pdf', parentItem: 'P6' } },
  { key: 'LINKED01', library: userLibrary, data: { linkMode: 'linked_file', contentType: 'application/pdf', parentItem: 'P2' } },
  { key: 'LINKURL1', library: userLibrary, data: { linkMode: 'linked_url', contentType: 'text/html' } },
  { key: 'SNAP0001', library: userLibrary, data: { linkMode: 'imported_url', contentType: 'text/html', parentItem: 'P3' } },
  { key: 'EMBEDDED', library: userLibrary, data: { linkMode: 'embedded_image', contentType: 'image/png', parentItem: 'P5' } },
  { key: 'EMBPDF01', library: userLibrary, data: { linkMode: 'embedded_image', contentType: 'application/pdf', parentItem: 'P7' } },
  { key: 'GROUP001', library: groupLibrary, data: { linkMode: 'imported_file', contentType: 'application/pdf', parentItem: 'P4' } },
  { key: 'ORPHAN01', library: userLibrary, data: { linkMode: 'imported_file', contentType: 'application/pdf' } },
]

const { candidates, skipped } = selectCandidates(fixture)
check(
  candidates.map((candidate) => candidate.key).join(',') === 'STORED01,URLPDF01',
  'only stored PDFs in the owner library with a parent item are candidates',
  candidates.map((candidate) => candidate.key).join(','),
)
check(candidates[0].parentKey === 'P1', 'a candidate carries its parent key')
check(
  candidates.every((candidate) => candidate.contentType === 'application/pdf'),
  'a candidate carries the content type the destination extension is derived from',
  candidates.map((candidate) => candidate.contentType).join(','),
)
check(
  skipped.linked === 2 &&
    skipped.nonPdf === 2 &&
    skipped.otherLinkMode === 1 &&
    skipped.groupLibrary === 1 &&
    skipped.noParent === 1,
  'every rejected attachment is counted under its reason',
  JSON.stringify(skipped),
)
check(
  selectCandidates([]).candidates.length === 0,
  'an empty library yields no candidates rather than an error',
)
check(
  selectCandidates([{ key: 'X', data: {} }]).candidates.length === 0,
  'an attachment with no data is rejected, not converted',
)

// --- the conflict rule --------------------------------------------------------------------------

check(classifyDestination({ destinationExists: false, contentMatches: false }) === 'convert', 'a free destination is converted')
check(classifyDestination({ destinationExists: true, contentMatches: true }) === 'recover', 'an identical file is reused, not copied')
check(
  classifyDestination({ destinationExists: true, contentMatches: false }) === 'conflict',
  'a destination with different content is a conflict - never an overwrite',
)
check(
  classifyConflict({ parentLinksDestination: true }) === 'redundant',
  'a collision on a file the item already links is reported as redundant, not as a clash',
)
check(
  classifyConflict({ parentLinksDestination: false }) === 'conflict',
  'a genuine name collision stays a conflict',
)

// --- the closing report -------------------------------------------------------------------------

const counts = summarize([
  { status: 'converted' },
  { status: 'converted' },
  { status: 'conflict' },
  { status: 'missing-source' },
])
check(
  counts.converted === 2 && counts.conflict === 1 && counts['missing-source'] === 1,
  'outcomes are counted by status',
  JSON.stringify(counts),
)
check(Object.keys(summarize([])).length === 0, 'no results summarise to no counts')

// --- the index wake-up --------------------------------------------------------------------------
// A note save is what registers the library's background index drain, so the marker is the handle
// the next run uses to find that note instead of creating another one.
check(
  typeof WAKE_NOTE_MARKER === 'string' && WAKE_NOTE_MARKER.length > 10,
  'the wake-note marker is a stable, searchable string',
  WAKE_NOTE_MARKER,
)

console.log("\n[3] the command line against a stub library, not the owner's")

const scratch = mkdtempSync(join(tmpdir(), 'link-cli-'))
const storeDir = join(scratch, 'store')
mkdirSync(storeDir)
const sourceFile = join(scratch, 'stored.pdf')
writeFileSync(sourceFile, '%PDF-1.4 stub bytes\n', 'utf8')
const destinationFile = join(storeDir, 'A paper.pdf')
const grantPath = join(scratch, 'grant.json')
const tool = fileURLToPath(new URL('../zotero-link-attachments.mjs', import.meta.url))

const baseAttachments = () => [
  {
    key: 'STORED01',
    library: { type: 'user', id: 1 },
    data: {
      linkMode: 'imported_file',
      contentType: 'application/pdf',
      parentItem: 'PARENT01',
      filename: 'stored.pdf',
      version: 5,
    },
  },
]
const baseTop = () => [{ key: 'PARENT01', data: { title: 'A paper' } }]
const baseStored = () => ({
  key: 'STORED01',
  itemType: 'attachment',
  linkMode: 'imported_file',
  contentType: 'application/pdf',
  parentItem: 'PARENT01',
  version: 5,
})

// The library the tool talks to, plus the hooks a scenario replaces. A null hook means "behave like
// the thing the conversion was measured against".
const stub = {
  attachments: baseAttachments(),
  top: baseTop(),
  items: { STORED01: baseStored() },
  children: { PARENT01: [] },
  requests: [],
  created: 0,
  authorize: () => ({ status: 200, body: { key: 'stub-key', remember: false } }),
  createLink: null,
  deleteAttachment: null,
  itemReadStatus: 0,
}

const resetLibrary = () => {
  stub.attachments = baseAttachments()
  stub.top = baseTop()
  stub.items = { STORED01: baseStored() }
  stub.children = { PARENT01: [] }
  stub.requests.length = 0
  stub.created = 0
  stub.authorize = () => ({ status: 200, body: { key: 'stub-key', remember: false } })
  stub.createLink = null
  stub.deleteAttachment = null
  stub.itemReadStatus = 0
  rmSync(destinationFile, { force: true })
}

/** A created linked attachment, in the shape the tool reads back. */
const addLink = (payload) => {
  const key = `NEWLINK${String(++stub.created).padStart(2, '0')}`
  const data = {
    key,
    itemType: 'attachment',
    linkMode: 'linked_file',
    parentItem: payload.parentItem,
    contentType: payload.contentType,
    path: payload.path,
    title: payload.title,
    version: 1,
  }
  stub.items[key] = data
  stub.children[payload.parentItem] = [...(stub.children[payload.parentItem] ?? []), key]
  return key
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
  if (path === '/api/users/0/items/top') {
    send(200, stub.top)
    return
  }
  if (path === '/api/users/0/items' && req.method === 'GET') {
    send(200, stub.attachments)
    return
  }
  if (path === '/api/users/0/items' && req.method === 'POST') {
    readBody((raw) => {
      const [payload] = JSON.parse(raw)
      if (stub.createLink) {
        const answer = stub.createLink(payload)
        send(answer.status, answer.body)
        return
      }
      send(200, { successful: { 0: addLink(payload) } })
    })
    return
  }
  const fileUrl = /^\/api\/users\/0\/items\/([A-Z0-9]+)\/file\/view\/url$/.exec(path)
  if (fileUrl) {
    if (fileUrl[1] !== 'STORED01') {
      send(404, { error: 'no file on this item' })
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`file:///${sourceFile.replace(/\\/g, '/')}`)
    return
  }
  const childrenPath = /^\/api\/users\/0\/items\/([A-Z0-9]+)\/children$/.exec(path)
  if (childrenPath) {
    send(
      200,
      (stub.children[childrenPath[1]] ?? []).map((key) => ({ key, data: stub.items[key] })),
    )
    return
  }
  const itemPath = /^\/api\/users\/0\/items\/([A-Z0-9]+)$/.exec(path)
  if (itemPath) {
    if (stub.itemReadStatus) {
      send(stub.itemReadStatus, { error: 'the stub could not read this item back' })
      return
    }
    const row = stub.items[itemPath[1]]
    if (!row) {
      send(404, { error: 'not found' })
      return
    }
    if (req.method === 'DELETE') {
      if (stub.deleteAttachment) {
        send(stub.deleteAttachment(row).status, { error: 'the stub refused the delete' })
        return
      }
      delete stub.items[itemPath[1]]
      noContent()
      return
    }
    send(200, { data: row })
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
const createsSent = () => stub.requests.filter((line) => line === 'POST /api/users/0/items').length
const deletesSent = () => stub.requests.filter((line) => line === 'DELETE /api/users/0/items/STORED01').length

// The plan touches nothing: not the library, not the disk.
resetLibrary()
const planRun = await runAsync(['--target', storeDir])
check(planRun.status === 0, 'a dry run exits 0', `status ${planRun.status}`)
check(planRun.stdout.includes('DRY RUN'), 'and says nothing was written')
check(
  stub.requests.every((line) => line.startsWith('GET ')),
  'every request it sent was a GET',
  stub.requests.join(' | '),
)
check(!existsSync(destinationFile), 'and no destination file appeared')

resetLibrary()
const converted = await runAsync(['--target', storeDir, '--write', '--no-wake'])
check(converted.status === 0, 'a conversion exits 0', `status ${converted.status}`)
check(converted.stdout.includes('CONVERTED STORED01 -> NEWLINK01'), 'and names the stored copy and its link')
check(existsSync(destinationFile), 'the bytes were copied under the parent title')
check(stub.items.STORED01 === undefined, 'the stored attachment left the library')
check(stub.items.NEWLINK01?.linkMode === 'linked_file', 'and the attachment that replaced it is a linked file')
check(deletesSent() === 1, 'the stored copy was deleted exactly once', String(deletesSent()))

// The create answers 500 and the link is there anyway. Second-guessing this with another create is the
// one failure that costs the owner a duplicate attachment, so the tool searches for the link first.
resetLibrary()
stub.createLink = (payload) => {
  addLink(payload)
  return { status: 500, body: { error: 'boom' } }
}
const landed = await runAsync(['--target', storeDir, '--write', '--no-wake'])
check(landed.status === 3, 'a create that failed after landing is exit 3', `status ${landed.status}`)
check(landed.stdout.includes('UNCONFIRMED STORED01'), 'and the line is called unconfirmed, not failed')
check(
  landed.stdout.includes('the parent now carries NEWLINK01'),
  'and it found the link the failed create had made',
  landed.stdout.trim().split(/\r?\n/).find((line) => line.includes('UNCONFIRMED')) ?? '',
)
check(createsSent() === 1, 'the create was not sent twice', `creates ${createsSent()}`)
check(deletesSent() === 0, 'and the stored copy was kept, because nothing was proven', `deletes ${deletesSent()}`)

// The link is created, reads back as something else, so the stored copy must not be deleted.
resetLibrary()
stub.createLink = (payload) => {
  const key = addLink(payload)
  stub.items[key] = { ...stub.items[key], contentType: 'text/html' }
  return { status: 200, body: { successful: { 0: key } } }
}
const mismatched = await runAsync(['--target', storeDir, '--write', '--no-wake'])
check(mismatched.status === 3, 'a link that does not read back as sent is exit 3', `status ${mismatched.status}`)
check(
  mismatched.stdout.includes('was created but does not read back as sent'),
  'and it says the attachment exists',
  mismatched.stdout.trim().split(/\r?\n/).find((line) => line.includes('UNCONFIRMED')) ?? '',
)
check(deletesSent() === 0, 'and the stored copy is kept', `deletes ${deletesSent()}`)

// The link is good and the deletion is refused: half a conversion, which is not success.
resetLibrary()
stub.deleteAttachment = () => ({ status: 500 })
const partial = await runAsync(['--target', storeDir, '--write', '--no-wake'])
check(partial.status === 3, 'a link that landed with the delete refused is exit 3', `status ${partial.status}`)
check(partial.stdout.includes('PARTIAL   STORED01'), 'and it is called partial, naming both halves')
check(stub.items.NEWLINK01?.linkMode === 'linked_file', 'the link exists')
check(stub.items.STORED01 !== undefined, 'and so does the stored copy it could not delete')

// The create answered with a key and the read-back then failed. The link exists; the only honest word
// is "unconfirmed", because "error" invites a second convert and "converted" is not proven.
resetLibrary()
stub.itemReadStatus = 500
const unreadable = await runAsync(['--target', storeDir, '--write', '--no-wake'])
check(unreadable.status === 3, 'a link whose read-back failed is exit 3, not 1', `status ${unreadable.status}`)
check(
  unreadable.stdout.includes('could not be read back'),
  'and it names the read-back as what failed, not the write',
  unreadable.stdout.trim().split(/\r?\n/).find((line) => line.includes('UNCONFIRMED')) ?? '',
)
check(unreadable.stdout.includes('NEWLINK01'), 'and names the key that now exists')
check(deletesSent() === 0, 'and the stored copy is kept', `deletes ${deletesSent()}`)

// A 4xx is the library refusing: nothing was written, so the answer is 1 and the run is not a success.
resetLibrary()
stub.createLink = () => ({ status: 400, body: { error: 'the stub refused the create' } })
const refused = await runAsync(['--target', storeDir, '--write', '--no-wake'])
check(refused.status === 1, 'a refused create is exit 1, not 3', `status ${refused.status}`)
check(
  refused.stdout.includes('refused the create'),
  'and the line carries the library\'s own words',
  refused.stdout.trim().split(/\r?\n/).find((line) => line.includes('ERROR')) ?? '',
)
check(deletesSent() === 0, 'and the stored copy is untouched', `deletes ${deletesSent()}`)

// Declined by the owner: nothing was written, and a run that converted nothing does not answer success.
resetLibrary()
stub.authorize = () => ({ status: 403 })
const declined = await runAsync(['--target', storeDir, '--write', '--no-wake'])
check(declined.status === 1, 'a declined dialog is exit 1, not 0', `status ${declined.status}`)
check(createsSent() === 0, 'and it sends no write at all', `creates ${createsSent()}`)
check(
  declined.stdout.includes('declined'),
  'and the item line names the dialog as the reason',
  declined.stdout.trim().split(/\r?\n/).find((line) => line.includes('ERROR')) ?? '',
)
check(stub.items.STORED01 !== undefined, 'the stored attachment is still there')

server.close()

console.log(
  failures === 0
    ? '\nPASS - the planner holds, and a conversion that landed is never reported as one that did not'
    : `\nFAIL (${failures})`,
)
process.exit(failures === 0 ? 0 : 1)
