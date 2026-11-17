// Self-test for the add-a-record tool, runnable without a library.
//
// Usage: node tools/tests/zotero-write-selftest.mjs
//
// What carries the safety of `--collection` is not the flag but three refusals around it:
//   * the key is checked against the library's own collection list BEFORE the create, because a
//     library that refuses an unknown key turns a typo into a failed write AFTER the owner already
//     answered the authorization dialog;
//   * `collections` is not an item schema field, so it must be attached to the body rather than
//     counted as a filled field - otherwise the dry run would print a filing the body does not carry;
//   * a read-back with no filing is `UNFILED`, never "added". That is the one case where the record
//     exists and the claim would be false, so the check below reads the tool's source: it must hand
//     the owner the `--assign` command and must NOT own a second write path.
//
// Section [3] spawns the command line against a STUB library. The metadata resolvers go to arXiv and
// Crossref over the network, so a preload (`NODE_OPTIONS=--require ...`) replaces `globalThis.fetch`
// in that child process only: the same kind of seam `ZOTERO_LOCAL_API` gives the library address, and
// no production code knows about it.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectionKeyProblems,
  crossrefRefusal,
  emptyFieldNames,
  matchingRecord,
  parseCollectionKeys,
  splitWholeName,
  unfiledCollections,
  unknownCollections,
  withCollections,
} from '../zotero-write.mjs'
import { decodeEntities } from '../markup.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  -> ${detail}` : ''}`)
  if (!condition) failures += 1
}

console.log('write tool self-test')

const SOURCE = readFileSync(new URL('../zotero-write.mjs', import.meta.url), 'utf8')

console.log('\n[1] --collection is read as keys, not as names')

check(
  JSON.stringify(parseCollectionKeys(['--doi', '10.1/x', '--collection', 'abcd2345'])) === '["ABCD2345"]',
  'a key pasted in lowercase is upper-cased',
  JSON.stringify(parseCollectionKeys(['--collection', 'abcd2345'])),
)
check(
  parseCollectionKeys(['--collection', 'AAAAAAAA', '--collection', 'AAAAAAAA']).length === 1,
  'a repeated key is asked for once',
)
check(
  JSON.stringify(parseCollectionKeys(['--collection', 'AAAAAAAA', '--collection', 'BBBBBBBB'])) === '["AAAAAAAA","BBBBBBBB"]',
  'two collections keep their order',
)
check(
  parseCollectionKeys(['--collection', 'Reading list']).length === 1,
  'a collection NAME is read, so that it can be refused rather than resolved',
)
check(
  collectionKeyProblems(parseCollectionKeys(['--collection', 'Reading list'])).length === 1,
  'and it is refused: a name is not a key',
)

console.log('\n[2] a malformed key never reaches a write')

check(collectionKeyProblems(['']).length === 1, 'a flag with no value is a problem')
check(parseCollectionKeys(['--collection', '--write']).join() === '', 'a flag followed by another flag has no value')
check(collectionKeyProblems(['AB']).length === 1, 'a short key is a problem')
check(collectionKeyProblems(['ABCDEFGHI']).length === 1, 'a long key is a problem')
check(collectionKeyProblems(['ABCD-EFG']).length === 1, 'a key with punctuation is a problem')
check(collectionKeyProblems(['ABCDEFGH']).length === 0, 'eight characters of A-Z and 0-9 are accepted')

console.log('\n[3] the filing rides on the create body')

check(
  JSON.stringify(withCollections({ title: 't' }, ['ABCDEFGH']).collections) === '["ABCDEFGH"]',
  'the body carries collections',
  JSON.stringify(withCollections({ title: 't' }, ['ABCDEFGH'])),
)
check(withCollections({ title: 't' }, []).collections === undefined, 'no flag leaves the field off the body entirely')
check(
  withCollections({ title: 't' }, ['ABCDEFGH']).title === 't',
  'the template fields survive the filing',
)
check(
  JSON.stringify(withCollections({ title: 't' }, ['ABCDEFGH'])) !== JSON.stringify({ title: 't' }),
  'negative control: a filed body differs from an unfiled one',
)

console.log('\n[4] a filing is judged from the READ-BACK, not from the response')

check(
  unfiledCollections(['AAAAAAAA', 'BBBBBBBB'], 'AAAAAAAA').join(' ') === 'BBBBBBBB',
  'one filed key arrives as a bare string and is compared as one',
)
check(
  unfiledCollections(['AAAAAAAA'], ['AAAAAAAA']).length === 0,
  'an array-shaped read-back is compared too',
)
check(
  unfiledCollections(['AAAAAAAA'], false).join(' ') === 'AAAAAAAA',
  'a record at the root reads back as false, which is no filing rather than one named "false"',
)
check(
  unfiledCollections(['AAAAAAAA'], ['BBBBBBBB']).join(' ') === 'AAAAAAAA',
  'a different collection is not the one that was asked for',
)
check(unfiledCollections([], ['AAAAAAAA']).length === 0, 'nothing asked for is nothing missing')

console.log('\n[5] the key is checked against the library before writing')

check(unknownCollections(['GONE0000'], [{ key: 'HERE0000' }]).length === 1, 'a key the library does not have is unknown')
check(unknownCollections(['HERE0000'], [{ key: 'HERE0000' }]).length === 0, 'a key the library has is known')
check(unknownCollections([], []).length === 0, 'no key is always known')
check(unknownCollections(['HERE0000'], []).length === 1, 'an empty collection list knows nothing')

console.log('\n[6] the tool owns no second write')

check(!/patchItem|patchCollection/.test(SOURCE), 'it imports no patch path, so a filing cannot be written behind the create')
check(SOURCE.includes('UNFILED'), 'the unfiled case is stated rather than passed over')
check(
  /node "\$\{COLLECTION_TOOL\}" --assign/.test(SOURCE),
  'and it hands the owner the one command that files the record',
)
check(
  /COLLECTION_TOOL = fileURLToPath\(new URL\('\.\/zotero-collection\.mjs', import\.meta\.url\)\)/.test(SOURCE),
  'that command is an absolute path from where this file lives, so it resolves outside this repository',
)
check(
  !/node tools\/zotero-collection\.mjs/.test(SOURCE),
  'negative control: no relative tools/ path is printed as a command',
)
check(/readItem\(itemKey\)/.test(SOURCE), 'the created record is read back')
check(/withCollections\(bare, wanted\)/.test(SOURCE), 'the body posted is the one the dry run printed')

console.log('\n[7] a DOI is compared in one form, and a Crossref 404 is not a missing work')

// The duplicate guard used to compare exact strings, so `https://doi.org/10.x/y` in the library and
// `10.x/y` in the payload were two different works and the second one was created.
const held = [{ key: 'HELD0001', data: { title: 'Seismic resilience of networks', DOI: 'https://doi.org/10.1016/J.RESS.2023.109755' } }]
check(
  matchingRecord(held, { title: 'Something else', DOI: '10.1016/j.ress.2023.109755' })?.key === 'HELD0001',
  'a DOI stored as a resolver URL is the same DOI as the bare one',
)
check(
  matchingRecord([{ key: 'TITLE001', data: { title: 'Seismic Resilience of Networks.' } }], { title: 'seismic resilience of networks' })?.key ===
    'TITLE001',
  'a title differing only in case and trailing punctuation is the same work',
)
check(
  matchingRecord([{ key: 'EMPTY001', data: { title: 'x', DOI: '' } }], { title: 'y', DOI: '' }) === null,
  'two empty DOIs are not a match: a missing identifier has not shown anything',
)
check(
  matchingRecord([{ key: 'OTHER001', data: { title: 'x', DOI: '10.1/other' } }], { title: 'y', DOI: '10.1/wanted' }) === null,
  'a different DOI is not a duplicate',
)
check(
  matchingRecord([{ key: 'ARXIV001', data: { title: 'x', archiveID: 'arXiv:1706.03762' } }], { title: 'y', archiveID: 'arXiv:1706.03762' })
    ?.key === 'ARXIV001',
  'the arXiv id still settles a preprint with no title or DOI match',
)

// A 404 from Crossref is the case that made two Chinese references look absent. It must not be
// reported as a plain failure, and the refusal must name a program that can still answer.
const notIndexed = crossrefRefusal('10.19999/cn.2025.0102', 404)
check(
  /^node ".*metadata\.mjs" --doi 10\.19999\/cn\.2025\.0102 --source openalex$/.test(notIndexed.command),
  'a 404 names an absolute-path command against another index',
  notIndexed.command,
)
check(
  notIndexed.fix.includes('doi.org') && notIndexed.fix.includes('--cite') && notIndexed.fix.includes('manual --field'),
  'and says doi.org answers in citation form, and that a manual create is the remaining way',
  notIndexed.fix.slice(0, 60),
)
check(JSON.stringify(notIndexed.checked) === '["Crossref"]', 'the refusal states what was checked')
check(crossrefRefusal('10.1/x', 429).fix.includes('wait'), 'a 429 is rate limiting, not a verdict on the DOI')
check(crossrefRefusal('10.1/x', 503).fix.includes('not a missing record'), 'a 5xx is a transport fault, and says so')
check(
  /const bare = sameDoi\(doi\)/.test(SOURCE) && /crossrefRefusal\(bare, res\.status\)/.test(SOURCE),
  'the resolver sends the normalized DOI and refuses through that helper',
)

console.log('\n[7b] a name that arrived whole, and the fields that arrived empty')

const split = splitWholeName({ family: 'Deyu Cai' })
check(split.lastName === 'Cai' && split.firstName === 'Deyu', 'one whole name is split with the last word as the family name', `${split.firstName} | ${split.lastName}`)
const both = splitWholeName({ given: 'Ashish', family: 'Vaswani' })
check(both.firstName === 'Ashish' && both.lastName === 'Vaswani', 'a name with both slots is left alone')
check(splitWholeName({ family: 'Vaswani' }).lastName === 'Vaswani', 'a single word has no split to make')
check(
  splitWholeName({ given: 'Juan Carlos', family: 'de la Llera' }).lastName === 'de la Llera',
  'a family name with spaces and a given name beside it is kept whole',
)

const empty = emptyFieldNames({ itemType: 'journalArticle', creators: [], title: 'A', DOI: '', volume: '', issue: '' })
check(empty.join(', ') === 'DOI, volume, issue', 'the empty fields are named in payload order', empty.join(', '))
check(emptyFieldNames({ itemType: 'note', title: '' }).includes('itemType') === false, 'and the record structure is not mistaken for a field')

check(decodeEntities('Reliability Engineering &amp; System Safety') === 'Reliability Engineering & System Safety', 'the entity Crossref sends is decoded')
check(decodeEntities('&#233;t&#xE9;') === 'été', 'and so is a numeric entity')
check(decodeEntities('&unknown;') === '&unknown;', 'an entity this suite does not know is left as it was')

console.log("\n[8] the command line against a stub library and a stub arXiv, not the owner's")

const scratch = mkdtempSync(join(tmpdir(), 'write-cli-'))
const grantPath = join(scratch, 'grant.json')
const preload = join(scratch, 'stub-fetch.cjs')
const tool = fileURLToPath(new URL('../zotero-write.mjs', import.meta.url))

// The one record the stub arXiv answers with. Shape matches the Atom feed the resolver parses: an
// entry, one title, one published date, one summary, one DOI element and the author names.
const arXivRecord = {
  title: 'Attention Is All You Need',
  published: '2017-06-12T00:00:00Z',
  summary: 'The dominant sequence transduction models are based on complex recurrent networks.',
  doi: '10.1000/arxiv',
  creators: ['Ashish Vaswani', 'Noam Shazeer'],
}
const arxivXml =
  '<feed xmlns:arxiv="http://arxiv.org/schemas/atom"><entry>' +
  `<title>  ${arXivRecord.title}  </title>` +
  `<published>${arXivRecord.published}</published>` +
  `<summary>  ${arXivRecord.summary}  </summary>` +
  `<arxiv:doi>${arXivRecord.doi}</arxiv:doi>` +
  arXivRecord.creators.map((name) => `<name>${name}</name>`).join('') +
  '</entry></feed>'
const crossrefRecord = {
  message: {
    title: ['Seismic fragility of &amp; substations'],
    author: [{ given: 'Nicolás', family: 'Ahumada' }, { family: 'Deyu Cai' }, { name: 'IEEE Power Group' }],
    abstract: '<jats:p>Fragility &amp; short circuit faults.</jats:p>',
    issued: { 'date-parts': [[2026]] },
    'container-title': ['Reliability Engineering &amp; System Safety'],
    volume: '268',
    page: '112001',
    DOI: '10.29999/FIXTURE',
    URL: 'https://example.org/fixture',
    language: 'en',
    ISSN: ['0951-8320'],
    ISBN: ['978-1-0000-0000-0'],
  },
}
writeFileSync(
  preload,
  [
    '// Replaces global fetch in this child process only, so the resolvers answer offline.',
    'const realFetch = globalThis.fetch',
    'globalThis.fetch = async (url, init) => {',
    '  if (String(url).includes("export.arxiv.org")) {',
    `    return new Response(${JSON.stringify(arxivXml)}, { status: 200, headers: { "content-type": "text/xml" } })`,
    '  }',
    '  if (String(url).includes("api.crossref.org")) {',
    `    return new Response(${JSON.stringify(JSON.stringify(crossrefRecord))}, { status: 200, headers: { "content-type": "application/json" } })`,
    '  }',
    '  return realFetch(url, init)',
    '}',
    '',
  ].join('\n'),
  'utf8',
)

/** The fields a preprint accepts, as `/api/itemTypeFields` answers them. */
const PREPRINT_FIELDS = [
  'title',
  'abstractNote',
  'date',
  'repository',
  'archiveID',
  'url',
  'DOI',
  'extra',
  'shortTitle',
  'language',
  'rights',
  'libraryCatalog',
  'callNumber',
  'place',
  'publisher',
]

// The library the tool talks to, plus the hooks a scenario replaces.
const stub = {
  items: {},
  collections: [{ key: 'COLABC01', data: { name: 'Example collection', parentCollection: false } }],
  requests: [],
  searches: [],
  authorize: () => ({ status: 200, body: { key: 'stub-key', remember: false } }),
  createStatus: null,
  readBack: null,
  fields: null,
}

const resetLibrary = () => {
  stub.items = {}
  stub.requests.length = 0
  stub.searches = []
  stub.authorize = () => ({ status: 200, body: { key: 'stub-key', remember: false } })
  stub.createStatus = null
  stub.readBack = null
  stub.fields = null
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  stub.requests.push(`${req.method} ${path}`)
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
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
  if (path === '/api/itemTypeFields') {
    send(200, (stub.fields ?? PREPRINT_FIELDS).map((field) => ({ field })))
    return
  }
  if (path === '/api/itemTypeCreatorTypes') {
    send(200, [{ creatorType: 'author' }])
    return
  }
  if (path === '/api/users/0/collections' && req.method === 'GET') {
    send(200, stub.collections)
    return
  }
  if (path === '/api/users/0/items' && req.method === 'GET') {
    // The duplicate pre-check pops one answer; a scenario queues [!] for the case it wants.
    send(200, stub.searches.shift() ?? [])
    return
  }
  if (path === '/api/users/0/items' && req.method === 'POST') {
    readBody((raw) => {
      const [item] = JSON.parse(raw)
      if (stub.createStatus) {
        const answer = stub.createStatus(item)
        send(answer.status, answer.body ?? {})
        return
      }
      stub.items.NEWITEM1 = { ...item, key: 'NEWITEM1', version: 1 }
      send(200, { successful: { 0: 'NEWITEM1' } })
    })
    return
  }
  const itemPath = /^\/api\/users\/0\/items\/([A-Z0-9]+)$/.exec(path)
  if (itemPath) {
    const row = stub.items[itemPath[1]]
    if (!row) {
      send(404, { error: 'not found' })
      return
    }
    send(200, { data: stub.readBack ? stub.readBack(row) : row })
    return
  }
  send(404, { error: 'not found' })
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `127.0.0.1:${server.address().port}`
const runAsync = (args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [tool, ...args], {
      env: {
        ...process.env,
        ZOTERO_LOCAL_API: origin,
        ZOTERO_LOCAL_KEY_STORE: grantPath,
        NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"`,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
const creates = () => stub.requests.filter((line) => line === 'POST /api/users/0/items')
/** What to show as the detail: the first line that says something, not the whole transcript. */
const first = (text) => text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''

resetLibrary()
const planned = await runAsync(['--arxiv', '1706.03762'])
check(planned.status === 0, 'a dry run exits 0', `status ${planned.status}`)
check(planned.stdout.includes('DRY RUN'), 'and says nothing was written')
check(planned.stdout.includes(arXivRecord.title), 'and prints the title the resolver returned')
check(creates().length === 0, 'and no create was sent', `${creates().length} create(s)`)

resetLibrary()
const created = await runAsync(['--arxiv', '1706.03762', '--write'])
check(created.status === 0, 'a create the library accepts exits 0', `status ${created.status}`)
check(created.stdout.includes('is now in the library'), 'and says the record is there', first(created.stdout))
check(stub.items.NEWITEM1?.title === arXivRecord.title, 'and the stub library holds the title')
check(stub.items.NEWITEM1?.DOI === arXivRecord.doi, 'and the DOI')
check((stub.items.NEWITEM1?.creators ?? []).length === arXivRecord.creators.length, 'and both creators')
check(creates().length === 1, 'exactly one create was sent', `${creates().length} create(s)`)

// The filing is carried by the create, and the read-back is what decides whether it stuck.
resetLibrary()
const filed = await runAsync(['--arxiv', '1706.03762', '--collection', 'COLABC01', '--write'])
check(filed.status === 0, 'a create filed into a known collection exits 0', `status ${filed.status}`)
check(
  JSON.stringify(stub.items.NEWITEM1?.collections) === '["COLABC01"]',
  'and the create body carried the filing',
  JSON.stringify(stub.items.NEWITEM1?.collections),
)

// The record exists and only the filing did not stick: "added" would be the lie this tool exists to avoid.
resetLibrary()
stub.readBack = (row) => ({ ...row, collections: [] })
const unfiled = await runAsync(['--arxiv', '1706.03762', '--collection', 'COLABC01', '--write'])
check(unfiled.status === 3, 'a record that reads back unfiled is exit 3, not 1 and not 0', `status ${unfiled.status}`)
check(unfiled.stderr.includes('UNFILED'), 'and it says the record IS in the library', first(unfiled.stderr))
check(unfiled.stderr.includes('--assign NEWITEM1 --collection COLABC01'), 'and hands over the one command that files it')
check(creates().length === 1, 'and it did not write a second time', `${creates().length} create(s)`)

// 500 on the create, and the search finds the record anyway: the next run must not create it again.
resetLibrary()
stub.createStatus = () => ({ status: 500 })
stub.searches = [[], [{ key: 'NEWITEM1', data: { title: arXivRecord.title } }]]
const landed = await runAsync(['--arxiv', '1706.03762', '--write'])
check(landed.status === 3, 'a create that failed after landing is exit 3', `status ${landed.status}`)
check(landed.stderr.includes('the record exists'), 'and the search is what settles it', first(landed.stderr))
check(creates().length === 1, 'and the create was not sent twice', `${creates().length} create(s)`)

resetLibrary()
stub.createStatus = () => ({ status: 400 })
const refusedCreate = await runAsync(['--arxiv', '1706.03762', '--write'])
check(refusedCreate.status === 1, 'a 4xx create is exit 1: nothing was written', `status ${refusedCreate.status}`)
check(refusedCreate.stderr.includes('refused the create'), 'and it says so in the library\'s own terms', first(refusedCreate.stderr))

resetLibrary()
stub.readBack = (row) => ({ ...row, title: 'A different title' })
const mismatched = await runAsync(['--arxiv', '1706.03762', '--write'])
check(mismatched.status === 3, 'a record that does not read back as sent is exit 3', `status ${mismatched.status}`)
check(mismatched.stderr.includes('Read it before editing it'), 'and it says what to do before touching it')

// Already in the library: nothing to do, which is exit 0 - the same answer `zotero-edit` gives for a
// change that changes nothing, and the one docs/decisions.md §40 ruled for an already-recorded record.
resetLibrary()
stub.searches = [[{ key: 'EXIST001', data: { title: arXivRecord.title } }]]
const duplicate = await runAsync(['--arxiv', '1706.03762', '--write'])
check(duplicate.status === 0, 'a duplicate is exit 0: the state asked for already holds', `status ${duplicate.status}`)
check(duplicate.stdout.includes('ALREADY IN THE LIBRARY'), 'and it says the record is there', first(duplicate.stdout))
check(!duplicate.stdout.includes('REFUSING'), 'and it does not call a no-op a refusal')
check(creates().length === 0, 'and no create was sent', `${creates().length} create(s)`)

resetLibrary()
stub.searches = [[{ key: 'EXIST001', data: { title: arXivRecord.title } }]]
const forced = await runAsync(['--arxiv', '1706.03762', '--write', '--force'])
check(forced.status === 0, '--force creates the second copy anyway', `status ${forced.status}`)
check(creates().length === 1, 'and that is the one create it sends', `${creates().length} create(s)`)

// A bad key costs no request at all: the argument is refused before the gate is opened.
resetLibrary()
const badKey = await runAsync(['--arxiv', '1706.03762', '--collection', 'nope'])
check(badKey.status === 2, 'a malformed collection key is a usage error', `status ${badKey.status}`)
check(badKey.stderr.includes('eight-character key'), 'and it says what a key looks like', first(badKey.stderr))
check(stub.requests.length === 0, 'and not one request was sent', `${stub.requests.length} request(s)`)

resetLibrary()
const unknownKey = await runAsync(['--arxiv', '1706.03762', '--collection', 'ZZZZZZZZ'])
check(unknownKey.status === 1, 'a collection the library does not have is refused', `status ${unknownKey.status}`)
check(unknownKey.stderr.includes('no collection ZZZZZZZZ'), 'and it names the key', first(unknownKey.stderr))
check(creates().length === 0, 'and nothing was created', `${creates().length} create(s)`)

resetLibrary()
stub.authorize = () => ({ status: 403 })
const declined = await runAsync(['--arxiv', '1706.03762', '--write'])
check(declined.status === 1, 'a declined dialog is exit 1, not 3', `status ${declined.status}`)
check(creates().length === 0, 'and no create reached the library', `${creates().length} create(s)`)

resetLibrary()
const noSource = await runAsync(['--write'])
// Exit 2, not 1: naming neither source is a malformed command line, and a caller that reads 1 would go
// looking for a write that refused when the program never got as far as asking the library.
check(noSource.status === 2, 'no --arxiv and no --doi is a usage error, and says so with exit 2', `status ${noSource.status}`)

// The other resolver: a Crossref deposit carrying the things that used to reach the library raw - HTML
// entities, a creator whose given and family came as one string, and an ISBN that marks a proceedings
// deposit rather than the journal article the resolver would file it as.
resetLibrary()
// A journal article's own fields, so the plan can carry the container title the deposit names.
stub.fields = ['title', 'abstractNote', 'date', 'publicationTitle', 'volume', 'issue', 'pages', 'DOI', 'url', 'language', 'ISSN']
const crossref = await runAsync(['--doi', '10.29999/FIXTURE'])
check(crossref.status === 0, 'a Crossref deposit the publisher marked up is read', `status ${crossref.status}`)
check(crossref.stdout.includes('Seismic fragility of & substations'), 'and the title is decoded, not kept as &amp;', first(crossref.stdout))
check(crossref.stdout.includes('Reliability Engineering & System Safety'), 'and so is the journal title')
check(!crossref.stdout.includes('&amp;'), 'and no entity survives into the plan')
check(crossref.stdout.includes('Fragility & short circuit faults.'), 'nor into the abstract, whose markup tags are dropped')
check(crossref.stdout.includes('name ?'), 'a creator that arrived as one string is called out')
check(crossref.stdout.includes('Cai, Deyu'), 'and split with the last word as the family name')
check(crossref.stdout.includes('type ?'), 'and a deposit that carries an ISBN is called out as possibly a conference paper')
check(crossref.stdout.includes('--item-type conferencePaper'), 'and the way to act on that is spelled out')
check(crossref.stdout.includes('empty     : '), 'and the fields left empty are listed rather than implied')
check(creates().length === 0, 'a dry run still wrote nothing')

// The warning is only worth printing if there is a way to act on it, so the override must be legal.
resetLibrary()
const typed = await runAsync(['--doi', '10.29999/FIXTURE', '--item-type', 'conferencePaper'])
check(typed.status === 0, '--item-type beside --doi overrides the type the source would pick', `status ${typed.status}`)
check(typed.stdout.includes('conferencePaper'), 'and the plan is built for that type')

server.close()

console.log(
  failures === 0
    ? '\nPASS - the three refusals around --collection hold, and the create answers 0/1/3 as the header documents'
    : `\nFAIL (${failures})`,
)
process.exit(failures === 0 ? 0 : 1)
