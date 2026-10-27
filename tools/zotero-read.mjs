#!/usr/bin/env node
// Read the owner's reference library: search it, inspect a record, and read an attachment's indexed
// text in slices. Read-only: this tool never writes, so it never asks for authorization.
//
// WHY THIS FILE EXISTS
//
// The reference library reached this preset through `mcp-zotero`, whose 35-tool surface (with its
// optional groups already off) cost 59,758 characters (~16,599 tokens) of prompt on EVERY request,
// and the DSH MCP client has no field that filters a server's tool list. The disciplines call a
// handful of those tools. This helper covers the reading half of that; the writing half is separate
// tools, each with its own gate.
//
// MEASURED TRAPS THIS FILE EXISTS TO HANDLE (all reproduced 2026-10-15 against Zotero 10.0.6)
//
//   * FULL TEXT IS KEYED BY THE ATTACHMENT, NOT THE RECORD. `/items/<parentKey>/fulltext` answers
//     HTTP 404. Reading a paper's text is therefore two steps - list the children, pick the
//     attachment, then fetch its text - and the tool reports WHICH attachment it read, because "which
//     file am I looking at" is part of the evidence.
//   * A FULL-TEXT SEARCH RETURNS MIXED ROWS. One `qmode=everything` query returned three `attachment`
//     rows (whose titles happened to be the paper titles), two `note` rows with EMPTY titles, and one
//     real record. Printing them as they arrive therefore shows duplicates and blank lines. Every row
//     is collapsed onto the record it belongs to, and the kind of each hit is stated.
//   * THERE IS NO "MATCHED WHERE" FIELD. The library reports the rows, not the reason. So this tool
//     says which row matched and which mode searched - never a claim the API did not make.
//   * `itemKey=a,b` IS NOT A PLAIN MULTI-GET. Asked for two keys, the library answered with six rows:
//     the two records AND their children. Every multi-get response is filtered back to the keys asked
//     for, or a record would silently acquire other people's children.
//   * `collections` IS A BARE STRING WHEN THERE IS ONE, AND `tags` IS `[{tag}]`. Both are normalised
//     in ./zotero-local-api.mjs, which is where the other tools read the same shapes.
//   * THE DEFAULT SEARCH MODE IS NOT FULL TEXT. `qmode=titleCreatorYear` searches titles, creators and
//     years only, so a paywalled paper the owner already holds looks absent (measured: 178 hits in
//     `everything` against 2 in the default). This tool therefore DEFAULTS TO `everything` and prints
//     the mode it used.
//
// Note for a human reading this by hand: the library answers HTTP/1.0, so use `curl.exe` rather than
// Invoke-WebRequest if you want to reproduce a call outside this tool.
//
// Usage:
//   node tools/zotero-read.mjs --search "contingencies" --limit 10
//   node tools/zotero-read.mjs --search "retrieval" --qmode titleCreatorYear --tag /done
//   node tools/zotero-read.mjs --item <itemKey>
//   node tools/zotero-read.mjs --fulltext <itemKey> --offset 0 --limit 12000
//   node tools/zotero-read.mjs --fulltext <itemKey> --grep "contingenc"
//   node tools/zotero-read.mjs --collections
//   node tools/zotero-read.mjs --collection <collectionKey>
//   node tools/zotero-read.mjs --collection <collectionKey> --screen [--screen-limit 300]
//   node tools/zotero-read.mjs --tags
//
// Exit codes: 0 answered | 1 the library could not answer, or the record has no such text | 2 usage.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PERSONAL_LIBRARY,
  attachmentRef,
  changedItemsSince,
  childrenOf,
  filePathFrom,
  getJson,
  itemRef,
  itemTypeFields,
  itemTypes,
  libraryPrefix,
  libraryVersion,
  localRequest,
  locationKind,
  normalizeCollections,
  normalizeTags,
  parseLibrary,
  readCollection,
  readItem,
  savedSearches,
  serverInfo,
  visibleText,
} from './zotero-local-api.mjs'
import { Refusal, UsageError, reportFailure } from './refusal.mjs'

const QMODES = ['everything', 'titleCreatorYear']
/** The sort fields the library documents, and the direction it accepts. */
const SORT_FIELDS = ['dateModified', 'dateAdded', 'date', 'title', 'creator']
const SORT_DIRECTIONS = ['asc', 'desc']
/** The sources one retrieval ranks; annotations are deliberately absent until the reader needs them. */
const RETRIEVAL_SOURCES = ['abstract', 'notes', 'fulltext']
/** Word segmentation for BM25; locale-neutral, so a Chinese abstract is not one long token. */
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })
/** The library's own maximum page size for /items. */
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 10
/** Characters of one attachment's text per read. Inside the shell tool's 16,000-character clip, so one slice arrives whole. */
const DEFAULT_READ_LIMIT = 12_000
/** A ceiling on `--limit` in fulltext mode, where the unit is characters rather than rows. */
const MAX_READ_LIMIT = 100_000
/** How many keys one multi-get may ask for. */
const MULTI_GET_CHUNK = 50
const ATTACHMENT_PREFERENCE = ['application/pdf', 'application/epub+zip', 'text/html']
/** Rows per request when screening a whole collection. The library's own page size for /items. */
const SCREEN_PAGE = 100
/** Characters of one abstract per screened record. 100 records at 300 characters is ~30k, inside a
 *  single report; the default batch of a sweep is far smaller than that. */
const DEFAULT_SCREEN_LIMIT = 300
/** A ceiling on how many rows a screening pass will read, so a runaway collection stops loudly. */
const SCREEN_CAP = 2_000

/**
 * How many rows a plain `--collection` listing reads before it stops and says so.
 *
 * `--limit` counts RECORDS there, and this library's "04-2" collection answers 56 rows for 12 records,
 * so a row-sized page would show ten notes and no papers. Enough rows to find a few records, few enough
 * that a listing stays one or two requests; `--screen` is the pass that reads a whole collection.
 */
const LISTING_SCAN = 400
/** The file-side reader, named in a `fix` line only as an absolute, runnable path. */
const PDF_TOOL = fileURLToPath(new URL('./zotero-pdf.mjs', import.meta.url))

/**
 * What one search row IS, and which record it belongs to.
 *
 * @param {object} row A row as the library returns it.
 * @returns {{kind: 'item'|'attachment'|'note', key: string, parentKey: string, contentType: string, title: string, record: object|null}}
 *   `record` is the row's own `data` only when the row is a record; an attachment or a note belongs
 *   to the item it hangs on, and that item has to be fetched separately.
 */
export function classifyHit(row) {
  const data = row?.data ?? {}
  const kind = data.itemType === 'attachment' || data.itemType === 'note' ? data.itemType : 'item'
  return {
    kind,
    key: row.key,
    parentKey: kind === 'item' ? row.key : (data.parentItem ?? row.key),
    contentType: data.contentType ?? '',
    title: data.title ?? '',
    record: kind === 'item' ? data : null,
  }
}

/**
 * Collapse rows onto the records they belong to, preserving the order the library returned.
 *
 * @param {object[]} rows Search rows.
 * @returns {Array<{parentKey: string, record: object|null, sources: Array<{key: string, kind: string, contentType: string}>}>}
 *   One entry per record. Two rows about the same record are two `sources`, so a record matched both
 *   by its metadata and inside an attachment's text is still printed once.
 */
export function groupHits(rows) {
  const groups = new Map()
  for (const row of rows) {
    const hit = classifyHit(row)
    const group = groups.get(hit.parentKey) ?? { parentKey: hit.parentKey, record: null, sources: [] }
    group.sources.push({ key: hit.key, kind: hit.kind, contentType: hit.contentType })
    if (hit.record) group.record = hit.record
    groups.set(hit.parentKey, group)
  }
  return [...groups.values()]
}

/**
 * The 4-digit year out of a date the library stores as free text.
 *
 * `data.date` is whatever the record says - "2012", "09/2019", "n.d.", or a full range - so slicing
 * its first four characters produces things like "09/2". The year is found, or reported as absent.
 *
 * @param {string} dateText The record's date field.
 * @returns {string} The year, or '' when the text holds none.
 */
export function yearOf(dateText) {
  return String(dateText ?? '').match(/(1[5-9]\d\d|20\d\d)/)?.[1] ?? ''
}

/**
 * The attachment a reading should use: the first of the preferred content types that exists.
 *
 * @param {object[]} children Child items as the library returns them.
 * @param {string[]} [preference] Content types in the order they should be tried.
 * @returns {{key: string, contentType: string, linkMode: string, title: string}|null} `null` when the
 *   record has no readable attachment at all - which the caller must report rather than guess around.
 */
export function pickAttachment(children, preference = ATTACHMENT_PREFERENCE) {
  const attachments = children.filter((child) => child?.data?.itemType === 'attachment')
  for (const contentType of preference) {
    const found = attachments.find((child) => child.data.contentType === contentType)
    if (found) {
      return {
        key: found.key,
        contentType: found.data.contentType,
        linkMode: found.data.linkMode ?? '',
        title: found.data.title ?? '',
      }
    }
  }
  return null
}

/**
 * Order collections into a tree by their own parent links.
 *
 * @param {object[]} rows Rows from `/collections`.
 * @returns {Array<{key: string, name: string, count: number, children: object[]}>} Roots, each with
 *   its descendants nested; a collection whose parent is missing is treated as a root rather than
 *   dropped.
 */
export function buildCollectionTree(rows) {
  const nodes = new Map(
    rows.map((row) => [
      row.key,
      { key: row.key, name: row.data?.name ?? '(unnamed)', count: row.meta?.numItems ?? 0, children: [] },
    ]),
  )
  const roots = []
  for (const row of rows) {
    const node = nodes.get(row.key)
    const parent = row.data?.parentCollection ? nodes.get(row.data.parentCollection) : undefined
    ;(parent ? parent.children : roots).push(node)
  }
  return roots
}

/**
 * One slice of a long text, with what is left on either side.
 *
 * @param {string} content The whole text.
 * @param {{offset?: number, limit?: number}} [options] 0-based offset and slice length.
 * @returns {{text: string, from: number, to: number, total: number, nextOffset: number|null}} The
 *   slice and its position; `nextOffset` is null at the end of the text.
 */
export function sliceText(content, { offset = 0, limit = DEFAULT_READ_LIMIT } = {}) {
  const total = content.length
  const from = Math.max(0, Math.min(offset, total))
  const to = Math.min(total, from + Math.max(0, limit))
  return { text: content.slice(from, to), from, to, total, nextOffset: to < total ? to : null }
}

/**
 * Passages around a term, for the "read only what answers the question" rung of the reading ladder.
 *
 * @param {string} content The whole text.
 * @param {string} term What to look for, case-insensitively.
 * @param {{window?: number, max?: number}} [options] Characters of context on each side, and a cap on
 *   the number of passages.
 * @returns {Array<{index: number, excerpt: string}>} Matching passages, whitespace collapsed, in the
 *   order they appear.
 */
export function findPassages(content, term, { window = 200, max = 20 } = {}) {
  if (!term) return []
  const needle = term.toLowerCase()
  const haystack = content.toLowerCase()
  const passages = []
  let index = haystack.indexOf(needle)
  while (index !== -1 && passages.length < max) {
    const start = Math.max(0, index - window)
    const end = Math.min(content.length, index + needle.length + window)
    passages.push({ index, excerpt: content.slice(start, end).replace(/\s+/g, ' ') })
    index = haystack.indexOf(needle, index + needle.length)
  }
  return passages
}

/**
 * Where a note's own sections start.
 *
 * A section note is `<h2>`/`<h3>` blocks over `<p>` prose, and reading a 10k-character note whole to
 * find one section is the most expensive read this tool offers: measured, one 7th-section note was
 * 9,795 visible characters against 27 headings that name every part of it. The offsets are characters
 * of {@link visibleText}'s output, so they are usable as `--offset` with no conversion.
 *
 * Offsets are found by SEARCHING for each block's visible text in order, which stays correct however
 * the application rewrote the markup; the cost is that a heading whose text also occurs earlier in the
 * prose points at the earlier occurrence, so the listing is a map and `--grep` is the ruler.
 *
 * @param {string} html Note body as the library stores it.
 * @param {{maxHeadings?: number}} [options] Cap on the entries returned.
 * @returns {{text: string, kind: 'heading'|'paragraph', headings: Array<{level: number, text: string, offset: number, length: number}>, total: number}}
 *   The visible text, which rungs were found, and each one's offset and run length.
 */
export function noteHeadings(html, { maxHeadings = 120 } = {}) {
  const source = String(html ?? '')
  const text = visibleText(source)
  const scan = (pattern) => {
    const found = []
    let cursor = 0
    for (const match of source.matchAll(pattern)) {
      const label = visibleText(match[2])
      if (!label) continue
      const at = text.indexOf(label, cursor)
      if (at === -1) continue
      found.push({ group: match[1], text: label, offset: at })
      cursor = at + label.length
    }
    return found
  }
  let kind = 'heading'
  let blocks = scan(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)
  if (blocks.length === 0) {
    // A note written as plain paragraphs has no headings; the paragraphs are then the sections, which
    // is still cheaper than the whole body and does not pretend to a structure the body has not got.
    kind = 'paragraph'
    blocks = scan(/<(p)[^>]*>([\s\S]*?)<\/\1>/gi)
  }
  const levelOf = (block) => (kind === 'heading' ? Number(block.group) : 0)
  const headings = blocks.map((block, index) => {
    let end = text.length
    for (let next = index + 1; next < blocks.length; next += 1) {
      if (kind === 'paragraph' || levelOf(blocks[next]) <= levelOf(block)) {
        end = blocks[next].offset
        break
      }
    }
    return { level: levelOf(block), text: block.text, offset: block.offset, length: Math.max(0, end - block.offset) }
  })
  return { text, kind, headings: headings.slice(0, maxHeadings), total: headings.length }
}


/**
 * Split text into the tokens BM25 scores.
 *
 * `Intl.Segmenter` is used rather than a whitespace split because the preset is domain-neutral: a
 * Chinese abstract has no spaces, and a whitespace tokenizer would treat a whole sentence as one term.
 * Punctuation and symbols carry no term, so they are dropped.
 *
 * @param {string} text Any text.
 * @returns {string[]} Lowercased word-like tokens, in order.
 */
export function tokenize(text) {
  const tokens = []
  for (const part of WORD_SEGMENTER.segment(String(text ?? '').toLowerCase())) {
    if (part.isWordLike) tokens.push(part.segment)
  }
  return tokens
}

/**
 * Split one long text into overlapping chunks a reader can cite by offset.
 *
 * The cut prefers a line, a sentence end or a space near the size limit, so a passage does not start
 * mid-word; the overlap keeps a sentence that straddles the cut retrievable from either side.
 *
 * @param {string} text The whole text.
 * @param {{size?: number, overlap?: number}} [options] Chunk size and overlap, in characters.
 * @returns {Array<{text: string, from: number, to: number}>} Chunks with their offsets in `text`.
 */
export function chunkText(text, { size = 1200, overlap = 200 } = {}) {
  const value = String(text ?? '')
  const chunks = []
  for (let from = 0; from < value.length; ) {
    let to = Math.min(value.length, from + Math.max(1, size))
    if (to < value.length) {
      const window = value.slice(from, to)
      const boundary = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' '))
      if (boundary > Math.floor(window.length / 2)) to = from + boundary + 1
    }
    chunks.push({ text: value.slice(from, to), from, to })
    if (to >= value.length) break
    let next = Math.max(from + 1, to - Math.max(0, overlap))
    // Start the next chunk on a word boundary when one is close, so a passage does not begin
    // mid-word merely because the overlap landed there. The offset is adjusted with it.
    const space = value.indexOf(' ', next)
    if (space !== -1 && space < to) next = space + 1
    from = next
  }
  return chunks
}

/**
 * Rank passage candidates against a query with Okapi BM25.
 *
 * A candidate is any object with a `text`; the result is the same object plus a `score`, sorted by
 * score and stable within one call. A candidate with no query term scores nothing and is dropped, so
 * "no passage answers this" is an empty list rather than a weakly relevant one.
 *
 * @param {Array<{text: string, order?: number}>} documents The candidates.
 * @param {string} query The user's terms.
 * @param {{limit?: number, k1?: number, b?: number}} [options] Ranking knobs.
 * @returns {Array<object>} The matching candidates, best first, with `score`.
 */
export function rankPassages(documents, query, { limit = 4, k1 = 1.5, b = 0.75 } = {}) {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0 || documents.length === 0) return []
  const lengths = documents.map((document) => tokenize(document.text).length)
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1
  const documentFrequency = new Map()
  const frequencies = documents.map((document) => {
    const counts = new Map()
    for (const token of tokenize(document.text)) counts.set(token, (counts.get(token) ?? 0) + 1)
    for (const token of counts.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    return counts
  })
  const scored = documents.map((document, index) => {
    let score = 0
    for (const token of queryTokens) {
      const frequency = frequencies[index].get(token) ?? 0
      if (frequency === 0) continue
      const df = documentFrequency.get(token) ?? 0
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
      score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * lengths[index]) / averageLength)))
    }
    return { ...document, score }
  })
  return scored
    .filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score || (a.order ?? 0) - (b.order ?? 0))
    .slice(0, limit)
}

const USAGE =
  'usage: node tools/zotero-read.mjs --search "<query>" [--qmode everything|titleCreatorYear] [--limit N] [--tag TAG]\n' +
  '                                  [--sort FIELD] [--direction asc|desc] [--item-type TYPE] [--trash]\n' +
  '       node tools/zotero-read.mjs --item <key> [--offset N] [--limit N] [--grep TERM | --headings]\n' +
  '                                  # a note prints its body; --grep reads the paragraphs that mention a\n' +
  '                                  # term, --headings lists the note\'s own headings with their offsets\n' +
  '       node tools/zotero-read.mjs --fulltext <key> [--attachment <key>] [--offset N] [--limit N] [--grep TERM]\n' +
  '       node tools/zotero-read.mjs --retrieve <key> --query "<terms>" [--passages N]\n' +
  '                                  [--sources abstract,notes,fulltext]\n' +
  '       node tools/zotero-read.mjs --locate <key>   # the best attachment: a local path or a web URL\n' +
  '       node tools/zotero-read.mjs --collections | --collection <key> [--all-rows] | --tags\n' +
  '       node tools/zotero-read.mjs --changes [--since N]   # baseline, or what changed after a version\n' +
  '       node tools/zotero-read.mjs --item-types | --item-fields <type> | --saved-searches\n' +
  '       node tools/zotero-read.mjs --find-doi <doi>   # is that work already in this library?\n' +
  '       node tools/zotero-read.mjs --collection <key> --screen [--screen-limit N]\n' +
  '       [--library user:0|group:<id>] [--json]\n' +
  '       --limit counts ROWS for a search (at most 100, the library\'s page size) and CHARACTERS for a\n' +
  '       read (default 12000, at most 100000). A note costs its own length on every read, so --headings\n' +
  '       and then --offset is the cheap way into one section of a long one.\n' +
  '       --json reports a record with its children\'s metadata only: a child note\'s stored body is left\n' +
  '       out (its length is in `noteCharacters`), so read that note with --item <noteKey> --json.\n' +
  '       --collection lists RECORDS, counting --limit in records and hiding the notes and attachments\n' +
  '       filed beside them; --all-rows lists every member of the collection instead.\n' +
  '       --screen enumerates a whole collection and prints one abstract per record; --screen-limit sets\n' +
  '       the characters printed per abstract (default 300). --limit does not apply to a screening pass.'

/**
 * Read the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} The requested mode and its options.
 * @throws {UsageError} On a usage error; the CLI turns that into exit code 2.
 */
export function parseArgs(argv) {
  const options = {
    mode: '',
    value: '',
    qmode: 'everything',
    limit: DEFAULT_LIMIT,
    limitRaw: undefined,
    offset: 0,
    tags: [],
    attachment: '',
    grep: '',
    headings: false,
    allRows: false,
    screen: false,
    screenLimit: DEFAULT_SCREEN_LIMIT,
    json: false,
    libraryRaw: '',
    library: PERSONAL_LIBRARY,
    sort: '',
    direction: '',
    itemType: '',
    trash: false,
    query: '',
    passages: 4,
    passagesGiven: false,
    sourcesRaw: '',
    sources: [...RETRIEVAL_SOURCES],
    since: null,
    sinceRaw: '',
  }
  const integer = (name, raw, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new UsageError(`--${name} takes an integer between ${min} and ${max}, got '${raw}'`)
    }
    return parsed
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = argv[index + 1]
    switch (flag) {
      case '--search':
      case '--item':
      case '--fulltext':
      case '--locate':
      case '--retrieve':
      case '--collection':
      case '--find-doi':
      case '--item-fields':
        if (options.mode) throw new UsageError('pass one mode, not two')
        if (!next) throw new UsageError(`${flag} needs a value`)
        options.mode = flag.slice(2)
        options.value = next
        index += 1
        break
      case '--collections':
      case '--tags':
      case '--item-types':
      case '--saved-searches':
      case '--changes':
        if (options.mode) throw new UsageError('pass one mode, not two')
        options.mode = flag.slice(2)
        break
      case '--library':
        options.libraryRaw = next ?? ''
        index += 1
        break
      case '--sort':
        if (!SORT_FIELDS.includes(next)) throw new UsageError(`--sort takes one of ${SORT_FIELDS.join(', ')}, got '${next}'`)
        options.sort = next
        index += 1
        break
      case '--direction':
        if (!SORT_DIRECTIONS.includes(next)) {
          throw new UsageError(`--direction takes one of ${SORT_DIRECTIONS.join(', ')}, got '${next}'`)
        }
        options.direction = next
        index += 1
        break
      case '--item-type':
        if (!next) throw new UsageError('--item-type needs an item type (for example journalArticle)')
        options.itemType = next
        index += 1
        break
      case '--trash':
        options.trash = true
        break
      case '--since':
        options.since = integer('since', next, { min: 0 })
        options.sinceRaw = next
        index += 1
        break
      case '--query':
        options.query = next ?? ''
        index += 1
        break
      case '--passages':
        options.passages = integer('passages', next, { min: 1, max: 20 })
        options.passagesGiven = true
        index += 1
        break
      case '--sources':
        options.sourcesRaw = next ?? ''
        index += 1
        break
      case '--qmode':
        if (!QMODES.includes(next)) throw new UsageError(`--qmode takes one of ${QMODES.join(', ')}, got '${next}'`)
        options.qmode = next
        index += 1
        break
      case '--limit':
        // Validated after the mode is known: rows for a search, characters for a read.
        options.limitRaw = next
        index += 1
        break
      case '--offset':
        options.offset = integer('offset', next)
        index += 1
        break
      case '--tag':
        if (!next) throw new UsageError('--tag needs a tag')
        options.tags.push(next)
        index += 1
        break
      case '--attachment':
        options.attachment = next ?? ''
        index += 1
        break
      case '--grep':
        options.grep = next ?? ''
        index += 1
        break
      case '--headings':
        options.headings = true
        break
      case '--all-rows':
        options.allRows = true
        break
      case '--screen':
        options.screen = true
        break
      case '--screen-limit':
        options.screenLimit = integer('screen-limit', next, { min: 60, max: 2_000 })
        index += 1
        break
      case '--json':
        options.json = true
        break
      default:
        throw new UsageError(`unrecognised argument '${flag}'`)
    }
  }
  if (!options.mode) throw new UsageError('pass one mode (--search, --item, --fulltext, --retrieve, --locate, --collections, --collection, --tags, --changes, --item-types, --item-fields, --saved-searches, --find-doi)')
  try {
    options.library = parseLibrary(options.libraryRaw)
  } catch (error) {
    throw new UsageError(error.message)
  }
  const searchOnly = options.sort !== '' || options.direction !== '' || options.itemType !== '' || options.trash
  if (searchOnly && options.mode !== 'search') {
    throw new UsageError('--sort, --direction, --item-type and --trash apply to --search only')
  }
  const retrievalOnly = options.query !== '' || options.passagesGiven || options.sourcesRaw !== ''
  if (options.mode === 'retrieve') {
    if (!options.query.trim()) throw new UsageError('--retrieve needs --query "<terms>"')
    if (options.sourcesRaw !== '') {
      const requested = options.sourcesRaw.split(',').map((source) => source.trim()).filter(Boolean)
      if (requested.length === 0) throw new UsageError(`--sources needs at least one of ${RETRIEVAL_SOURCES.join(', ')}`)
      for (const source of requested) {
        if (!RETRIEVAL_SOURCES.includes(source)) {
          throw new UsageError(`--sources takes ${RETRIEVAL_SOURCES.join(', ')}, got '${source}'`)
        }
      }
      options.sources = [...new Set(requested)]
    }
  } else if (retrievalOnly) {
    throw new UsageError('--query, --passages and --sources apply to --retrieve only')
  }
  if (options.sinceRaw !== '' && options.mode !== 'changes') {
    throw new UsageError('--since applies to --changes only')
  }
  if (options.screen && options.mode !== 'collection') {
    throw new UsageError('--screen applies to --collection <key> only')
  }
  // A screening pass pages the collection itself, so a row limit on top of it would be a second,
  // conflicting notion of "how much of the collection". The character budget is `--screen-limit`.
  if (options.screen && options.limitRaw !== undefined) {
    throw new UsageError('--screen reads every row of the collection; set --screen-limit for the characters per abstract, not --limit')
  }
  if (options.allRows && options.mode !== 'collection') {
    throw new UsageError('--all-rows lists every member of a collection, so it applies to --collection <key> only')
  }
  if (options.allRows && options.screen) {
    throw new UsageError('--screen separates records from notes already, so --all-rows has nothing to add')
  }
  // Both `--grep` and `--headings` read a note's TEXT, which only a note has. The item a reader
  // probably means is the record, so the refusal names the command that would work - the silent no-op
  // these flags used to be is what made a 10k-character read look like the only option.
  if (options.headings && options.grep) {
    throw new UsageError(
      'pass --grep or --headings, not both: one reads the paragraphs around a term, the other lists where the sections start',
    )
  }
  if (options.headings && options.mode !== 'item') {
    throw new UsageError("--headings lists a note's own headings, so it applies to --item <noteKey> only")
  }
  // `--item` counts characters too, because a note's body is what an item read of a note returns.
  const reading = options.mode === 'fulltext' || options.mode === 'item'
  options.limit = reading ? DEFAULT_READ_LIMIT : DEFAULT_LIMIT
  if (options.limitRaw !== undefined) {
    options.limit = integer('limit', options.limitRaw, { min: 1, max: reading ? MAX_READ_LIMIT : MAX_LIMIT })
  }
  return options
}

/**
 * The rows of a multi-get that were actually asked for.
 *
 * Measured: `?itemKey=a,b` answers with the two records AND their children - asked for two keys, the
 * library returned six rows. Mapping that response unfiltered would attach another record's children
 * to this one, silently and only sometimes.
 *
 * @param {object[]} rows The response rows.
 * @param {string[]} keys The keys that were requested.
 * @returns {Map<string, object>} key -> `data`, for the requested keys only.
 */
export function selectRequested(rows, keys) {
  const wanted = new Set(keys)
  return new Map(rows.filter((row) => wanted.has(row.key)).map((row) => [row.key, row.data]))
}

/** A read that also reports the library's own total, which is the search scope the discipline records. */
async function paginatedJson(path) {
  const res = await localRequest('GET', path)
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}: ${res.text.slice(0, 200)}`)
  return { rows: JSON.parse(res.text), total: Number(res.headers['total-results'] ?? 0) }
}

/** Records by key, asking for at most `MULTI_GET_CHUNK` at a time and keeping only what was asked for. */
async function recordsByKey(keys, library) {
  const records = new Map()
  for (let start = 0; start < keys.length; start += MULTI_GET_CHUNK) {
    const chunk = keys.slice(start, start + MULTI_GET_CHUNK)
    const rows = await getJson(`${libraryPrefix(library)}/items?itemKey=${chunk.join(',')}&format=json`)
    for (const [key, data] of selectRequested(rows, chunk)) records.set(key, data)
  }
  return records
}

/** Collection key -> name, for printing a record's filing in words rather than as bare keys. */
async function collectionNames(library) {
  const rows = await getJson(`${libraryPrefix(library)}/collections?format=json&limit=200`)
  return new Map(rows.map((row) => [row.key, row.data?.name ?? '(unnamed)']))
}

/**
 * The header every mode prints, so a report always says which library answered.
 *
 * `--json` is for a machine, so the header goes to stderr there and stdout stays parseable - the rule
 * the other helpers already follow (measured: `zotero-section-note.mjs --item <key> --json` answers
 * pure JSON), and a header line in front of it is what made every consumer strip the first line.
 *
 * @param {boolean} [json] Whether this run's stdout is machine-readable.
 */
async function printIdentity(json = false) {
  const info = await serverInfo()
  const write = json ? console.error : console.log
  write(`library : Zotero ${info.version} · server ${info.id}`)
}

function describeCreators(creators = []) {
  if (creators.length === 0) return 'none'
  const names = creators.map((c) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' '))
  const shown = names.length <= 4 ? names : [...names.slice(0, 3), 'et al.']
  return `${names.length}  (${shown.join('; ')})`
}

/** The one-line author form a search result uses, so triage does not need a second read. */
export function shortCreators(creators = []) {
  const names = creators.map((creator) => creator?.name ?? creator?.lastName ?? '').filter(Boolean)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} & ${names[1]}`
  return `${names[0]} et al.`
}

/**
 * The citation-relevant fields a record carries, keyed by the label a citation uses.
 *
 * The library stores different fields for different item types: a journal article carries
 * `publicationTitle`, a conference paper `proceedingsTitle`, a book `publisher`, a thesis `university`.
 * One label may therefore be filled from several fields; the first non-empty one wins.
 */
const CITATION_SOURCES = [
  ['venue', ['publicationTitle', 'proceedingsTitle', 'conferenceName', 'bookTitle', 'websiteTitle']],
  ['publisher', ['publisher', 'university', 'institution']],
  ['volume', ['volume']],
  ['issue', ['issue']],
  ['pages', ['pages']],
  ['edition', ['edition']],
  ['series', ['series', 'seriesTitle']],
  ['ISBN', ['ISBN']],
  ['ISSN', ['ISSN']],
  ['repository', ['repository']],
  ['archiveID', ['archiveID']],
]

/**
 * The citation fields present on one record.
 *
 * `abstractNote` is deliberately absent: it is library metadata, possibly edited by hand, and it is not
 * the paper's own abstract. The reading ladder reaches that through the indexed text instead.
 *
 * @param {object} [data] A record's `data`.
 * @returns {Record<string, string>} The present fields, by citation label.
 */
export function citationFields(data = {}) {
  const fields = {}
  for (const [label, sources] of CITATION_SOURCES) {
    const value = sources.map((source) => data[source]).find((entry) => typeof entry === 'string' && entry.trim() !== '')
    if (value) fields[label] = value.trim()
  }
  return fields
}

/**
 * The citation block one record prints: venue, publisher, volume/issue, pages and the type-specific
 * identifiers, each only when the record carries it.
 *
 * @param {object} [data] A record's `data`.
 * @returns {string[]} Lines already padded for the reader's label column.
 */
export function citationLines(data = {}) {
  const fields = citationFields(data)
  const lines = []
  for (const label of ['venue', 'publisher']) {
    if (fields[label]) lines.push(`${label.padEnd(11)}: ${fields[label]}`)
  }
  const volume = [fields.volume && `volume ${fields.volume}`, fields.issue && `issue ${fields.issue}`].filter(Boolean)
  if (volume.length > 0) lines.push(`volume     : ${volume.join(' · ')}`)
  if (fields.pages) lines.push(`pages      : ${fields.pages}`)
  for (const label of ['edition', 'series', 'ISBN', 'ISSN', 'repository', 'archiveID']) {
    if (fields[label]) lines.push(`${label.padEnd(11)}: ${fields[label]}`)
  }
  return lines
}

/**
 * How many lines of the owner's `extra` field a plain read prints before it says the rest is elsewhere.
 *
 * The field is hand-typed, so its length is not a property this preset controls. Every record measured
 * in the owner's library held under 500 characters, and a bound with a printed marker costs nothing when
 * it is never reached - while an unbounded print is a field a paste can make unreadable.
 */
const EXTRA_LINES_MAX = 12

/**
 * An item as `--json` reports it: its metadata and how long its stored body is, never the body itself.
 *
 * Measured on `DSPZ6AG3`: `--item --json` answered 13,916 characters, of which the record's own data was
 * under 1,400 - the rest was the stored HTML of its child notes. The same holds for a collection
 * listing, where a note row would otherwise carry its whole body. A caller that does want a body reads
 * that note directly with `--item <noteKey> --json`.
 *
 * @param {object} [data] One item's `data`.
 * @returns {object} That `data` without the stored note body, plus `noteCharacters` when it had one.
 */
export function itemForJson(data = {}) {
  const { note, ...rest } = data
  return note === undefined ? rest : { ...rest, noteCharacters: String(note).length }
}

/**
 * The owner's `extra` field, as printed lines.
 *
 * This is where the record keeps what its owner wrote about it rather than what the catalogue says:
 * `remark:` (his one-line digest, whose phrases a discipline drafts) and `rate:` (his own rating), plus
 * the translations and identifiers the reference manager imports. It used to be reachable only through
 * `--json`, which answered with the whole record plus every child note's stored body - tens of
 * thousands of characters for a field of a few dozen.
 *
 * @param {unknown} extra The record's `extra` value.
 * @param {{maxLines?: number}} [options] The bound, injected so the self-test can reach it.
 * @returns {string[]} Already padded for the reader's label column; empty when the field is blank.
 */
export function extraLines(extra, { maxLines = EXTRA_LINES_MAX } = {}) {
  const text = String(extra ?? '')
  if (text.trim() === '') return []
  const lines = text.split(/\r?\n/)
  const shown = lines.length <= maxLines ? lines : lines.slice(0, maxLines)
  const out = [`extra      : ${shown[0]}`]
  for (const line of shown.slice(1)) out.push(`             ${line}`)
  if (shown.length < lines.length) {
    out.push(`             ... ${lines.length - shown.length} more line(s); --json keeps the whole field`)
  }
  return out
}

/**
 * Full-text indexing coverage, from the library's own two axes.
 * `complete` is true only when at least one axis was reported and every reported axis agrees: a text
 * file has chars and no pages, a PDF has both, and a response that reports neither is incomplete rather
 * than a guess.
 *
 * @param {object} [payload] The `/fulltext` body.
 * @returns {{indexedPages?: number, totalPages?: number, indexedChars?: number, totalChars?: number, complete: boolean}}
 *   The coverage.
 */
export function coverageOf(payload = {}) {
  const indexedPages = Number.isInteger(payload.indexedPages) ? payload.indexedPages : undefined
  const totalPages = Number.isInteger(payload.totalPages) ? payload.totalPages : undefined
  const indexedChars = Number.isInteger(payload.indexedChars) ? payload.indexedChars : undefined
  const totalChars = Number.isInteger(payload.totalChars) ? payload.totalChars : undefined
  const pages = indexedPages !== undefined && totalPages !== undefined ? indexedPages === totalPages : undefined
  const chars = indexedChars !== undefined && totalChars !== undefined ? indexedChars === totalChars : undefined
  const axes = [pages, chars].filter((value) => value !== undefined)
  return {
    ...(indexedPages !== undefined ? { indexedPages } : {}),
    ...(totalPages !== undefined ? { totalPages } : {}),
    ...(indexedChars !== undefined ? { indexedChars } : {}),
    ...(totalChars !== undefined ? { totalChars } : {}),
    complete: axes.length > 0 && axes.every(Boolean),
  }
}

/** Ask the library where an attachment's file is. The answer is a `file://` or a web location. */
async function attachmentLocation(key, library) {
  const res = await localRequest('GET', `${libraryPrefix(library)}/items/${key}/file`)
  const location = res.headers.location ?? ''
  if (!location) throw new Error(`the library did not hand over a path for ${key} (HTTP ${res.status})`)
  return location
}

async function runSearch(options) {
  const params = new URLSearchParams({ q: options.value, limit: String(options.limit), format: 'json' })
  params.set('qmode', options.qmode)
  for (const tag of options.tags) params.append('tag', tag)
  if (options.sort) params.set('sort', options.sort)
  if (options.direction) params.set('direction', options.direction)
  if (options.itemType) params.set('itemType', options.itemType)
  if (options.trash) params.set('includeTrashed', '1')
  const { rows, total } = await paginatedJson(`${libraryPrefix(options.library)}/items?${params}`)
  const groups = groupHits(rows)
  const missing = groups.filter((group) => !group.record).map((group) => group.parentKey)
  const fetched = missing.length > 0 ? await recordsByKey(missing, options.library) : new Map()
  for (const group of groups) if (!group.record && fetched.has(group.parentKey)) group.record = fetched.get(group.parentKey)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          query: options.value,
          qmode: options.qmode,
          tags: options.tags,
          library: options.library,
          sort: options.sort || undefined,
          direction: options.direction || undefined,
          itemType: options.itemType || undefined,
          includeTrashed: options.trash,
          total,
          hits: rows.length,
          records: groups.map((group) => ({
            key: group.parentKey,
            ref: itemRef(group.parentKey, options.library),
            sources: group.sources,
            record: group.record,
          })),
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(`query   : qmode=${options.qmode}  "${options.value}"${options.tags.length ? `  tags=${options.tags.join(',')}` : ''}`)
  const filters = [
    options.itemType ? `type=${options.itemType}` : '',
    options.sort ? `sort=${options.sort}${options.direction ? `/${options.direction}` : ''}` : '',
    options.trash ? 'trashed included' : '',
  ].filter(Boolean)
  if (filters.length > 0) console.log(`filter  : ${filters.join(' · ')}`)
  console.log(
    `scope   : total ${total} · rows ${rows.length} · records ${groups.length} · limit ${options.limit}` +
      (rows.length < total ? '  (the total is the library\'s, the rows are this page)' : ''),
  )
  if (options.qmode === 'everything') {
    console.log('mode    : everything also matches attachment text and notes; those rows are hits INSIDE a')
    console.log('          record, so they are shown here as one record with its sources, never as works.')
  } else {
    console.log('mode    : titleCreatorYear searches titles, creators and years only - a paper whose text')
    console.log('          contains the term but whose title does not will look absent. Say so if you report it.')
  }
  if (groups.length === 0) {
    console.log('\n0 records - the query was answered and matched nothing. This is not a failure.')
    return
  }
  console.log('')
  groups.forEach((group, index) => {
    const record = group.record
    const year = yearOf(record?.date)
    const type = record?.itemType ?? 'unknown type'
    const title = record?.title || '(no title on this record)'
    console.log(`${index + 1}. ${group.parentKey}  ${year || '????'}  [${type}]  ${title}`)
    const authors = shortCreators(record?.creators)
    if (authors) console.log(`   by   : ${authors}`)
    const parts = group.sources.map((source) =>
      source.kind === 'item'
        ? 'metadata'
        : `${source.kind} ${source.key}${source.contentType ? ` (${source.contentType})` : ''}`,
    )
    console.log(`   hit  : ${parts.join(' · ')}`)
  })
}

/**
 * One record, with a 404 turned into the one thing a reader can do about it.
 *
 * The transport cannot say this: a 404 also means "no such collection" to a write, and the remedy
 * differs. Here the key came from the reader, so the only next action is to find the record and read its
 * key - and no command is offered, because the search terms are the reader's. A `try` line with a
 * placeholder in it gets pasted and fails, which is worse than prose.
 */
export async function readItemOrRefuse(key, read = readItem) {
  try {
    return await read(key)
  } catch (error) {
    if (error.status !== 404) throw error
    throw new Refusal(`the library has no record under the key ${key} (404)`, {
      fix: 'a key is copied from a search result or from the item pane; search the record by its title or author, and read the key from that answer',
    })
  }
}

/**
 * Print the passages that mention a term: the "read only what answers the question" rung.
 *
 * One definition for both texts this tool searches, because the attachment's indexed text and a note's
 * body are searched the same way, and two printers would drift apart on the line that a reader trusts
 * to prove the term was looked for.
 *
 * @param {string} label The aligned label, e.g. `'term   '` - the leading field is padded to the mode.
 * @param {string} term What to look for, case-insensitively.
 * @param {string} content The text to search.
 * @param {string} subject What was searched, named in the "0 passages" line.
 * @returns {void}
 */
function printTermPassages(label, term, content, subject) {
  const passages = findPassages(content, term)
  console.log(`${label}: "${term}"  (case-insensitive, ${passages.length} passage(s), most 20; whitespace collapsed)`)
  if (passages.length === 0) {
    console.log(`\n0 passages - the term does not occur in ${subject}.`)
    return
  }
  console.log('')
  passages.forEach((passage, index) => console.log(`${index + 1}. @${passage.index}  ${passage.excerpt}`))
}

async function runItem(options) {
  const key = options.value
  const [data, children, names] = await Promise.all([
    readItemOrRefuse(key, (candidate) => readItem(candidate, { library: options.library })),
    childrenOf(key, { library: options.library }),
    collectionNames(options.library),
  ])
  const collections = normalizeCollections(data.collections)
  const picked = pickAttachment(children)
  // A record has no body of its own, so a flag that reads text has nothing to read here. Said as a
  // usage error rather than ignored: the ignored version printed the whole record and looked like an
  // answer, which is how a read that costs 14k characters came to be the one people reached for.
  if ((options.grep !== '' || options.headings) && data.itemType !== 'note') {
    const flag = options.headings ? '--headings' : '--grep'
    const quoted = options.grep === '' ? '' : ` "${options.grep}"`
    throw new UsageError(
      `${flag} reads text, and ${key} is a ${data.itemType ?? 'record'}: it has no body of its own. ` +
        `Read its file with --fulltext ${key}${flag === '--grep' ? ` --grep${quoted}` : ''}, its abstract and ` +
        `notes with --retrieve ${key} --query "<terms>", or one note with --item <noteKey> ${flag}${quoted}`,
    )
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          key,
          ref: itemRef(key, options.library),
          library: options.library,
          citation: citationFields(data),
          data,
          children: children.map((child) => itemForJson(child.data)),
          fulltextSource: picked,
        },
        null,
        2,
      ),
    )
    return
  }
  console.log(`item       : ${key}  [${data.itemType}]  "${data.title ?? ''}"`)
  console.log(`ref        : ${itemRef(key, options.library)}`)
  console.log(`creators   : ${describeCreators(data.creators)}`)
  console.log(`date       : ${data.date ?? '(none)'}`)
  for (const line of citationLines(data)) console.log(line)
  if (data.DOI) console.log(`DOI        : ${data.DOI}`)
  if (data.url) console.log(`url        : ${data.url}`)
  console.log(`collections: ${collections.length === 0 ? 'none' : collections.map((c) => `${c} (${names.get(c) ?? 'unknown'})`).join(' · ')}`)
  console.log(`tags       : ${normalizeTags(data.tags).join(' · ') || 'none'}`)
  for (const line of extraLines(data.extra)) console.log(line)
  console.log(`version    : ${data.version}   (a write must send If-Unmodified-Since-Version: ${data.version})`)
  console.log(`children   : ${children.length}`)
  for (const child of children) {
    const childData = child.data ?? {}
    const marker = picked && child.key === picked.key ? '   <- --fulltext reads this' : ''
    console.log(
      `  ${(childData.itemType ?? '?').padEnd(11)} ${child.key}  ${(childData.contentType ?? '-').padEnd(16)} ${childData.linkMode ?? ''}${marker}`,
    )
  }
  if (!picked && children.length > 0) console.log('  (no PDF, EPUB or HTML attachment: nothing here can be read as text)')
  // A note IS its body. Printing only its metadata made an existing note unreadable, which left the
  // section-note discipline naming a ruler it could not open.
  if (data.itemType === 'note') {
    const note = visibleText(data.note ?? '')
    // Both flags answer a NOTE question, so they are answered before the `--json` branch: a flag that
    // is silently dropped by another flag is the same bug one level up.
    if (options.headings || options.grep !== '') {
      if (options.headings) {
        const outline = noteHeadings(data.note ?? '')
        if (options.json) {
          console.log(JSON.stringify({ key, kind: outline.kind, characters: outline.text.length, total: outline.total, headings: outline.headings }, null, 2))
          return
        }
        console.log(`note       : ${note.length} characters (visible text) · ${outline.total} ${outline.kind}(s)`)
        if (outline.total === 0) {
          console.log(`             no <h1>-<h6> and no <p> block: nothing to outline, read it whole with --item ${key}`)
          return
        }
        if (outline.total > outline.headings.length) {
          console.log(`             listing the first ${outline.headings.length}; --grep reaches the rest`)
        }
        console.log('outline    : @offset  lvl  title                                     +length')
        for (const heading of outline.headings) {
          const level = outline.kind === 'heading' ? `h${heading.level}` : 'p '
          const title = heading.text.length > 64 ? `${heading.text.slice(0, 61)}...` : heading.text
          console.log(`  @${String(heading.offset).padEnd(7)} ${level.padEnd(4)} ${title}  +${heading.length}`)
        }
        console.log('next       : read one with --offset <@offset> --limit <+length>, or --grep "<term>" for the paragraphs that mention it')
        return
      }
      if (options.json) {
        console.log(JSON.stringify({ key, term: options.grep, passages: findPassages(note, options.grep) }, null, 2))
        return
      }
      printTermPassages('term       ', options.grep, note, "this note's visible text")
      return
    }
    const slice = sliceText(note, { offset: options.offset, limit: options.limit })
    console.log(`note       : ${note.length} characters (visible text; --json keeps the stored HTML) · showing ${slice.from}-${slice.to}`)
    if (slice.nextOffset !== null) console.log(`             next: --offset ${slice.nextOffset}`)
    console.log('---')
    console.log(slice.text)
  }
}

async function runFulltext(options) {
  const key = options.value
  const library = options.library
  const record = await readItemOrRefuse(key, (candidate) => readItem(candidate, { library }))
  // `zotero-pdf` reads a record's attachment, so a command that works as printed names the record,
  // not the attachment key the reader happened to pass.
  const recordKey = record.parentItem ?? key
  let attachmentKey = options.attachment
  let source = null
  let children = []
  if (!attachmentKey) {
    if (record.itemType === 'attachment') {
      attachmentKey = key
      source = { key, contentType: record.contentType ?? '', linkMode: record.linkMode ?? '', title: record.title ?? '' }
    } else {
      children = await childrenOf(key, { library })
      const picked = pickAttachment(children)
      if (!picked) {
        throw new Refusal(
          `record ${key} has no PDF, EPUB or HTML attachment to read` +
            (children.length ? ` (its ${children.length} child item(s) are none of those)` : ' (it has no children)'),
          {
            fix: 'attach the file to the record in the library; the indexed text is keyed by the attachment, so there is nothing to read until one exists',
          },
        )
      }
      attachmentKey = picked.key
      source = picked
    }
  } else {
    const attachment = await readItem(attachmentKey, { library })
    source = {
      key: attachmentKey,
      contentType: attachment.contentType ?? '',
      linkMode: attachment.linkMode ?? '',
      title: attachment.title ?? '',
    }
  }

  const res = await localRequest('GET', `${libraryPrefix(library)}/items/${attachmentKey}/fulltext?format=json`)
  if (res.status === 404) {
    throw new Refusal(`the library has no indexed text for attachment ${attachmentKey} (404)`, {
      fix: 'the index is not the file: read the attachment itself, which needs no index',
      command: `node "${PDF_TOOL}" --item ${recordKey} --extract`,
    })
  }
  if (res.status !== 200) throw new Error(`fulltext answered ${res.status}: ${res.text.slice(0, 200)}`)
  const body = JSON.parse(res.text)
  const content = body.content ?? ''
  const coverage = coverageOf(body)
  const others = children.filter((child) => child.key !== attachmentKey)
  const slice = sliceText(content, { offset: options.offset, limit: options.limit })

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          key,
          ref: itemRef(key, library),
          attachmentRef: attachmentRef(attachmentKey, library),
          source,
          coverage,
          indexedPages: body.indexedPages,
          totalPages: body.totalPages,
          characters: content.length,
          from: slice.from,
          to: slice.to,
          nextOffset: slice.nextOffset,
          truncated: options.grep ? false : slice.nextOffset !== null,
          sourcesSkipped: [],
          text: options.grep ? undefined : slice.text,
          passages: options.grep ? findPassages(content, options.grep) : undefined,
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(`item   : ${key}  "${record.title ?? ''}"`)
  console.log(`ref    : ${itemRef(key, library)}`)
  console.log(`source : attachment ${source.key}  ${source.contentType || 'unknown type'}  ${source.linkMode}`)
  if (others.length > 0) {
    console.log(
      `         other children: ${others.map((child) => `${child.data?.itemType} ${child.key}${child.data?.contentType ? ` ${child.data.contentType}` : ''}`).join(' · ')}`,
    )
  }
  console.log(`text   : ${content.length} characters · ${body.indexedPages ?? '?'} of ${body.totalPages ?? '?'} indexed pages`)
  // Which rung answered, and what it can be trusted for. The line matters most when the answer is
  // EMPTY: an attachment the library never indexed reports about the index rather than about the
  // paper, and the two read identically from the text alone (protocol §6, `INV-CTX-1`).
  console.log(`rung   : (1) the library's indexed text - cheapest, and the rung that can be missing or stale.`)
  console.log(`         An empty text here is a statement about the index. tools/zotero-pdf.mjs reads the`)
  console.log(`         others: (2) the file's own text layer, (3) its table of contents, (4) the page as an image.`)
  if (content === '') {
    console.log(`next   : nothing is indexed for this attachment. Read the file itself with:`)
    console.log(`         node "${PDF_TOOL}" --item ${recordKey} --extract`)
  }

  if (options.grep) {
    printTermPassages('term   ', options.grep, content, "this attachment's indexed text")
    return
  }

  console.log(
    `slice  : showing ${slice.total === 0 ? '0' : slice.from + 1}-${slice.to} of ${slice.total}` +
      (slice.nextOffset === null ? '   (end of text)' : `    next: --offset ${slice.nextOffset}`),
  )
  console.log(`\n${slice.text}`)
}

/**
 * Where an item's best attachment actually is.
 *
 * This is the escalation path for a PDF the library has not indexed: it hands back a path or a URL, and
 * says which environment the path belongs to. A missing file is reported as missing rather than as a
 * path the reader may trust.
 */
async function runLocate(options) {
  const key = options.value
  const library = options.library
  const record = await readItemOrRefuse(key, (candidate) => readItem(candidate, { library }))
  let attachment = null
  if (record.itemType === 'attachment') {
    attachment = { key, contentType: record.contentType ?? '', linkMode: record.linkMode ?? '', title: record.title ?? '' }
  } else {
    attachment = pickAttachment(await childrenOf(key, { library }))
  }
  if (!attachment) {
    throw new Refusal(`record ${key} has no PDF, EPUB or HTML attachment`, {
      fix: 'attach the file to the record in the library; a record without one has no file to locate',
    })
  }
  const location = await attachmentLocation(attachment.key, library)
  const kind = locationKind(location)
  const path = kind === 'file' ? filePathFrom(location) : ''
  if (kind === 'file' && path === '') {
    throw new Error(`the library answered a location that is neither a file nor a URL: ${location}`)
  }
  const exists = kind === 'file' ? existsSync(path) : null
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ref: itemRef(key, library),
          attachmentRef: attachmentRef(attachment.key, library),
          attachment,
          kind,
          ...(kind === 'file' ? { path, exists } : { url: location }),
        },
        null,
        2,
      ),
    )
    return
  }
  console.log(`item       : ${key}  "${record.title ?? ''}"`)
  console.log(`attachment : ${attachment.key}  ${attachment.contentType || 'unknown type'}  ${attachment.linkMode}`)
  console.log(`kind       : ${kind}`)
  if (kind === 'file') {
    console.log(`path       : ${path}`)
    console.log(`exists     : ${exists ? 'yes' : 'NO - the library points at a file that is not there'}`)
  } else {
    console.log(`url        : ${location}`)
  }
}

/**
 * Rank the abstract, the notes and the indexed full text against one question.
 *
 * Every passage keeps its source: which attachment or note it came from, and its offsets in that
 * source. Full text is chunked with overlap so a sentence across a cut is still retrievable. A source
 * the item does not have is reported in `sourcesSkipped`, never silently treated as "nothing relevant".
 */
async function runRetrieve(options) {
  const { library, value: key, query } = options
  const record = await readItemOrRefuse(key, (candidate) => readItem(candidate, { library }))
  const wanted = new Set(options.sources)
  const documents = []
  const skipped = []
  let attachment = null
  let coverage = null
  let order = 0

  const push = (document) => documents.push({ ...document, order: order++ })

  if (wanted.has('abstract') && record.abstractNote) {
    const text = visibleText(record.abstractNote)
    if (text) push({ source: 'abstract', sourceRef: itemRef(key, library), offsets: { from: 0, to: text.length }, text })
  }

  if (wanted.has('notes')) {
    if (record.itemType === 'note') {
      const text = visibleText(record.note ?? '')
      if (text) push({ source: 'note', sourceRef: itemRef(key, library), offsets: { from: 0, to: text.length }, text })
    } else {
      const notes = (await childrenOf(key, { library })).filter((child) => child.data?.itemType === 'note')
      for (const note of notes) {
        const text = visibleText(note.data?.note ?? '')
        for (const chunk of chunkText(text)) {
          push({
            source: 'note',
            sourceRef: itemRef(note.key, library),
            offsets: { from: chunk.from, to: chunk.to },
            text: chunk.text,
          })
        }
      }
    }
  }

  if (wanted.has('fulltext')) {
    attachment =
      record.itemType === 'attachment'
        ? { key, contentType: record.contentType ?? '', linkMode: record.linkMode ?? '', title: record.title ?? '' }
        : pickAttachment(await childrenOf(key, { library }))
    if (!attachment) {
      skipped.push('fulltext')
    } else {
      const res = await localRequest('GET', `${libraryPrefix(library)}/items/${attachment.key}/fulltext?format=json`)
      if (res.status === 404) {
        skipped.push('fulltext')
      } else if (res.status !== 200) {
        throw new Error(`fulltext answered ${res.status}: ${res.text.slice(0, 200)}`)
      } else {
        const body = JSON.parse(res.text)
        coverage = coverageOf(body)
        for (const chunk of chunkText(body.content ?? '')) {
          push({
            source: 'fulltext',
            sourceRef: attachmentRef(attachment.key, library),
            attachmentRef: attachmentRef(attachment.key, library),
            offsets: { from: chunk.from, to: chunk.to },
            text: chunk.text,
          })
        }
      }
    }
  }

  const matches = rankPassages(documents, query, { limit: documents.length })
  const evidence = matches.slice(0, options.passages).map((document) => ({
    ...document,
    score: Number(document.score.toFixed(4)),
  }))
  const truncated = matches.length > evidence.length
  if (wanted.has('abstract') && !documents.some((document) => document.source === 'abstract')) skipped.push('abstract')
  if (wanted.has('notes') && !documents.some((document) => document.source === 'note')) skipped.push('notes')
  const counts = {
    abstract: documents.filter((document) => document.source === 'abstract').length,
    notes: documents.filter((document) => document.source === 'note').length,
    fulltext: documents.filter((document) => document.source === 'fulltext').length,
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ref: itemRef(key, library),
          query,
          sources: [...wanted],
          attachmentRef: attachment ? attachmentRef(attachment.key, library) : undefined,
          coverage,
          counts,
          evidence,
          truncated,
          sourcesSkipped: skipped,
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(`item   : ${key}  "${record.title ?? ''}"`)
  console.log(`ref    : ${itemRef(key, library)}`)
  console.log(`query  : "${query}"`)
  console.log(`sources: ${[...wanted].join(' · ')}  (abstract ${counts.abstract} · notes ${counts.notes} chunk(s) · fulltext ${counts.fulltext} chunk(s))`)
  if (coverage) {
    console.log(
      `covered: ${coverage.indexedPages ?? '?'} of ${coverage.totalPages ?? '?'} indexed pages` +
        (coverage.complete ? '  complete' : '  INCOMPLETE'),
    )
  }
  if (skipped.length > 0) {
    console.log(`skipped: ${skipped.join(', ')} - the item does not provide it`)
    if (skipped.includes('fulltext')) {
      console.log(`         read the file itself with: node "${PDF_TOOL}" --item ${record.parentItem ?? key} --extract`)
    }
  }
  if (evidence.length === 0) {
    console.log('\n0 passages - the sources were searched and none matched the query. This is not a failure.')
    return
  }
  console.log('')
  evidence.forEach((document, index) => {
    const where = document.source === 'fulltext' ? document.sourceRef : document.sourceRef
    console.log(
      `${index + 1}. [${document.source} ${where} @${document.offsets.from}-${document.offsets.to}]  score ${document.score}`,
    )
    console.log(document.text.trim())
    console.log('')
  })
  if (truncated) console.log(`truncated : showing ${evidence.length} of ${matches.length} matching passages; raise --passages.`)
}

/**
 * A DOI as the library and a resolver write it: lowercased, without a resolver prefix or whitespace.
 *
 * @param {string} value A DOI in any of the forms a reader copies.
 * @returns {string} The normalized DOI.
 */
export function sameDoi(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^doi:\s*/, '')
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
}

/**
 * The items in this library that carry the DOI asked for.
 *
 * A DOI search is a text search, so the answer is filtered: a record whose title merely contains the
 * string is not the work with that identifier.
 */
async function runFindDoi(options) {
  const target = sameDoi(options.value)
  if (target === '') throw new UsageError('--find-doi needs a DOI')
  const params = new URLSearchParams({
    q: options.value,
    qmode: 'everything',
    format: 'json',
    limit: String(options.limit),
  })
  const { rows, total } = await paginatedJson(`${libraryPrefix(options.library)}/items?${params}`)
  const groups = groupHits(rows)
  const missing = groups.filter((group) => !group.record).map((group) => group.parentKey)
  const fetched = missing.length > 0 ? await recordsByKey(missing, options.library) : new Map()
  for (const group of groups) if (!group.record && fetched.has(group.parentKey)) group.record = fetched.get(group.parentKey)
  const matches = groups
    .filter((group) => sameDoi(group.record?.DOI) === target)
    .map((group) => ({
      key: group.parentKey,
      ref: itemRef(group.parentKey, options.library),
      title: group.record?.title ?? '',
      itemType: group.record?.itemType ?? '',
    }))

  if (options.json) {
    console.log(JSON.stringify({ doi: target, library: options.library, searched: total, matches }, null, 2))
    return
  }
  console.log(`doi    : ${target}`)
  console.log(`matches: ${matches.length} of ${groups.length} candidate(s) from a text search`)
  if (matches.length === 0) {
    console.log('\nnot in this library - the search was answered and no record carries that DOI. This is not a failure.')
    return
  }
  for (const match of matches) console.log(`${match.key}  ${match.ref}  ${match.itemType}  ${match.title}`)
}

/** What changed in the library since a version, or the baseline a later call can diff from. */
async function runChanges(options) {
  const library = options.library
  const current = await libraryVersion(library)
  if (current.version === 0) {
    throw new Refusal('this build reports no library version, so no diff can be attributed to one snapshot', {
      fix: 'read the library directly; the changes cursor needs Zotero 10, which reports Last-Modified-Version',
    })
  }
  if (options.since === null) {
    if (options.json) {
      console.log(
        JSON.stringify(
          { library, serverId: current.serverId, version: current.version, since: null, changed: [], total: 0 },
          null,
          2,
        ),
      )
      return
    }
    console.log(`server  : ${current.serverId}`)
    console.log(`version : ${current.version}`)
    console.log(`cursor  : pass --since ${current.version} on the next call to see what changed after this reading`)
    return
  }

  const diff = await changedItemsSince(options.since, library)
  if (diff.unsupported) {
    throw new Refusal(`this build cannot diff from version ${options.since}`, {
      fix: 'take a baseline with --changes, then pass the version it prints',
    })
  }
  const changed = diff.keys.map((key) => ({ key, ref: itemRef(key, library) }))
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          library,
          serverId: diff.serverId || current.serverId,
          version: diff.version,
          since: options.since,
          total: diff.total,
          changed,
        },
        null,
        2,
      ),
    )
    return
  }
  console.log(`server  : ${diff.serverId || current.serverId}`)
  console.log(`since   : ${options.since}`)
  console.log(`version : ${diff.version}`)
  console.log(`changed : ${diff.total} top-level item(s)${changed.length < diff.total ? ` (listing ${changed.length})` : ''}`)
  for (const entry of changed) console.log(`  ${entry.key}  ${entry.ref}`)
  console.log(`next    : --since ${diff.version}`)
}

/** The item types this build serves, sorted. */
async function runItemTypes(options) {
  const rows = await itemTypes()
  const types = rows
    .map((row) => ({ itemType: row?.itemType ?? row?.name ?? '', localized: row?.localized ?? '' }))
    .filter((row) => row.itemType !== '')
    .sort((a, b) => a.itemType.localeCompare(b.itemType))
  if (options.json) {
    console.log(JSON.stringify({ total: types.length, itemTypes: types }, null, 2))
    return
  }
  console.log(`item types: ${types.length}`)
  for (const type of types) console.log(`${type.itemType}${type.localized ? `  (${type.localized})` : ''}`)
}

/** The fields and creator types one item type accepts. */
async function runItemFields(options) {
  const type = options.value
  const fields = await itemTypeFields(type)
  if (fields === null) {
    throw new Refusal(`this build does not expose the field schema for ${type} (404)`, {
      fix: 'the editable-field whitelist remains the only check on this build; try a known field instead',
    })
  }
  const creators = await getJson(`/api/itemTypeCreatorTypes?itemType=${encodeURIComponent(type)}`).catch(() => [])
  const names = fields.map((row) => row?.field).filter(Boolean).sort()
  const creatorTypes = (Array.isArray(creators) ? creators : [])
    .map((row) => row?.creatorType)
    .filter(Boolean)
    .sort()
  if (options.json) {
    console.log(JSON.stringify({ itemType: type, fields: names, creatorTypes }, null, 2))
    return
  }
  console.log(`item type : ${type}`)
  console.log(`fields    : ${names.join(' · ')}`)
  console.log(`creators  : ${creatorTypes.join(' · ') || '(none reported)'}`)
}

/** The saved searches filed in one library. */
async function runSavedSearches(options) {
  const rows = await savedSearches(options.library)
  const searches = (Array.isArray(rows) ? rows : []).map((row) => ({
    key: row?.key ?? '',
    name: row?.data?.name ?? row?.name ?? '(unnamed)',
  }))
  if (options.json) {
    console.log(JSON.stringify({ library: options.library, total: searches.length, savedSearches: searches }, null, 2))
    return
  }
  console.log(`saved searches: ${searches.length}`)
  for (const search of searches) console.log(`${search.key}  ${search.name}`)
}

async function runCollections(options) {
  const { rows, total } = await paginatedJson(`${libraryPrefix(options.library)}/collections?format=json&limit=200`)
  const tree = buildCollectionTree(rows)
  if (options.json) {
    console.log(JSON.stringify({ total, collections: tree }, null, 2))
    return
  }
  console.log(`collections: ${total} in ${tree.length} root(s); the number after the key is its item count`)
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      console.log(`${'  '.repeat(depth)}${node.key}  ${String(node.count).padStart(5)}  ${node.name}`)
      walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
}

/**
 * One collection's members, as records unless `--all-rows` asks for every member.
 *
 * A note filed in a collection is a member in its own right, so the rows arrive mixed and nothing is
 * collapsed onto a parent - but a listing of papers is what a reader wants, and measured, "+04-2"
 * answers 56 rows for its 12 records: a row-sized page of ten showed ten notes and no papers. So
 * `--limit` counts RECORDS, and the notes and attachments are counted and named rather than printed.
 *
 * @param {object} options The parsed command line.
 * @returns {Promise<void>} Prints the listing.
 */
async function runCollectionItems(options) {
  const base = `${libraryPrefix(options.library)}/collections/${options.value}/items?format=json`
  const shown = []
  let records = 0
  let scanned = 0
  let total = 0
  for (let start = 0; start < LISTING_SCAN; start += SCREEN_PAGE) {
    const page = await paginatedJson(`${base}&limit=${SCREEN_PAGE}&start=${start}`)
    total = page.total
    for (const row of page.rows) {
      scanned += 1
      const itemType = row.data?.itemType
      if (!options.allRows && (itemType === 'note' || itemType === 'attachment')) continue
      records += 1
      if (shown.length < options.limit) shown.push(row)
    }
    if (scanned >= total || shown.length >= options.limit) break
  }
  const complete = scanned >= total
  const hidden = scanned - records
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          collection: options.value,
          total,
          scanned,
          complete,
          records: options.allRows ? undefined : records,
          hidden: options.allRows ? undefined : hidden,
          shown: shown.length,
          items: shown.map((row) => itemForJson(row.data ?? {})),
        },
        null,
        2,
      ),
    )
    return
  }
  console.log(
    `collection: ${options.value} · ${total} row(s)${complete ? '' : ` · ${scanned} read`}` +
      (options.allRows ? '' : ` · ${records} record(s) · ${hidden} note/attachment hidden`),
  )
  if (shown.length === 0) {
    console.log(`\n0 ${options.allRows ? 'items' : 'records'} in this collection.`)
    return
  }
  console.log('')
  shown.forEach((row, index) => {
    const data = row.data ?? {}
    const label = `[${data.itemType ?? 'unknown type'}]`
    const year = yearOf(data.date) || '????'
    const title = data.title || (data.itemType === 'note' ? '(a note - read it in the application)' : '(no title)')
    const parent = data.parentItem ? `   parent ${data.parentItem}` : ''
    console.log(`${index + 1}. ${row.key}  ${year}  ${label}  ${title}${parent}`)
  })
  // A listing that silently stops reads as "this is the collection". Measured: one collection reported
  // 34 items in the tree and the default page listed 10 of them.
  if (!complete || shown.length < records) {
    console.log('')
    const what = options.allRows ? 'row(s)' : 'record(s)'
    console.log(
      `truncated : showing ${shown.length} of ${records} ${what}` +
        (complete ? '' : `, read from the first ${scanned} of ${total} rows`) +
        ' - the rest are NOT listed. Raise --limit' +
        (options.allRows ? '.' : ', or use --screen to read the whole collection.'),
    )
  }
}

/**
 * Every row of one collection, paged.
 *
 * Measured 2026-10-19 against this library: `start` IS honoured (`start=5` and `start=12` answered
 * different rows), so a collection larger than one page can be enumerated rather than truncated. A
 * parent collection does NOT include its subcollections' items — asked for one whose children held
 * items, the endpoint answered total 0 — so a pass that wants a subtree has to name each collection.
 *
 * @param {string} key A collection key.
 * @returns {Promise<{rows: object[], total: number, complete: boolean}>} Rows in library order, the
 *   library's own total, and whether every one of them was read.
 */
async function collectionRows(key, library = PERSONAL_LIBRARY) {
  const rows = []
  let total = 0
  for (let start = 0; start < SCREEN_CAP; start += SCREEN_PAGE) {
    const page = await paginatedJson(
      `${libraryPrefix(library)}/collections/${key}/items?format=json&limit=${SCREEN_PAGE}&start=${start}`,
    )
    total = page.total
    rows.push(...page.rows)
    if (page.rows.length < SCREEN_PAGE || rows.length >= total) break
  }
  return { rows, total, complete: rows.length >= total }
}

/**
 * A collection's rows as a screening pass: every record once, with its abstract cut to a fixed length.
 *
 * A note filed in a collection is a member in its own right, so the rows arrive mixed and the pass
 * separates them rather than collapsing a note onto "its" record — a screening pass judges records, and
 * a note has no abstract to judge by.
 *
 * @param {object[]} rows Rows as the collection endpoint returns them.
 * @param {{limit?: number}} [options] Characters of abstract kept per record.
 * @returns {{records: Array<{key: string, year: string, itemType: string, title: string, excerpt: string, characters: number}>,
 *   skipped: {note: number, attachment: number}, budget: number, withAbstract: number}} The records in
 *   library order, what was skipped, the characters of abstract text the pass will print, and how many
 *   records carry one.
 */
export function screenRows(rows, { limit = DEFAULT_SCREEN_LIMIT } = {}) {
  const skipped = { note: 0, attachment: 0 }
  const records = []
  for (const row of rows) {
    const data = row.data ?? {}
    const type = data.itemType
    if (type === 'note' || type === 'attachment') {
      skipped[type] += 1
      continue
    }
    const abstract = visibleText(data.abstractNote ?? '')
    const excerpt = abstract.length > limit ? `${abstract.slice(0, limit)}…` : abstract
    records.push({
      key: row.key,
      year: yearOf(data.date) || '????',
      itemType: type ?? 'unknown',
      title: data.title || '(no title)',
      excerpt,
      characters: excerpt.length,
    })
  }
  return {
    records,
    skipped,
    budget: records.reduce((sum, record) => sum + record.characters, 0),
    withAbstract: records.filter((record) => record.excerpt !== '').length,
  }
}

/**
 * One collection as a screening pass: every record once, with its abstract cut to a fixed length.
 *
 * The pass says what it read and what it skipped, and claims nothing about an attachment: whether a
 * record has readable text needs its children, which is the reading round's errand, not this one's.
 */
async function runCollectionScreening(options) {
  const { rows, total, complete } = await collectionRows(options.value, options.library)
  const name = await readCollection(options.value, { library: options.library })
    .then((data) => data?.name ?? '')
    .catch(() => '')
  const { records, skipped, budget, withAbstract } = screenRows(rows, { limit: options.screenLimit })

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          collection: { key: options.value, name },
          total,
          rows: rows.length,
          complete,
          skipped,
          budget,
          records,
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(
    `collection : ${options.value}  "${name}"  · total ${total} rows · showing 1-${rows.length}` +
      (complete ? '' : '   INCOMPLETE'),
  )
  console.log(
    `records    : ${records.length} of ${rows.length} rows are records; ${skipped.note} note(s), ${skipped.attachment} attachment(s) skipped`,
  )
  console.log(`abstracts  : ${withAbstract}/${records.length} have one`)
  console.log(`budget     : ~${budget.toLocaleString('en-US')} characters of abstract text`)
  if (!complete) {
    console.log(
      `incomplete : the pass stopped at ${rows.length} of ${total} rows (cap ${SCREEN_CAP}); this is NOT the whole collection`,
    )
  }
  if (records.length === 0) {
    console.log('\n0 records in this collection.')
    return
  }
  console.log('')
  records.forEach((record, index) => {
    console.log(
      `${String(index + 1).padStart(2)}. ${record.key}  ${record.year}  ${record.itemType}  ${record.title}`,
    )
    console.log(`    abs: ${record.excerpt || '(no abstract)'}`)
  })
  console.log('')
  console.log(
    'not claimed : whether a record has a readable attachment - that needs its children, which this pass does not read.',
  )
}

async function runTags(options) {
  const { rows, total } = await paginatedJson(`${libraryPrefix(options.library)}/tags?format=json&limit=100`)
  const tags = rows.map((row) => ({
    tag: row.tag,
    count: row.meta?.numItems ?? 0,
    automatic: row.meta?.type === 1,
  }))
  if (options.json) {
    console.log(JSON.stringify({ total, tags }, null, 2))
    return
  }
  console.log(`tags    : ${total} in the library, showing ${tags.length}, most used first`)
  for (const entry of [...tags].sort((a, b) => b.count - a.count)) {
    console.log(`${String(entry.count).padStart(5)}  ${entry.automatic ? '[auto]' : '      '} ${entry.tag}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  await printIdentity(options.json)
  if (options.library.type !== 'user' || options.library.id !== 0) {
    const write = options.json ? console.error : console.log
    write(`shelf   : ${options.library.type}:${options.library.id}`)
  }
  const modes = {
    search: runSearch,
    item: runItem,
    fulltext: runFulltext,
    retrieve: runRetrieve,
    locate: runLocate,
    collections: runCollections,
    collection: options.screen ? runCollectionScreening : runCollectionItems,
    tags: runTags,
    changes: runChanges,
    'item-types': runItemTypes,
    'item-fields': runItemFields,
    'saved-searches': runSavedSearches,
    'find-doi': runFindDoi,
  }
  await modes[options.mode](options)
}

// NOT `await main()`. This module is a command, and the self-test imports its pure functions; a
// pending top-level await here would leave an importable module mid-evaluation.
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  main().catch((error) => {
    process.exitCode = reportFailure(error, { usage: USAGE })
  })
}
