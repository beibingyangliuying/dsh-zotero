// The section-note tool's offline suite: identity is a tag, nothing is parsed from prose, and no
// automatic prose repair exists. Runnable with no library and no authorization.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AGENT_TAG,
  REPAIRED_TAG,
  REVIEWED_TAG,
  allowedMoves,
  authorityOf,
  changeClass,
  changedSpan,
  composeSectionNote,
  coveringNote,
  firstBlockText,
  isAgentNote,
  isApplicationWrapped,
  isDigest,
  isImported,
  isRepaired,
  isRetired,
  isReviewed,
  looksLikeHtml,
  normalizeSectionToken,
  planJson,
  provenanceOf,
  readSectionTag,
  repairTags,
  replacesKey,
  replacesTag,
  retireTags,
  reviewTags,
  sectionTag,
  sectionTokenFromTag,
  sectionWriteToken,
  successorOf,
} from '../zotero-section-note.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}
const same = (actual, expected, label) => check(actual === expected, label, actual === expected ? '' : `got ${JSON.stringify(actual)}`)
const refused = (run, label) => {
  try {
    run()
  } catch (error) {
    return error.message
  }
  check(false, label, 'it did not throw')
  return ''
}

console.log('\n[1] the ordinal a write may use')
same(normalizeSectionToken('2'), '2', 'digits pass through')
same(normalizeSectionToken('二'), '2', 'a Chinese numeral becomes digits')
same(normalizeSectionToken('十二'), '12', 'twelve is twelve')
same(normalizeSectionToken('第三节'), '3', 'a wrapped phrase is unwrapped')
same(normalizeSectionToken('文章第7节'), '7', 'the article prefix is unwrapped too')
same(normalizeSectionToken('Methodology'), '', 'no ordinal means no token - negative control')
same(normalizeSectionToken('3.1'), '3.1', 'a dotted number is kept only to be refused by the write path')
same(sectionWriteToken('3'), '3', 'writing a top-level ordinal is what happens')
same(sectionWriteToken('三'), '3', 'a Chinese numeral is written as digits')
same(sectionWriteToken('第7节'), '7', 'and a wrapped phrase is unwrapped')
const dotted = refused(() => sectionWriteToken('3.1'), 'WRITING a dotted ordinal is refused')
check(/pass --section 3\./.test(dotted), 'and the refusal says which ordinal to pass instead', dotted)

console.log('\n[2] identity is a /section-N tag')
same(sectionTag('2'), '/section-2', 'a claim is a tag')
same(sectionTokenFromTag('/section-2'), '2', 'and the ordinal reads back')
same(sectionTokenFromTag('/Section-2'), '2', 'case does not matter')
same(sectionTokenFromTag('/section-note'), '', "the earlier round's /section-note tag is not a claim")
same(sectionTokenFromTag('/section-3.1'), '', 'a dotted tag is not a top-level claim')
same(readSectionTag(['/section-2']).token, '2', 'one tag is one claim')
same(readSectionTag(['/Section-2']).token, '2', 'case is ignored when reading')
same(readSectionTag(['/section-2', '/section-3']).ambiguous, true, 'two section tags are ambiguous, not a guess')
same(readSectionTag(['/section-2', '/section-2']).ambiguous, false, 'the same tag twice is still one claim')
check(readSectionTag(['/section-3.1']).invalid.includes('/section-3.1'), 'a dotted tag is reported as invalid')
same(readSectionTag([]).token, '', 'no tag is no claim - negative control')

console.log('\n[3] retire, imported, agent, reviewed and a legacy summary are different marks')
check(!isRetired([]), 'no tags means live - negative control')
check(isRetired(['/retired']), 'the retire tag retires')
check(isRetired(['/Retired']), 'and a hand-typed capitalisation counts too')
check(!isRetired(['/section-note']), "the earlier round's tag does not retire")
same(retireTags(['/section-2']).join(' '), '/section-2 /retired', 'retiring keeps every tag the note already had')
same(retireTags(['/retired', '/section-2']).join(' '), '/section-2 /retired', 'and it is idempotent')
same(retireTags(['/retired', '/x'], { undo: true }).join(' '), '/x', 'undo removes the mark and nothing else')
check(isImported(['/imported']), 'an imported note carries /imported')
check(!isImported(['/section-2']), 'a native record does not')
check(isDigest(['/digest']), 'a legacy summary carries /digest')
check(!isDigest(['/section-2']), 'a section note does not')
check(isAgentNote([AGENT_TAG]), 'an agent-written body carries /agent-note')
check(isAgentNote(['agent-note']), 'the bare form an earlier round wrote is the same mark')
check(!isAgentNote(['/section-2']), 'an owner note is not an agent note - negative control')
check(isReviewed([REVIEWED_TAG]), 'the owner acceptance carries /reviewed')
check(!isReviewed([AGENT_TAG]), 'an unreviewed draft does not')
same(reviewTags([AGENT_TAG, '/section-2']).join(' '), '/agent-note /section-2 /reviewed', 'reviewing adds one tag and keeps the rest')
same(reviewTags([AGENT_TAG, '/section-2', REVIEWED_TAG], { undo: true }).join(' '), '/agent-note /section-2', 'undo removes only the review')
same(provenanceOf(['/section-2']), 'owner', 'a claim with no authorship tag is the owner\'s')
same(provenanceOf(['/section-2', '/imported']), 'import', 'an import is an import')
same(provenanceOf(['/section-2', AGENT_TAG]), 'agent', 'an agent body is an agent body')
same(provenanceOf(['/section-2', AGENT_TAG, REVIEWED_TAG]), 'agent+reviewed', 'and a reviewed one says so')
same(authorityOf(['/section-2'], '2'), 'record', 'an owner record carries record authority')
same(authorityOf(['/section-2', AGENT_TAG], '2'), 'candidate', 'an unreviewed agent body is a candidate only')
same(authorityOf(['/section-2', AGENT_TAG, REVIEWED_TAG], '2'), 'record', 'reviewing restores record authority')
same(authorityOf([AGENT_TAG], ''), 'none', 'an agent note that claims no section carries no authority')
same(authorityOf(['/section-2', '/retired'], '2'), 'none', 'a tombstone carries none either')

console.log('\n[3b] a repair keeps the note, its claim and its provenance')
check(!isRepaired(['/section-2']), 'a note never repaired carries no mark')
same(repairTags(['/section-2']).join(' '), '/section-2 /repaired', 'a repair adds one mark and keeps the claim')
same(repairTags(['/section-2', REPAIRED_TAG]).join(' '), '/section-2 /repaired', 'and it is idempotent')
same(
  repairTags(['/section-2', AGENT_TAG, REVIEWED_TAG]).join(' '),
  '/section-2 /agent-note /reviewed /repaired',
  'a mechanical repair keeps the owner acceptance',
)
same(
  repairTags(['/section-2', AGENT_TAG, REVIEWED_TAG], { substantive: true }).join(' '),
  '/section-2 /agent-note /repaired',
  'a substantive repair drops it',
)
same(repairTags(['/section-2', '/imported']).join(' '), '/section-2 /imported /repaired', 'an import mark survives')
check(!repairTags(['/section-2', REVIEWED_TAG], { substantive: true }).includes(AGENT_TAG), 'a repair never invents the agent mark')
check(!changeClass('<p>recieve</p>', '<p>receive</p>').substantive, 'a spelling correction is mechanical')
check(changeClass('<p>x = 3</p>', '<p>x = 4</p>').substantive, 'a changed digit is substantive')
check(changeClass('<p>$\\alpha$</p>', '<p>$\\beta$</p>').substantive, 'a change inside math is substantive')
check(
  changeClass(`<p>${'a'.repeat(600)}</p>`, `<p>${'b'.repeat(600)}</p>`).substantive,
  'a rewrite of more than half the body is substantive',
)
same(changedSpan('abcdef', 'abXdef').before, 'c', 'the changed span is the smallest one, not the whole body')

console.log('\n[4] claiming a section, and what covers it')
const live = (token, extra = {}) => ({ key: `N${token}`, retired: false, digest: false, claim: { token }, ...extra })
const retired = (token, extra = {}) => ({ key: `R${token}`, retired: true, digest: false, claim: { token }, ...extra })
same(coveringNote([], '2'), undefined, 'nothing covers nothing - negative control')
same(coveringNote([live('1')], '2'), undefined, 'a different section is not coverage - negative control')
same(coveringNote([live('3.1')], '3'), undefined, 'a dotted claim is not folded into its parent: no parent/child reading')
same(coveringNote([live('2')], '2').note.key, 'N2', 'the same top-level claim is coverage')
same(coveringNote([retired('2')], '2'), undefined, 'a retired note does not cover its section')
same(coveringNote([{ ...live('2'), digest: true }], '2'), undefined, 'a legacy summary is not a section note')
same(coveringNote([{ ...live('2'), retired: true }], '2'), undefined, 'and a retired claim is writable again')

console.log('\n[5] the successor pointer and the body shape')
same(replacesTag('ABCD1234'), '/replaces-ABCD1234', 'a successor names the note it replaces')
same(replacesKey(['/replaces-ABCD1234']), 'ABCD1234', 'and that name reads back')
same(replacesKey(['/section-2']), '', 'a section tag names no predecessor - negative control')
same(successorOf([{ key: 'NEW', tags: ['/replaces-OLD'] }], 'OLD'), 'NEW', 'the successor of a retired note is found by its tag')
same(successorOf([{ key: 'NEW', tags: ['/section-2'] }], 'OLD'), '', 'and where nothing names one, nothing is reported')
same(composeSectionNote('  <p>解释</p>  '), '<p>解释</p>', 'a composed note is the body, with no marker')
check(looksLikeHtml('<p>解释</p>'), 'a paragraph is HTML')
check(looksLikeHtml('<div data-schema-version="9"><ul><li>x</li></ul></div>'), 'a Zotero note shape is HTML')
check(!looksLikeHtml('## Markdown heading\n\n- a bullet'), 'Markdown is refused - the library stores HTML')
same(firstBlockText('<p>文章第2节标题是 “X”。</p><p>下一段</p>'), '文章第2节标题是 “X”。', 'the first block is what a reader sees first')
check(isApplicationWrapped('<div data-schema-version="9"><p>x</p></div>'), 'the application wrapper is recognised')
check(!isApplicationWrapped('<p>x</p>'), 'a note written through the API alone is not wrapped - negative control')

console.log('\n[6] the machine plan a round joins records on')
const planNote = (key, { section = '', retired: isRet = false, digest = false, imported = false, ambiguous = false, invalid = [], tags = [], html = '<p>x</p>' } = {}) => ({
  key,
  html,
  tags,
  retired: isRet,
  imported,
  digest,
  claim: { token: section, ambiguous, tags, invalid },
})
const plan = planJson({
  record: { key: 'REC1', itemType: 'journalArticle', title: 'A paper' },
  attachment: { key: 'PDF1', data: { contentType: 'application/pdf' } },
  notes: [
    planNote('LIVE2', { section: '2', tags: ['/section-2'] }),
    planNote('LIVE3', { section: '3', imported: true, tags: ['/section-3', '/imported'] }),
    planNote('NEW4', { section: '4', tags: ['/section-4', '/replaces-OLD4'] }),
    planNote('OLD4', { section: '4', retired: true, tags: ['/section-4', '/retired'] }),
    planNote('DIG', { digest: true, tags: ['/digest'] }),
    planNote('SUM', { tags: [] }),
    planNote('AMB', { ambiguous: true, tags: ['/section-2', '/section-3'] }),
    planNote('DOT', { invalid: ['/section-3.1'], tags: ['/section-3.1'] }),
    planNote('AG1', { section: '5', tags: ['/section-5', '/agent-note'] }),
    planNote('RV1', { section: '6', tags: ['/section-6', '/agent-note', '/reviewed'] }),
  ],
})
same(plan.record.key, 'REC1', 'the record is named')
same(plan.file.contentType, 'application/pdf', 'and the file a reading would use')
same(plan.counts.notes, 10, 'every child note is counted')
same(plan.counts.live, 5, 'the live claims are counted apart from the tombstones')
same(plan.counts.retired, 1, 'the retired note is a tombstone, not coverage')
same(plan.counts.legacy, 1, 'the legacy summary is counted apart')
same(plan.counts.unknown, 2, 'the unclaimed notes are named')
same(plan.counts.ambiguous, 1, 'and a note with two claims is counted apart')
same(plan.counts.agent, 2, 'agent-written bodies are counted apart')
same(plan.counts.reviewed, 1, 'and the reviewed ones among them')
same(plan.counts.drafts, 1, 'the unreviewed agent body is the draft count')
same(plan.coverage.drafts.map((entry) => entry.note).join(' '), 'AG1', 'the draft is named, not folded into a record count')
same(plan.notes.find((note) => note.key === 'AG1').authority, 'candidate', 'a draft carries candidate authority')
same(plan.notes.find((note) => note.key === 'RV1').authority, 'record', 'a reviewed agent body carries record authority')
same(plan.coverage.live.map((entry) => entry.section).sort().join(' '), '2 3 4 5 6', 'the live coverage is per top-level section')
same(plan.coverage.retired[0].successor, 'NEW4', 'the tombstone points at its successor')
same(plan.coverage.legacy[0].note, 'DIG', 'the legacy summary is reported apart')
same(plan.coverage.unknown.sort().join(' '), 'DOT SUM', 'unknown notes are listed, never guessed at')
same(plan.coverage.ambiguous.join(' '), 'AMB', 'ambiguous notes are listed, never guessed at')
same(plan.notes.find((note) => note.key === 'LIVE3').imported, true, 'the imported claim is stated')
same(plan.notes.find((note) => note.key === 'DOT').invalidSectionTags.join(' '), '/section-3.1', 'an invalid tag is reported')
same(plan.notes.find((note) => note.key === 'LIVE2').moves.join(' '), 'repair(mechanical) retire', 'the machine plan states the moves, not only the class')
same(plan.notes.find((note) => note.key === 'DIG').moves.join(' '), 'leave', 'a legacy summary permits no write')

console.log('\n[6b] the moves a record permits, derived once')
same(allowedMoves({ tags: [], token: '' }).join(' '), 'claim retire', 'a note claiming no section may be claimed or retired')
same(allowedMoves({ tags: ['/section-2', '/imported'], token: '2' }).join(' '), 'rewrite retire', 'an import is rewritten in place, never repaired')
same(
  allowedMoves({ tags: ['/section-2', '/agent-note'], token: '2' }).join(' '),
  'rewrite retire review(owner)',
  'an unreviewed draft is rewritable, and the review is the owner\'s',
)
same(
  allowedMoves({ tags: ['/section-2', '/agent-note', '/reviewed'], token: '2' }).join(' '),
  'repair(mechanical|substantive) retire',
  'a reviewed agent body is a record: repaired, never rewritten',
)
same(allowedMoves({ tags: ['/section-2'], token: '2' }).join(' '), 'repair(mechanical) retire', 'the owner\'s own record is repaired mechanically only')
same(allowedMoves({ tags: ['/section-2', '/retired'], token: '2', retired: true }).join(' '), 'unretire delete', 'a tombstone may be restored or deleted')
same(allowedMoves({ tags: ['/digest'], digest: true }).join(' '), 'leave', 'a legacy whole-paper summary is left alone')
same(allowedMoves({ tags: ['/section-2', '/section-3'], ambiguous: true }).join(' '), 'unclaim', 'an ambiguous note may only lose one tag')

console.log('\n[7] the tool still says what it is doing')
const source = readFileSync(fileURLToPath(new URL('../zotero-section-note.mjs', import.meta.url)), 'utf8')
check(source.includes('REFUSED: §'), 'the refusal names the section it refuses')
check(!source.includes('SECTION_MARKER_PREFIX'), 'no invisible marker constant remains')
check(!source.includes('CLAIM_FORMS'), 'no prose claim regex remains')
check(!source.includes('sectionClaim'), 'no prose claim reader remains')
check(!source.includes('normalizeMath'), 'no mechanical math repair remains')
check(!source.includes('options.tidy'), 'no --tidy mode remains')
check(source.includes("gate.write('DELETE'"), 'the DELETE goes through the write gate')
check(source.includes('Only a retired note may be deleted'), 'and the retired check gates it')
check(!source.includes('performs no deletion'), 'the old "performs no deletion" sentence is gone')
check(!source.includes('.section-notes'), 'rewriting no longer writes a workspace backup')
check(source.includes('the body is NOT touched'), 'and the plan says in so many words that the body is left alone')

console.log('\n[8] the command line refuses usage errors before it reads a library')
const tool = fileURLToPath(new URL('../zotero-section-note.mjs', import.meta.url))
const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' })
same(run('--claim').status, 2, '--claim without --note is a usage error')
same(run('--unclaim').status, 2, '--unclaim without --note is a usage error')
same(run('--unclaim', '--note', 'X').status, 2, '--unclaim names the tag it removes with --section')
same(run('--unclaim', '--note', 'X', '--section', '2', '--reason', 'why').status, 2, '--unclaim does not take --reason')
same(run('--delete').status, 2, '--delete without --note is a usage error')
same(run('--delete', '--note', 'X', '--reason', 'why').status, 2, '--delete does not take --reason')
same(run('--tidy', '--note', 'X').status, 2, '--tidy is gone')
same(run('--title', 'X').status, 2, '--title is gone: a note has no title field')
same(run('--acknowledge-unknown', 'x').status, 2, '--acknowledge-unknown belongs to a --section create')

console.log('\n[9] the command line against a stub library, not the owner\'s')
const stubItems = {
  REC1: { key: 'REC1', itemType: 'journalArticle', title: 'A paper', version: 1 },
  REC2: { key: 'REC2', itemType: 'journalArticle', title: 'An empty record', version: 1 },
  REC3: { key: 'REC3', itemType: 'journalArticle', title: 'A record whose note is ambiguous', version: 1 },
  REC4: { key: 'REC4', itemType: 'journalArticle', title: 'A record whose tag removal never reads back', version: 1 },
  AMB2: {
    key: 'AMB2',
    itemType: 'note',
    note: '<p>§2 and §5</p>',
    tags: [{ tag: '/section-2' }, { tag: '/section-5' }],
    version: 9,
    parentItem: 'REC4',
  },
  AMB1: {
    key: 'AMB1',
    itemType: 'note',
    note: '<p>§2 and §3</p>',
    tags: [{ tag: '/section-2' }, { tag: '/section-3' }],
    version: 8,
    parentItem: 'REC3',
  },
  RET1: {
    key: 'RET1',
    itemType: 'note',
    note: '<p>retired</p>',
    tags: [{ tag: '/section-8' }, { tag: '/retired' }],
    version: 11,
    parentItem: 'REC4',
  },
  UNCONF1: { key: 'UNCONF1', itemType: 'note', note: '<p>nine</p>', tags: [{ tag: '/section-9' }], version: 12, parentItem: 'REC4' },
  LIVE2: { key: 'LIVE2', itemType: 'note', note: '<p>第2节</p>', tags: [{ tag: '/section-2' }], version: 2, parentItem: 'REC1' },
  UNK: { key: 'UNK', itemType: 'note', note: '<p>一段话总结</p>', tags: [], version: 3, parentItem: 'REC1' },
  DIG: { key: 'DIG', itemType: 'note', note: '<p>digest</p>', tags: [{ tag: '/digest' }], version: 4, parentItem: 'REC1' },
  OLD: { key: 'OLD', itemType: 'note', note: '<p>old</p>', tags: [{ tag: '/section-3' }, { tag: '/retired' }], version: 5, parentItem: 'REC1' },
  AGU: { key: 'AGU', itemType: 'note', note: '<p>agent draft</p>', tags: [{ tag: '/agent-note' }], version: 6, parentItem: 'REC1' },
  RV6: {
    key: 'RV6',
    itemType: 'note',
    note: '<p>reviewed</p>',
    tags: [{ tag: '/section-6' }, { tag: '/agent-note' }, { tag: '/reviewed' }],
    version: 7,
    parentItem: 'REC1',
  },
}
const childKeys = { REC1: ['LIVE2', 'UNK', 'DIG', 'OLD', 'AGU', 'RV6'], REC2: [], REC3: ['AMB1'], REC4: ['AMB2', 'RET1', 'UNCONF1'] }
const requests = []
const deleted = new Set()
const scratch = mkdtempSync(join(tmpdir(), 'section-note-'))
const grantPath = join(scratch, 'grant.json')
let created = 0
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  requests.push(`${req.method} ${url.pathname}`)
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = (done) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => done(body))
  }
  if (url.pathname === '/api/') {
    res.writeHead(200, { 'content-type': 'application/json', 'zotero-server-id': 'stub-server', 'x-zotero-version': 'stub' })
    res.end('{}')
    return
  }
  if (url.pathname === '/api/local/authorize' && req.method === 'POST') {
    send(200, { key: 'stub-key', remember: true })
    return
  }
  if (url.pathname === '/api/users/0/items' && req.method === 'POST') {
    readBody((body) => {
      const [payload] = JSON.parse(body)
      const key = `NEW${++created}`
      const mangled = String(payload.note).includes('MANGLE')
      stubItems[key] = {
        key,
        itemType: 'note',
        note: mangled ? '<p>the application rewrote this body</p>' : payload.note,
        tags: payload.tags,
        version: 10 + created,
        parentItem: payload.parentItem,
      }
      childKeys[payload.parentItem] = [...(childKeys[payload.parentItem] ?? []), key]
      send(200, { successful: { 0: key } })
    })
    return
  }
  const children = /^\/api\/users\/0\/items\/([A-Z0-9]+)\/children$/.exec(url.pathname)
  if (children && childKeys[children[1]]) {
    send(200, childKeys[children[1]].map((key) => ({ key, data: stubItems[key] })))
    return
  }
  const match = /^\/api\/users\/0\/items\/([A-Z0-9]+)$/.exec(url.pathname)
  if (match && stubItems[match[1]]) {
    const key = match[1]
    if (deleted.has(key)) {
      send(404, { error: 'not found' })
      return
    }
    if (req.method === 'DELETE') {
      if (req.headers['if-unmodified-since-version'] !== String(stubItems[key].version)) {
        send(428, { error: 'precondition required' })
        return
      }
      deleted.add(key)
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method === 'PATCH') {
      readBody((body) => {
        if (key === 'AMB2' || key === 'UNCONF1') {
          // Accepted and never applied: the class a write tool must report as 3, never as "nothing
          // was written". This is the only stub behaviour that is wrong on purpose.
          res.writeHead(204)
          res.end()
          return
        }
        if (req.headers['if-unmodified-since-version'] !== String(stubItems[key].version)) {
          send(412, { error: 'precondition failed' })
          return
        }
        stubItems[key] = { ...stubItems[key], ...JSON.parse(body), version: stubItems[key].version + 1 }
        res.writeHead(204)
        res.end()
      })
      return
    }
    send(200, { data: stubItems[key] })
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

const planRun = await runAsync(['--item', 'REC1', '--json'])
same(planRun.status, 0, 'the plan exits 0')
const machine = JSON.parse(planRun.stdout)
same(machine.counts.live, 2, 'the plan sees the tagged claims')
same(machine.counts.unknown, 2, 'and the untagged notes')
same(machine.counts.legacy, 1, 'and the legacy summary')
same(machine.counts.retired, 1, 'and the tombstone')
same(machine.counts.drafts, 1, 'and the agent draft')
same(machine.coverage.unknown.sort().join(' '), 'AGU UNK', 'the untagged notes are named, not guessed at')
same(machine.coverage.drafts[0].note, 'AGU', 'the draft is named apart from the records')
same(
  machine.notes.find((note) => note.key === 'AGU').moves.join(' '),
  'claim retire',
  'a draft that claims no section may be claimed or retired, and nothing else',
)
const prosePlan = await runAsync(['--item', 'REC1'])
same(prosePlan.status, 0, 'the prose plan exits 0')
check(prosePlan.stdout.includes('moves:'), 'the prose plan prints the moves beside the class')
check(prosePlan.stdout.includes('class: agent'), 'and the class word the discipline reads')

const bodyFile = join(scratch, 'new.html')
writeFileSync(bodyFile, '<p>new body</p>', 'utf8')
const createBody = join(scratch, 'created.html')
writeFileSync(createBody, '<p>第7节解释</p>', 'utf8')

// --- dry runs: nothing below may send anything but GET -------------------------------------------
const claimRun = await runAsync(['--claim', '--note', 'UNK', '--section', '4'])
same(claimRun.status, 0, 'claiming an untagged note is a dry run')
check(claimRun.stdout.includes('/section-4'), 'the plan shows the tag it would write')
check(claimRun.stdout.includes('/imported'), 'and the /imported mark that keeps it rewritable')

const agentClaimRun = await runAsync(['--claim', '--note', 'AGU', '--section', '5'])
same(agentClaimRun.status, 0, 'claiming an agent note is a dry run')
check(!agentClaimRun.stdout.includes('/imported'), 'an agent note is not relabelled an import')

const rewriteRun = await runAsync(['--rewrite', '--note', 'UNK', '--file', bodyFile])
same(rewriteRun.status, 0, 'rewriting an import is a dry run')
check(rewriteRun.stdout.includes('old     :'), 'the old first block is what it shows instead')
check(rewriteRun.stdout.includes('/agent-note'), 'and it says the rewrite stamps the agent mark')
const nativeRewrite = await runAsync(['--rewrite', '--note', 'LIVE2', '--file', bodyFile])
same(nativeRewrite.status, 2, 'a native record is not rewritten in place')
const reviewedRewrite = await runAsync(['--rewrite', '--note', 'RV6', '--file', bodyFile])
same(reviewedRewrite.status, 2, 'a reviewed agent body is a record: not rewritten in place')

const reviewLive = await runAsync(['--review', '--note', 'LIVE2'])
same(reviewLive.status, 2, 'only an agent body has a review state')
const reviewRun = await runAsync(['--review', '--note', 'AGU'])
same(reviewRun.status, 0, 'reviewing an agent body is a dry run')
check(reviewRun.stdout.includes('/reviewed'), 'the plan shows the tag it would write')
check(reviewRun.stdout.includes('the body is NOT touched'), 'and that the body is left alone')

const guarded = await runAsync(['--item', 'REC1', '--section', '7', '--file', createBody])
same(guarded.status, 1, 'a create on a record with unread notes is refused')
check(guarded.stderr.includes('carry no /section- tag'), 'and the refusal names the notes to read')

const deleteRun = await runAsync(['--delete', '--note', 'OLD'])
same(deleteRun.status, 0, 'a retired note has a deletion plan')
check(deleteRun.stdout.includes('DELETE /api/users/0/items/OLD'), 'the plan states the request')
check(deleteRun.stdout.includes('If-Unmodified-Since-Version: 5'), 'and the version precondition the API demands')
check(deleteRun.stdout.includes('permanent'), 'and that the channel cannot undo it')
const liveDelete = await runAsync(['--delete', '--note', 'LIVE2'])
same(liveDelete.status, 1, 'a live note is refused')

const ambiguousCreate = await runAsync(['--item', 'REC3', '--section', '3', '--file', createBody])
same(ambiguousCreate.status, 1, 'a create on a record whose note carries two tags is refused')
check(ambiguousCreate.stderr.includes('--unclaim'), 'and the refusal names the command that resolves it - not a dead end')

const unclaimRun = await runAsync(['--unclaim', '--note', 'AMB1', '--section', '3'])
same(unclaimRun.status, 0, 'removing one of two tags is a dry run')
check(unclaimRun.stdout.includes('ambiguous (/section-2 · /section-3)'), 'the plan names both tags and which one survives', unclaimRun.stdout)
check(unclaimRun.stdout.includes('the body is NOT touched'), 'and that the body is left alone')
const unclaimSingle = await runAsync(['--unclaim', '--note', 'LIVE2', '--section', '2'])
same(unclaimSingle.status, 1, 'a single claim is not unclaimed')
check(unclaimSingle.stderr.includes('protocol §6'), 'and the refusal says why: a disagreement is the owner\'s to settle', unclaimSingle.stderr)
const unclaimAbsent = await runAsync(['--unclaim', '--note', 'AMB1', '--section', '9'])
same(unclaimAbsent.status, 2, 'removing a tag the note does not carry is a usage error')
const unclaimRetired = await runAsync(['--unclaim', '--note', 'OLD', '--section', '3'])
same(unclaimRetired.status, 2, 'a tombstone is not edited: put its claim back first')

check(requests.every((line) => line.startsWith('GET ')), 'every dry run sent GET only: nothing was written', requests.join(' | '))

// --- writes --------------------------------------------------------------------------------------
const acked = await runAsync(['--item', 'REC1', '--section', '7', '--file', createBody, '--acknowledge-unknown', 'read UNK and AGU; neither explains §7'])
same(acked.status, 0, 'acknowledging the unread notes turns the refusal into a dry run')
check(acked.stdout.includes('/agent-note'), 'the create plan carries the agent mark')

const createWrite = await runAsync(['--item', 'REC1', '--section', '7', '--file', createBody, '--acknowledge-unknown', 'read UNK and AGU; neither explains §7', '--write'])
same(createWrite.status, 0, 'the acknowledged create writes')
const createdKey = /note (NEW\d+) carries/.exec(createWrite.stdout)?.[1] ?? ''
check(createdKey !== '', 'the created note is named by its key', createWrite.stdout)
check(stubItems[createdKey]?.tags.some((tag) => tag.tag === '/agent-note'), 'and it reads back carrying /agent-note')
check(stubItems[createdKey]?.tags.some((tag) => tag.tag === '/section-7'), 'with the section tag too')

const createAgain = await runAsync(['--item', 'REC1', '--section', '7', '--file', createBody, '--acknowledge-unknown', 'read UNK and AGU; neither explains §7', '--write'])
same(createAgain.status, 1, 'a second create for the same section is refused')

const claimWrite = await runAsync(['--claim', '--note', 'UNK', '--section', '4', '--write'])
same(claimWrite.status, 0, 'claiming an import writes')
same(stubItems.UNK.tags.map((tag) => tag.tag).sort().join(' '), '/imported /section-4', 'and leaves /section-4 and /imported')

const agentClaimWrite = await runAsync(['--claim', '--note', 'AGU', '--section', '5', '--write'])
same(agentClaimWrite.status, 0, 'claiming an agent note writes')
same(stubItems.AGU.tags.map((tag) => tag.tag).sort().join(' '), '/agent-note /section-5', 'without inventing /imported')

const reviewWrite = await runAsync(['--review', '--note', 'AGU', '--write'])
same(reviewWrite.status, 0, 'reviewing an agent body writes')
check(stubItems.AGU.tags.some((tag) => tag.tag === '/reviewed'), 'and the owner acceptance is on the note')
const reviewNoop = await runAsync(['--review', '--note', 'AGU'])
same(reviewNoop.status, 0, 'reviewing an already reviewed body is a no-op')
check(reviewNoop.stdout.includes('nothing to do'), 'and it says so rather than writing twice')

const rewriteWrite = await runAsync(['--rewrite', '--note', 'UNK', '--file', bodyFile, '--write'])
same(rewriteWrite.status, 0, 'rewriting an import writes')
check(stubItems.UNK.tags.some((tag) => tag.tag === '/agent-note'), 'and stamps the body as agent-written')
check(stubItems.UNK.tags.some((tag) => tag.tag === '/imported'), 'while the import mark survives')

const undoReview = await runAsync(['--review', '--note', 'AGU', '--undo', '--write'])
same(undoReview.status, 0, 'undoing a review writes')
check(!stubItems.AGU.tags.some((tag) => tag.tag === '/reviewed'), 'and puts the note back to a draft')

const emptyCreate = await runAsync(['--item', 'REC2', '--section', '2', '--file', createBody, '--write'])
same(emptyCreate.status, 0, 'a record with no notes needs no acknowledgement')
const emptyKey = /note (NEW\d+) carries/.exec(emptyCreate.stdout)?.[1] ?? ''
check(emptyKey !== '', 'the empty record also names its new note', emptyCreate.stdout)
check(stubItems[emptyKey]?.tags.some((tag) => tag.tag === '/agent-note'), 'and it is an agent note too')

const mangleBody = join(scratch, 'mangle.html')
writeFileSync(mangleBody, '<p>MANGLE</p>', 'utf8')
const mangled = await runAsync(['--item', 'REC2', '--section', '3', '--file', mangleBody, '--write'])
same(mangled.status, 3, 'a write that does not read back is exit 3, not "nothing was written"')
check(mangled.stderr.includes('WRITTEN BUT UNCONFIRMED'), 'and it says the note exists', mangled.stderr)
check(/The note EXISTS: NEW\d+/.test(mangled.stderr), 'and names the key a caller must not duplicate')

const deleteWrite = await runAsync(['--delete', '--note', 'OLD', '--write'])
same(deleteWrite.status, 0, 'deleting a retired note with --write erases it')
check(deleteWrite.stdout.includes('is erased'), 'and says it answers 404')
check(requests.includes('DELETE /api/users/0/items/OLD'), 'the DELETE was sent')
check(deleted.has('OLD'), 'the stub library erased the note')
check(deleteWrite.stdout.includes('It answers 404, and the trash does not hold it'), 'and the read-back proved it')
const goneRun = await runAsync(['--delete', '--note', 'OLD'])
same(goneRun.status, 1, 'a deleted note can no longer be planned')

const unclaimWrite = await runAsync(['--unclaim', '--note', 'AMB1', '--section', '3', '--write'])
same(unclaimWrite.status, 0, 'removing the stale tag writes')
same(stubItems.AMB1.tags.map((tag) => tag.tag).sort().join(' '), '/section-2', 'and exactly one tag is gone')
check(unclaimWrite.stdout.includes('claims §2 again'), 'the plan says what the note claims again', unclaimWrite.stdout)
check(requests.includes('PATCH /api/users/0/items/AMB1'), 'the PATCH was sent')
const unclaimAgain = await runAsync(['--unclaim', '--note', 'AMB1', '--section', '2'])
same(unclaimAgain.status, 1, 'with one tag left it is a claim again: no second unclaim')

const createAfterUnclaim = await runAsync(['--item', 'REC3', '--section', '3', '--file', createBody, '--write'])
same(createAfterUnclaim.status, 0, 'the record is writable again once the ambiguity is gone')

const unclaimUnconfirmed = await runAsync(['--unclaim', '--note', 'AMB2', '--section', '5', '--write'])
same(unclaimUnconfirmed.status, 3, 'a tag removal that is accepted but does not read back is exit 3')
check(unclaimUnconfirmed.stderr.includes('WRITTEN BUT UNCONFIRMED'), 'and it never says nothing was written', unclaimUnconfirmed.stderr)
check(unclaimUnconfirmed.stderr.includes('still carries /section-5'), 'the mismatch names the tag that is still there', unclaimUnconfirmed.stderr)

console.log('\n[10] a repair corrects a record in place, and a substantive one drops the acceptance')
const typoBody = join(scratch, 'typo.html')
writeFileSync(typoBody, '<p>第2节的内容</p>', 'utf8')
const digitBody = join(scratch, 'digit.html')
writeFileSync(digitBody, '<p>第3节</p>', 'utf8')
const mathBody = join(scratch, 'math.html')
writeFileSync(mathBody, '<p>第2节 $x$</p>', 'utf8')
const reviewedTypo = join(scratch, 'reviewed-typo.html')
writeFileSync(reviewedTypo, '<p>reviewed body</p>', 'utf8')
const reviewedDigit = join(scratch, 'reviewed-digit.html')
writeFileSync(reviewedDigit, '<p>reviewed 2</p>', 'utf8')
const unconfirmedBody = join(scratch, 'unconfirmed.html')
writeFileSync(unconfirmedBody, '<p>nine!</p>', 'utf8')

same(run('--repair', '--note', 'LIVE2', '--file', typoBody).status, 2, '--repair without --reason is a usage error')
same(run('--repair', '--note', 'LIVE2', '--file', typoBody, '--reason', 'x').status, 2, '--repair needs --mechanical or --substantive')
same(
  run('--repair', '--note', 'LIVE2', '--file', typoBody, '--reason', 'x', '--mechanical', '--substantive').status,
  2,
  'and not both',
)
same(run('--mechanical').status, 2, '--mechanical belongs to --repair')
same(
  run('--repair', '--note', 'LIVE2', '--file', typoBody, '--reason', 'x', '--mechanical', '--section', '2').status,
  2,
  '--repair does not take --section: a changed claim is a retirement',
)

const repairPlan = await runAsync(['--repair', '--note', 'LIVE2', '--file', typoBody, '--reason', 'a typo', '--mechanical'])
same(repairPlan.status, 0, 'repairing an owner record mechanically is a dry run')
check(repairPlan.stdout.includes(REPAIRED_TAG), 'the plan shows the mark it would add')
check(repairPlan.stdout.includes('class   : mechanical'), 'and states the class it intends')
check(!repairPlan.stdout.includes('CLEARED'), 'and that the acceptance is not touched')

const digitMechanical = await runAsync(['--repair', '--note', 'LIVE2', '--file', digitBody, '--reason', 'x', '--mechanical'])
same(digitMechanical.status, 2, 'a changed digit refuses --mechanical')
check(digitMechanical.stderr.includes('digit'), 'and names the reason it refuses', digitMechanical.stderr)

const mathMechanical = await runAsync(['--repair', '--note', 'LIVE2', '--file', mathBody, '--reason', 'x', '--mechanical'])
same(mathMechanical.status, 2, 'a change inside math refuses --mechanical')
check(mathMechanical.stderr.includes('math segment'), 'and names math, not a digit', mathMechanical.stderr)

const ownerSubstantive = await runAsync(['--repair', '--note', 'LIVE2', '--file', digitBody, '--reason', 'x', '--substantive'])
same(ownerSubstantive.status, 2, "an owner's own record is not repaired substantively")
check(ownerSubstantive.stderr.includes("owner's own record"), 'and the refusal says why', ownerSubstantive.stderr)

const draftRepair = await runAsync(['--repair', '--note', 'AGU', '--file', typoBody, '--reason', 'x', '--mechanical'])
same(draftRepair.status, 2, 'a draft is rewritten, not repaired')
check(draftRepair.stderr.includes('agent draft'), 'and the refusal points at --rewrite', draftRepair.stderr)

const importRepair = await runAsync(['--repair', '--note', 'UNK', '--file', typoBody, '--reason', 'x', '--mechanical'])
same(importRepair.status, 2, 'an import is rewritten, not repaired')
check(importRepair.stderr.includes('is an import'), 'and the refusal points at --rewrite', importRepair.stderr)

const retiredRepair = await runAsync(['--repair', '--note', 'RET1', '--file', typoBody, '--reason', 'x', '--mechanical'])
same(retiredRepair.status, 2, 'a tombstone is never repaired')
const ambiguousRepair = await runAsync(['--repair', '--note', 'AMB2', '--file', typoBody, '--reason', 'x', '--mechanical'])
same(ambiguousRepair.status, 2, 'an ambiguous note is resolved before it is repaired')

const repairWrite = await runAsync(['--repair', '--note', 'LIVE2', '--file', typoBody, '--reason', 'a typo', '--mechanical', '--write'])
same(repairWrite.status, 0, 'a mechanical repair writes')
same(stubItems.LIVE2.tags.map((tag) => tag.tag).sort().join(' '), '/repaired /section-2', 'the key, the claim and the provenance stay')
check(String(stubItems.LIVE2.note).includes('的内容'), 'and the body is the corrected one')
check(repairWrite.stdout.includes('/repaired'), 'the write says what it carries now')

const repairNoop = await runAsync(['--repair', '--note', 'LIVE2', '--file', typoBody, '--reason', 'a typo', '--mechanical'])
same(repairNoop.status, 0, 'repairing to the same body again is a no-op')
check(repairNoop.stdout.includes('nothing to do'), 'and it says so rather than writing twice')

const reviewedRepair = await runAsync(['--repair', '--note', 'RV6', '--file', reviewedTypo, '--reason', 'a typo', '--mechanical', '--write'])
same(reviewedRepair.status, 0, 'a mechanical repair of a reviewed body writes')
check(stubItems.RV6.tags.some((tag) => tag.tag === REVIEWED_TAG), 'and keeps the owner acceptance')
check(stubItems.RV6.tags.some((tag) => tag.tag === REPAIRED_TAG), 'with the repair mark beside it')

const substantiveWrite = await runAsync([
  '--repair', '--note', 'RV6', '--file', reviewedDigit, '--reason', 'the number was transcribed wrong', '--substantive', '--write',
])
same(substantiveWrite.status, 0, 'a substantive repair writes')
check(!stubItems.RV6.tags.some((tag) => tag.tag === REVIEWED_TAG), 'and clears the owner acceptance')
check(stubItems.RV6.tags.some((tag) => tag.tag === REPAIRED_TAG), 'while the repair mark remains')
check(substantiveWrite.stdout.includes('is cleared'), 'the write says the body is a draft again')

const repairUnconfirmed = await runAsync(['--repair', '--note', 'UNCONF1', '--file', unconfirmedBody, '--reason', 'x', '--mechanical', '--write'])
same(repairUnconfirmed.status, 3, 'a repair that is accepted but does not read back is exit 3')
check(repairUnconfirmed.stderr.includes('UNCONFIRMED'), 'and it never says nothing was written', repairUnconfirmed.stderr)

server.close()

console.log(failures === 0 ? '\nPASS - identity is tags, authorship is a tag, a draft is not a record, a repair is not a replacement, and a failed write is not called "nothing written"' : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
