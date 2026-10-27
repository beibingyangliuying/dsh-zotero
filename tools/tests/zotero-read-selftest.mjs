// Unit self-test for the reference-library reader, runnable without a library running.
//
// Usage: node tools/tests/zotero-read-selftest.mjs
//
// The fixtures are the SHAPES the library actually answered on 2026-10-15 (Zotero 10.0.6), reduced to
// the fields under test. Keys, titles and texts are synthetic: the SHAPES are what these tests are
// about, and a real library's contents are not this repository's to publish. They are here because
// every one of them broke a reasonable-looking first design:
//
//   * a full-text search answers with a MIX of rows - attachments, notes with empty titles, and real
//     records - so the rows have to be collapsed onto the records they belong to;
//   * `?itemKey=a,b` answers with the two records AND their children, so a multi-get must be filtered
//     back to what was asked for;
//   * `collections` is a bare string when there is one, and `tags` is `[{tag}]`;
//   * `date` is free text ("09/2019"), so a year is found in it, never sliced out of it.
import {
  buildCollectionTree,
  chunkText,
  citationFields,
  citationLines,
  classifyHit,
  coverageOf,
  extraLines,
  findPassages,
  groupHits,
  itemForJson,
  noteHeadings,
  parseArgs,
  pickAttachment,
  rankPassages,
  readItemOrRefuse,
  sameDoi,
  screenRows,
  selectRequested,
  shortCreators,
  sliceText,
  tokenize,
  yearOf,
} from '../zotero-read.mjs'
import {
  PERSONAL_LIBRARY,
  itemRef,
  libraryPrefix,
  normalizeCollections,
  normalizeTags,
  parseLibrary,
  visibleText,
} from '../zotero-local-api.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  -> ${detail}` : ''}`)
  if (!condition) failures += 1
}
const throws = (label, run) => {
  try {
    run()
    check(false, label, 'nothing was thrown')
  } catch {
    check(true, label)
  }
}

console.log('reference-library reader self-test')

// --- fixtures: the shapes the library answered ---------------------------------------------------
//
// The SHAPES are what a real library answered. The keys are Zotero's own documented examples
// (`ABCD2345` and friends), because a key is an identifier: a fixture that carries one out of a private
// library publishes it, and a shipped artifact must not name the owner's shelf.

/** Six rows from one `qmode=everything` search: three attachment rows, two notes, one record. */
const SEARCH_ROWS = [
  { key: 'BCDE3456', data: { itemType: 'attachment', contentType: 'application/pdf', parentItem: 'ABCD2345', title: 'Example study alpha' } },
  { key: 'CDEF4567', data: { itemType: 'attachment', contentType: 'application/pdf', parentItem: 'FGHI6789', title: 'Example study beta' } },
  { key: 'DEFG5678', data: { itemType: 'attachment', contentType: 'application/pdf', parentItem: 'HIJK7890', title: 'Example study gamma' } },
  { key: 'JKLM8901', data: { itemType: 'conferencePaper', title: 'Example study delta', date: '2017-06-01' } },
  { key: 'KLMN9012', data: { itemType: 'note', parentItem: 'JKLM8901', title: '' } },
  { key: 'LMNO0123', data: { itemType: 'note', parentItem: 'JKLM8901', title: '' } },
]

/** The children fixture: a note, a linked PDF, and an imported HTML snapshot. */
const CHILDREN = [
  { key: 'MNOP1234', data: { itemType: 'note', title: '' } },
  { key: 'NOPQ2345', data: { itemType: 'attachment', contentType: 'application/pdf', linkMode: 'linked_file', title: 'Full Text PDF' } },
  { key: 'OPQR3456', data: { itemType: 'attachment', contentType: 'text/html', linkMode: 'imported_url', title: 'Snapshot' } },
]

/** The measured shape of a `?itemKey=` answer: the two records AND their children. */
const MULTI_GET_ROWS = [
  { key: 'BCDE3456', data: { itemType: 'attachment', parentItem: 'ABCD2345' } },
  { key: 'CDEF4567', data: { itemType: 'attachment', parentItem: 'FGHI6789' } },
  { key: 'PQRS4567', data: { itemType: 'note', parentItem: 'FGHI6789' } },
  { key: 'FGHI6789', data: { itemType: 'preprint', title: 'Example study beta' } },
  { key: 'QRST5678', data: { itemType: 'note', parentItem: 'ABCD2345' } },
  { key: 'ABCD2345', data: { itemType: 'journalArticle', title: 'Example study alpha' } },
]

/** Collection rows in the measured shape, plus one whose parent is missing (marked) to pin the orphan rule. */
const COLLECTIONS = [
  { key: 'COLROOT1', data: { name: 'Example root' }, meta: { numItems: 18 } },
  { key: 'COLCHLD2', data: { name: 'Example child', parentCollection: 'COLROOT1' }, meta: { numItems: 13 } },
  { key: 'COLCHLD3', data: { name: 'Example child two', parentCollection: 'COLROOT1' }, meta: { numItems: 9 } },
  { key: 'COLNOTE4', data: { name: 'Example root two' }, meta: { numItems: 0 } },
  { key: 'ORPHAN01', data: { name: 'child of a collection that is not in this page', parentCollection: 'GONE0000' }, meta: { numItems: 1 } },
]

const FULLTEXT = 'A sample text for the reader. Another sample line follows it. '

// --- what a row is ------------------------------------------------------------------------------

console.log('\n[1] a row is classified, and told which record it belongs to')

const attachment = classifyHit(SEARCH_ROWS[0])
check(attachment.kind === 'attachment' && attachment.parentKey === 'ABCD2345', 'an attachment row belongs to its parent', attachment.parentKey)
check(attachment.record === null, 'an attachment row carries no record of its own')
check(attachment.contentType === 'application/pdf', 'the attachment content type is kept')
const note = classifyHit(SEARCH_ROWS[4])
check(note.kind === 'note' && note.parentKey === 'JKLM8901', 'a note row belongs to its parent')
const record = classifyHit(SEARCH_ROWS[3])
check(record.kind === 'item' && record.parentKey === 'JKLM8901', 'a record row is its own parent')
check(record.record?.itemType === 'conferencePaper', 'a record row carries its own data')

// --- collapsing onto records --------------------------------------------------------------------

console.log('\n[2] rows collapse onto records, without losing what matched')

const groups = groupHits(SEARCH_ROWS)
check(groups.length === 4, 'six rows become four records', `${groups.length}`)
const notes = groups.find((group) => group.parentKey === 'JKLM8901')
check(notes.sources.length === 3, 'the record that matched by metadata AND by two notes keeps all three', `${notes.sources.length}`)
check(notes.record?.itemType === 'conferencePaper', 'and it is printed as the record, not as a blank note title')
check(
  groups.filter((group) => group.record === null).length === 3,
  'the three attachment-only records are reported without a record yet, to be fetched',
  `${groups.filter((group) => group.record === null).length}`,
)
check(groupHits([]).length === 0, 'no rows is no records')
check(
  groupHits([SEARCH_ROWS[0], SEARCH_ROWS[0]]).length === 1,
  'the same row twice is still one record',
)

// --- the year is found, never sliced ------------------------------------------------------------

console.log('\n[3] a year is found in a free-text date')

check(yearOf('2012') === '2012', 'a bare year')
check(yearOf('09/2019') === '2019', 'a month/year, which slicing four characters would mangle into "09/2"')
check(yearOf('2026-11-01') === '2026', 'an ISO date')
check(yearOf('n.d.') === '', 'no year at all is reported as absent')
check(yearOf('') === '' && yearOf(undefined) === '', 'an empty or missing date is absent, not a crash')
check(yearOf('Reprinted 1998, originally 1974') === '1998', 'the first year in a range-ish text wins')

// --- which attachment a reading uses ------------------------------------------------------------

console.log('\n[4] the attachment to read is chosen and named')

const picked = pickAttachment(CHILDREN)
check(picked?.key === 'NOPQ2345', 'the PDF wins over the HTML snapshot and the note', picked?.key)
check(picked?.linkMode === 'linked_file', 'the link mode is reported, so a reader knows which file it was')
check(pickAttachment([CHILDREN[0]]) === null, 'a record with only a note has nothing to read')
check(pickAttachment([]) === null, 'a record with no children has nothing to read')
check(
  pickAttachment([CHILDREN[0], CHILDREN[2]])?.contentType === 'text/html',
  'with no PDF the HTML snapshot is used rather than nothing',
)

// --- the two normalisations ---------------------------------------------------------------------

console.log('\n[5] the shapes that are sometimes one thing and sometimes many')

check(JSON.stringify(normalizeCollections('COLONLY1')) === '["COLONLY1"]', 'one collection arrives as a bare string')
check(normalizeCollections(['a', 'b']).length === 2, 'several arrive as an array')
check(normalizeCollections('').length === 0 && normalizeCollections(undefined).length === 0, 'none is none')
check(JSON.stringify(normalizeTags([{ tag: '/done' }])) === '["/done"]', 'tags are objects with a tag key')
check(normalizeTags(['/done']).length === 1, 'plain string tags still work')
check(normalizeTags([{ nope: 1 }, { tag: '' }]).length === 0, 'a tag with no name is dropped rather than printed blank')
check(normalizeTags(undefined).length === 0, 'missing tags are none')

// --- the multi-get trap -------------------------------------------------------------------------

console.log('\n[6] a multi-get is filtered back to what was asked for')

const selected = selectRequested(MULTI_GET_ROWS, ['ABCD2345', 'FGHI6789'])
check(selected.size === 2, 'two keys asked for, two records kept - not the six rows answered', `${selected.size}`)
check(selected.get('ABCD2345')?.itemType === 'journalArticle', 'and they are the records that were asked for')
check(!selected.has('BCDE3456'), "the children the library volunteered are not adopted as records")
check(selectRequested(MULTI_GET_ROWS, []).size === 0, 'asking for nothing keeps nothing')

// --- collections --------------------------------------------------------------------------------

console.log('\n[7] collections become a tree')

const tree = buildCollectionTree(COLLECTIONS)
check(tree.length === 3, 'three roots: two real ones and the orphan', `${tree.length}`)
check(tree[0].key === 'COLROOT1' && tree[0].children.length === 2, 'a root keeps its children', `${tree[0].children.length}`)
check(tree[0].count === 18, 'the item count is carried')
check(tree.some((node) => node.key === 'ORPHAN01'), 'a collection whose parent is missing becomes a root instead of vanishing')
check(buildCollectionTree([]).length === 0, 'no collections is an empty tree')

// --- slicing ------------------------------------------------------------------------------------

console.log('\n[8] a long text is read in slices with a working cursor')

const whole = sliceText('x'.repeat(1000), { offset: 0, limit: 400 })
check(whole.to === 400 && whole.total === 1000 && whole.nextOffset === 400, 'the first slice names where to continue', String(whole.nextOffset))
const tail = sliceText('x'.repeat(1000), { offset: 900, limit: 400 })
check(tail.text.length === 100 && tail.nextOffset === null, 'the last slice says it is the end')
check(sliceText('abc', { offset: 99, limit: 10 }).text === '', 'an offset past the end yields nothing rather than throwing')
check(sliceText('abc', { offset: 0, limit: 0 }).to === 0, 'a zero limit reads nothing')
check(sliceText('', {}).total === 0 && sliceText('', {}).nextOffset === null, 'an empty text is empty')

// --- passages -----------------------------------------------------------------------------------

console.log('\n[9] passages are found, with their offsets')

const passages = findPassages(FULLTEXT, 'sample text')
check(passages.length === 1, 'a term is found once', `${passages.length}`)
check(passages[0].index === FULLTEXT.toLowerCase().indexOf('sample text'), 'the offset is the real one')
// The window only means something on a text longer than it is, so that is what this measures.
const LONG = `${'a'.repeat(500)}sample text${'b'.repeat(500)}`
const windowed = findPassages(LONG, 'sample text', { window: 50 })
check(
  windowed[0].excerpt.length === 50 + 'sample text'.length + 50,
  'the excerpt is the window on both sides and no more',
  `${windowed[0].excerpt.length} characters`,
)
check(windowed[0].excerpt.startsWith('a') && windowed[0].excerpt.endsWith('b'), 'the window is centred on the hit')
check(findPassages(LONG, 'sample text').at(0).excerpt.length < LONG.length, 'the default window is still bounded')
check(findPassages(FULLTEXT, 'SAMPLE').length === 2, 'the search is case-insensitive')
check(findPassages(FULLTEXT, 'nothing here').length === 0, 'a term that does not occur yields no passage')
check(findPassages(FULLTEXT, '').length === 0, 'an empty term yields no passage rather than every position')
check(findPassages('a a a a a a a a a a', 'a', { max: 3 }).length === 3, 'the cap is honoured')
check(!findPassages('line\nbreak', 'line').at(0).excerpt.includes('\n'), 'whitespace in an excerpt is collapsed for printing')

// --- the command line ---------------------------------------------------------------------------

console.log('\n[10] the command line')

throws('no mode is refused', () => parseArgs([]))
throws('two modes at once are refused', () => parseArgs(['--search', 'x', '--item', 'y']))
throws('an unknown flag is refused', () => parseArgs(['--search', 'x', '--frobnicate']))
throws('an unknown qmode is refused rather than silently ignored', () => parseArgs(['--search', 'x', '--qmode', 'bogus']))
throws('--limit above the page size is refused for a search', () => parseArgs(['--search', 'x', '--limit', '101']))
throws('--limit below one is refused', () => parseArgs(['--search', 'x', '--limit', '0']))
throws('a negative offset is refused', () => parseArgs(['--fulltext', 'k', '--offset', '-1']))

const search = parseArgs(['--search', 'x', '--tag', 'a', '--tag', 'b', '--json'])
check(search.mode === 'search' && search.tags.length === 2 && search.json === true, 'a search takes repeated tags and --json')
check(search.limit === 10, 'a search defaults to ten rows', String(search.limit))
check(search.qmode === 'everything', 'the default mode is full text, because the other default hides paywalled text')
const read = parseArgs(['--fulltext', 'k', '--limit', '300'])
check(read.mode === 'fulltext' && read.limit === 300, 'a read takes a character count beyond the page size', String(read.limit))
check(parseArgs(['--fulltext', 'k']).limit === 12000, 'a read defaults to 12000 characters, inside the shell tool clip')
check(parseArgs(['--fulltext', 'k', '--grep', 'term']).grep === 'term', 'a read can look for one term')
check(parseArgs(['--item', 'k', '--headings']).headings === true, 'a note read can ask for its own headings')
throws('--headings with --grep is refused, because the two answer different questions', () =>
  parseArgs(['--item', 'k', '--headings', '--grep', 'x']),
)
throws('--headings outside --item is refused', () => parseArgs(['--fulltext', 'k', '--headings']))
check(parseArgs(['--collections']).mode === 'collections' && parseArgs(['--tags']).mode === 'tags', 'the argument-less modes parse')

// --- screening a whole collection ----------------------------------------------------------------

console.log('\n[11] a collection is screened as records with abstracts, not as rows')

/** Four collection rows: two records (one long abstract, one without), a note and an attachment. */
const COLLECTION_ROWS = [
  { key: 'ABCD2345', data: { itemType: 'journalArticle', title: 'Example study alpha', date: '2012', abstractNote: 'x'.repeat(120) } },
  { key: 'BCDE3456', data: { itemType: 'note', title: '' } },
  { key: 'CDEF4567', data: { itemType: 'journalArticle', title: 'Example study beta', date: '09/2019', abstractNote: '<p>Short &amp; sweet</p>' } },
  { key: 'DEFG5678', data: { itemType: 'attachment', contentType: 'application/pdf', title: 'Full Text PDF' } },
]
const screened = screenRows(COLLECTION_ROWS, { limit: 60 })
check(screened.records.length === 2, 'two records out of four rows', `${screened.records.length}`)
check(screened.skipped.note === 1 && screened.skipped.attachment === 1, 'the note and the attachment are counted, not printed')
check(screened.records[0].excerpt.length === 61, 'a long abstract is cut to the limit plus the ellipsis', `${screened.records[0].excerpt.length}`)
check(screened.records[0].excerpt.endsWith('…'), 'and the cut is marked rather than silent')
check(screened.records[1].excerpt === 'Short &amp; sweet', 'the abstract is read as text, not as html', screened.records[1].excerpt)
check(screened.withAbstract === 2, 'both records carry an abstract', `${screened.withAbstract}`)
check(screened.records[1].year === '2019', 'the year is found in a free-text date here too')
check(screened.budget === screened.records.reduce((sum, record) => sum + record.characters, 0), 'the budget is what will actually be printed')
const bare = screenRows([{ key: 'EFGH6789', data: { itemType: 'journalArticle', title: 'No abstract here' } }])
check(bare.records[0].excerpt === '' && bare.withAbstract === 0, 'a record with no abstract is kept with an empty excerpt, not dropped')
check(screenRows([]).records.length === 0 && screenRows([]).budget === 0, 'no rows is no records and no budget')

check(parseArgs(['--collection', 'k', '--screen']).screen === true, '--screen is a flag on --collection')
check(parseArgs(['--collection', 'k', '--screen']).screenLimit === 300, 'a screening pass defaults to 300 characters per abstract')
check(parseArgs(['--collection', 'k', '--screen', '--screen-limit', '500']).screenLimit === 500, '--screen-limit sets it')
check(parseArgs(['--collection', 'k']).screen === false, 'a plain collection listing is not a screening pass')
throws('--screen without --collection is refused', () => parseArgs(['--search', 'x', '--screen']))
throws('--screen with --limit is refused, because it would mean two things at once', () =>
  parseArgs(['--collection', 'k', '--screen', '--limit', '20']),
)
check(parseArgs(['--collection', 'k', '--all-rows']).allRows === true, 'a listing can ask for every member of the collection')
check(parseArgs(['--collection', 'k']).allRows === false, 'and lists records unless asked otherwise')
throws('--all-rows outside --collection is refused', () => parseArgs(['--search', 'x', '--all-rows']))
throws('--all-rows with --screen is refused, because a screening pass already separates them', () =>
  parseArgs(['--collection', 'k', '--screen', '--all-rows']),
)

// --- what a 404 from the library means ------------------------------------------------------------

console.log('\n[10] a key that is not in this library')

// The transport cannot say this: a 404 also means "no such collection" to a write. The reader is the
// one place where it means "the key you were given is not here", so the reader owns the sentence - and
// it offers no command, because the search terms belong to whoever holds the key.
const thrower = (status) => async () => {
  const error = new Error(`/api/users/0/items/X answered ${status}`)
  error.status = status
  throw error
}

const missing = await readItemOrRefuse('NOTAKEY1', thrower(404)).then(
  () => null,
  (error) => error,
)
check(missing?.name === 'Refusal', 'a 404 becomes a refusal, not a bare status line')
check(missing?.message.includes('NOTAKEY1') && !missing?.message.includes('/api/'), 'the key is named, and the API path is not shown to a reader')
check(missing?.fix.includes('search the record by its title'), 'and the next action is to find the record and read its key')
check(missing?.command === '', 'no command is offered: a `try` line with a placeholder in it gets pasted and fails')

const other = await readItemOrRefuse('X', thrower(500)).then(
  () => null,
  (error) => error,
)
check(other?.name !== 'Refusal' && other?.status === 500, 'a non-404 passes through untouched - negative control')

const found = await readItemOrRefuse('REALKEY1', async () => ({ key: 'REALKEY1' }))
check(found.key === 'REALKEY1', 'and a record that exists is returned as it came')

// --- the citation block, the refs and the coverage ------------------------------------------------

console.log('\n[12] a record carries the fields a citation needs, under refs that name their library')

const ARTICLE = {
  itemType: 'journalArticle',
  publicationTitle: 'Journal of Examples',
  volume: '12',
  issue: '3',
  pages: '45-67',
  DOI: '10.1000/example',
}
const articleFields = citationFields(ARTICLE)
check(articleFields.venue === 'Journal of Examples', 'venue comes from publicationTitle')
check(articleFields.volume === '12' && articleFields.pages === '45-67', 'volume and pages are kept')
const articleLines = citationLines(ARTICLE)
check(articleLines.includes('venue      : Journal of Examples'), 'the venue prints in the label column', articleLines.join(' | '))
check(articleLines.includes('volume     : volume 12 · issue 3'), 'volume and issue share one line')
check(articleLines.includes('pages      : 45-67'), 'pages print on their own line')
const PREPRINT = citationLines({ itemType: 'preprint', repository: 'arXiv', archiveID: 'arXiv:1706.03762' })
check(PREPRINT.includes('repository : arXiv') && PREPRINT.includes('archiveID  : arXiv:1706.03762'), 'a preprint names its repository and archive id')
check(citationLines({ itemType: 'note' }).length === 0, 'a record with no citation fields prints no empty lines')
check(!('abstractNote' in citationFields({ abstractNote: 'x' })), 'the abstract is not a citation field (it is metadata, per §66)')

// The owner's own annotation lives in `extra`. It used to be reachable only through --json, which
// answers with the whole record including every child note's HTML; the discipline that drafts his
// remark phrases cannot pay that for a field of a few dozen characters.
const REMARK = 'remark: （一般）甲；乙\nrate: 3\ntitleTranslation: 某标题'
const extraBlock = extraLines(REMARK)
check(extraBlock[0] === 'extra      : remark: （一般）甲；乙', 'the first line of extra prints in the label column', extraBlock[0])
check(extraBlock[1] === '             rate: 3', 'the rest are indented under it, one per line', JSON.stringify(extraBlock[1]))
check(extraBlock.length === 3, 'and every line is printed', `${extraBlock.length} line(s)`)
check(extraLines('').length === 0, 'a blank field prints nothing at all')
check(extraLines('   \n  ').length === 0, 'and neither does one holding only whitespace')
const longExtra = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
const bounded = extraLines(longExtra)
check(bounded.length === 13, 'a field past the bound prints the bound plus one marker line', `${bounded.length} line(s)`)
check(bounded.at(-1).includes('8 more line(s)'), 'and the marker says how many lines are elsewhere', bounded.at(-1))
check(bounded.at(-1).includes('--json'), 'and names the read that keeps the whole field')


check(libraryPrefix(PERSONAL_LIBRARY) === '/api/users/0', 'the personal library is the default prefix')
check(libraryPrefix({ type: 'group', id: 42 }) === '/api/groups/42', 'a group has its own prefix')
check(itemRef('ABCD2345') === 'zotero://user/0/item/ABCD2345', 'an item ref names its library')
check(itemRef('ABCD2345', { type: 'group', id: 42 }) === 'zotero://group/42/item/ABCD2345', 'and a group ref keeps the group id')
check(parseLibrary('group:42').id === 42, 'group:42 parses')
check(parseLibrary('user:0').id === 0 && parseLibrary('').id === 0, 'user:0 and the empty value both mean the personal library')
throws('a user id other than 0 is refused', () => parseLibrary('user:5'))
throws('a malformed library is refused', () => parseLibrary('shelf:1'))
throws('a group id of zero is refused', () => parseLibrary('group:0'))
throws('libraryPrefix refuses an unsupported library', () => libraryPrefix({ type: 'group', id: 0 }))

check(coverageOf({ indexedPages: 17, totalPages: 17 }).complete, 'matching page counts are complete')
check(!coverageOf({ indexedPages: 10, totalPages: 17 }).complete, 'a short page count is incomplete')
check(coverageOf({ indexedChars: 500, totalChars: 500 }).complete, 'a text file is judged on characters')
check(!coverageOf({}).complete, 'no reported axis is incomplete, not complete')
check(!coverageOf({ indexedPages: 3, totalPages: 3, indexedChars: 5, totalChars: 6 }).complete, 'one disagreeing axis makes the whole answer incomplete')

check(shortCreators([{ lastName: 'Alpha' }]) === 'Alpha', 'one author is one name')
check(shortCreators([{ lastName: 'Alpha' }, { lastName: 'Beta' }]) === 'Alpha & Beta', 'two authors are joined')
check(shortCreators([{ lastName: 'Alpha' }, { lastName: 'Beta' }, { lastName: 'Gamma' }]) === 'Alpha et al.', 'three or more are abbreviated')
check(shortCreators([]) === '', 'no creators prints no author line')

check(visibleText('<div data-schema-version="9"><p>Hello</p></div>') === 'Hello', 'a note body is read as text, not as its wrapper')

// --- the search flags ----------------------------------------------------------------------------

console.log('\n[13] search takes the facets the library documents')

const sorted = parseArgs(['--search', 'x', '--sort', 'dateAdded', '--direction', 'desc'])
check(sorted.sort === 'dateAdded' && sorted.direction === 'desc', 'sort and direction parse')
check(parseArgs(['--search', 'x', '--item-type', 'journalArticle']).itemType === 'journalArticle', 'an item type filter parses')
check(parseArgs(['--search', 'x', '--trash']).trash === true, '--trash includes trashed rows')
check(parseArgs(['--item', 'k', '--library', 'group:42']).library.id === 42, 'any mode can name a group')
throws('an unknown sort field is refused', () => parseArgs(['--search', 'x', '--sort', 'bogus']))
throws('an unknown direction is refused', () => parseArgs(['--search', 'x', '--direction', 'up']))
throws('a facet outside --search is refused', () => parseArgs(['--item', 'k', '--sort', 'date']))
throws('a user library other than 0 is refused on the command line', () => parseArgs(['--search', 'x', '--library', 'user:5']))

// --- evidence retrieval --------------------------------------------------------------------------

console.log('\n[14] a question is ranked against the abstract, the notes and the full text')

check(tokenize('Retrieval-augmented, GENERATION!').join(' ') === 'retrieval augmented generation', 'terms are lowercased and punctuation dropped')
check(tokenize('证据分级').length > 0, 'a Chinese phrase yields terms rather than one unsegmentable blob')

const chunks = chunkText('x'.repeat(2500), { size: 1000, overlap: 100 })
check(chunks.length === 3, 'a long text is chunked', `${chunks.length}`)
check(chunks[0].from === 0 && chunks[0].to === 1000, 'the first chunk starts at zero')
check(chunks[1].from === 900, 'the next chunk overlaps by the overlap', `${chunks[1].from}`)
check(chunks.at(-1).to === 2500, 'the last chunk reaches the end')
check(chunkText('short').length === 1, 'a short text is one chunk')
check(chunkText('').length === 0, 'no text is no chunk')
const WORDY = 'alpha beta gamma delta epsilon zeta '.repeat(40)
const wordChunks = chunkText(WORDY, { size: 60, overlap: 15 })
check(wordChunks.every((chunk) => WORDY.slice(chunk.from, chunk.to) === chunk.text), 'every chunk offset still names its own text')
check(!/^\s/.test(wordChunks[1].text), 'the next chunk starts on a word boundary, not mid-word', JSON.stringify(wordChunks[1].text.slice(0, 12)))

const DOCUMENTS = [
  { id: 'a', text: 'Retrieval augmented generation improves factuality.', order: 0 },
  { id: 'b', text: 'Protein folding with transformers.', order: 1 },
  { id: 'c', text: 'Retrieval practice and memory.', order: 2 },
]
const ranked = rankPassages(DOCUMENTS, 'retrieval augmented generation', { limit: 5 })
check(ranked.length === 2, 'only documents with a query term are returned', `${ranked.length}`)
check(ranked[0].id === 'a', 'the passage carrying every term ranks first')
check(ranked[1].id === 'c', 'a partial match still ranks below the full one')
check(ranked[0].score > ranked[1].score, 'scores are ordered')
check(rankPassages(DOCUMENTS, 'none of these words', { limit: 5 }).length === 0, 'no match is an empty list, not a weakest guess')
check(rankPassages(DOCUMENTS, 'retrieval', { limit: 1 }).length === 1, 'the passage cap is honoured')
check(rankPassages([], 'retrieval').length === 0, 'no documents is no passages')

const retrieval = parseArgs(['--retrieve', 'k', '--query', 'retrieval', '--passages', '2', '--sources', 'abstract,notes'])
check(retrieval.mode === 'retrieve' && retrieval.query === 'retrieval', 'a retrieval parses its question')
check(retrieval.passages === 2, 'the passage count parses')
check(retrieval.sources.join(',') === 'abstract,notes', 'the source list parses')
check(parseArgs(['--retrieve', 'k', '--query', 'x']).sources.join(',') === 'abstract,notes,fulltext', 'all three sources are the default')
throws('a retrieval without a query is refused', () => parseArgs(['--retrieve', 'k']))
throws('a query outside --retrieve is refused', () => parseArgs(['--item', 'k', '--query', 'x']))
throws('an unknown source is refused', () => parseArgs(['--retrieve', 'k', '--query', 'x', '--sources', 'annotations']))
throws('zero passages is refused', () => parseArgs(['--retrieve', 'k', '--query', 'x', '--passages', '0']))

// --- structure, changes and the library marker ----------------------------------------------------

console.log('\n[15] structure, changes and "is it already in my library?"')

check(sameDoi('https://doi.org/10.1038/X') === '10.1038/x', 'a resolver URL and case are normalized')
check(sameDoi('doi: 10.1038/x') === '10.1038/x', 'a doi: prefix is stripped')
check(sameDoi('10.1038/x') === sameDoi('10.1038/X'), 'two spellings of one DOI compare equal')
check(sameDoi('') === '', 'no DOI is empty, not a match for everything')

const changes = parseArgs(['--changes', '--since', '42'])
check(changes.mode === 'changes' && changes.since === 42, 'a changes diff parses its cursor')
check(parseArgs(['--changes']).since === null, 'a baseline has no cursor')
throws('a negative cursor is refused', () => parseArgs(['--changes', '--since', '-1']))
throws('a cursor outside --changes is refused', () => parseArgs(['--item', 'k', '--since', '1']))
check(parseArgs(['--item-types']).mode === 'item-types', '--item-types is a mode')
check(parseArgs(['--item-fields', 'dataset']).value === 'dataset', '--item-fields takes the type')
throws('--item-fields needs a type', () => parseArgs(['--item-fields']))
check(parseArgs(['--saved-searches']).mode === 'saved-searches', '--saved-searches is a mode')
check(parseArgs(['--find-doi', '10.1038/x']).value === '10.1038/x', '--find-doi takes the DOI')

// --- a note's own headings ----------------------------------------------------------------------

console.log('\n[16] a long note is entered by its headings instead of read whole')

// The shape a section note actually has: `h2`/`h3` over `<p>` prose, wrapped by the application.
const NOTE_HTML =
  '<div data-schema-version="9"><h2>First part</h2><p>Alpha body.</p><h3>1. Detail</h3>' +
  '<p>Beta body.</p><h2>Second part</h2><p>Gamma body.</p></div>'

const outline = noteHeadings(NOTE_HTML)
check(outline.kind === 'heading', 'heading blocks are preferred over paragraphs', outline.kind)
check(outline.total === 3, 'every heading is listed', String(outline.total))
check(outline.text === visibleText(NOTE_HTML), 'the offsets are characters of the text the reader sees')
check(outline.headings[0].offset === 0, 'the first heading starts at zero')
// The offsets are only useful if each one really lands on its title; this checks every entry against
// the visible text rather than against the parser's own bookkeeping.
check(
  outline.headings.every((heading) => outline.text.slice(heading.offset, heading.offset + heading.text.length) === heading.text),
  'each offset lands on its own heading text',
)
check(
  outline.headings[1].offset === outline.text.indexOf('1. Detail'),
  'a nested heading is found where it really is',
  String(outline.headings[1].offset),
)
// `+length` is what a reader passes as --limit, so it must reach the next section and stop there.
check(outline.headings[0].length === outline.headings[2].offset, 'a top-level section runs to the next top-level heading', String(outline.headings[0].length))
check(
  outline.headings[1].length === outline.headings[2].offset - outline.headings[1].offset,
  'a nested section runs to the next heading that ends it',
  String(outline.headings[1].length),
)
check(outline.headings[2].length === outline.text.length - outline.headings[2].offset, 'the last section runs to the end of the text')

const paragraphs = noteHeadings('<div><p>Alpha body.</p><p>Beta body.</p></div>')
check(paragraphs.kind === 'paragraph', 'a note with no headings falls back to its paragraphs', paragraphs.kind)
check(paragraphs.total === 2 && paragraphs.headings[0].offset === 0, 'and lists them from the start', String(paragraphs.total))
check(paragraphs.headings[0].length === paragraphs.headings[1].offset, 'one paragraph runs to the next')
check(noteHeadings('').total === 0, 'an empty note has no sections')
check(noteHeadings(undefined).total === 0, 'and a missing body does not throw')
check(noteHeadings(NOTE_HTML, { maxHeadings: 1 }).headings.length === 1, 'the listing can be capped without losing the total')
check(noteHeadings(NOTE_HTML, { maxHeadings: 1 }).total === 3, 'a capped listing still says how many there are')
check(noteHeadings('<div><p>only   spaced   text</p></div>').headings[0].text === 'only spaced text', 'whitespace is collapsed as visibleText collapses it')

// --- what --json says about a child ---------------------------------------------------------------

console.log('\n[17] a child note is listed by key and version, not by its stored body')

const noteChild = { key: 'NOTE0001', version: 41, itemType: 'note', title: '', note: '<p>a body</p>' }
const slimmed = itemForJson(noteChild)
check(slimmed.note === undefined, 'the stored HTML is left out')
check(slimmed.noteCharacters === 13, 'its length is reported instead', String(slimmed.noteCharacters))
check(slimmed.key === 'NOTE0001' && slimmed.version === 41, 'the fields a write needs survive')
check(noteChild.note === '<p>a body</p>', 'the input is not mutated')
const pdfChild = { key: 'ATT00001', version: 9, itemType: 'attachment', contentType: 'application/pdf' }
check(itemForJson(pdfChild).noteCharacters === undefined, 'a child with no body gains no length')
check(JSON.stringify(itemForJson({})) === '{}', 'an empty child stays empty')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
