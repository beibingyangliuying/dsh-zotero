#!/usr/bin/env node
// Add one reference to the local Zotero library through Zotero's own local API.
//
// Safety model:
//   * the DEFAULT is a dry run — it resolves metadata, builds the payload and prints it;
//   * `--write` is required to create anything;
//   * no key is written down unless the owner answers "Always Allow": the reference manager's
//     dialog is the gate, and declining it is a normal outcome rather than a bug.
//
// Transport and the write gate live in ./zotero-local-api.mjs, together with the reason these calls
// go through node:http with no timeout instead of fetch.
//
// ONE WRITE, AND WHAT IT DOES NOT COVER
//
//   * `--collection <key>` puts the new record into that collection as part of the SAME create: the
//     create body carries `collections`, so it is one write and one authorization, and the read-back
//     below is what decides whether the library kept the filing. **The filing through a create is not
//     measured in this repository** - the local API mirrors the web API's item shape, but nobody here
//     has watched a record created with `collections` come back carrying them. So the tool does not
//     claim the filing: it reports it, and when the read-back has none it prints `UNFILED`, names the
//     record that now exists, and gives the one command that files it. It never writes a second time
//     to cover for a create, because then "one invocation, one change" would be a lie the next reader
//     has to disprove.
//   * an unknown or malformed collection key is refused BEFORE anything is written, and a collection
//     NAME is not accepted: two collections may share a name under different parents, and guessing
//     which one was meant is how a paper lands in the wrong folder.
//   * no attachment is written. `docs/decisions.md` §329 refused `--attach`; a record with no PDF is
//     what this path produces, and the reading tools say so rather than pretending otherwise.
//
// Usage:
//   node tools/zotero-write.mjs --arxiv 1706.03762            # dry run
//   node tools/zotero-write.mjs --arxiv 1706.03762 --write
//   node tools/zotero-write.mjs --doi 10.1371/journal.pone.0171234 --write
//   node tools/zotero-write.mjs --doi 10.1371/journal.pone.0171234 --collection ABCDEFGH --write
//   node tools/zotero-write.mjs --item-type book --field title="..." --creator "Last, First" --write
//   node tools/zotero-write.mjs --note "<p>body</p>" --parent ABCDEFGH --write
//   node tools/zotero-write.mjs --selftest                    # no writes, checks the seams
//
// Exit codes: 0 created and read back, or nothing to do (a dry run, or a record already in the
// library) | 1 refused, nothing written | 2 usage | 3 sent or written but unconfirmed - a record may
// exist, so search for it rather than creating it again. `UNFILED` is 3: the record exists and only
// the filing did not stick.
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_NAME,
  createWriteGate,
  getJson,
  localRequest,
  mayHaveLanded,
  normalizeCollections,
  readItem,
  reportUnconfirmed,
  serverInfo,
} from './zotero-local-api.mjs'
import { UsageError, reportFailure, reportHelp, wantsHelp } from './refusal.mjs'

const USAGE =
  'usage: node tools/zotero-write.mjs --arxiv <id> [--collection <key> ...] [--force] [--write]\n' +
  '       node tools/zotero-write.mjs --doi <doi> [--collection <key> ...] [--force] [--write]\n' +
  '       node tools/zotero-write.mjs --item-type <type> --field k=v [--field k=v ...]\n' +
  '                                   [--creator "Last, First" ...] [--tag <tag> ...]\n' +
  '                                   [--collection <key> ...] [--force] [--write]\n' +
  '       node tools/zotero-write.mjs --note <html> [--parent <key>] [--write]\n' +
  '       node tools/zotero-write.mjs --selftest\n' +
  '       a dry run unless --write is given; a record already in the library is left alone unless\n' +
  '       --force is passed. Exit 3 means a record may exist: search for it before creating it again.'

/** Set immediately before the create is sent, so a failure after that point is never called a refusal. */
let writeAttempted = false

// Optional polite-pool contact address for the metadata APIs. Set AUTORESEARCH_MAILTO in the
// environment, or pass --mailto <address>; without one the requests are still valid, just
// unpolite (slower, and more likely to be rate-limited).
// Declared lazily: the CLI argument helpers below are initialized after this block.
const contactAddress = () => process.env.AUTORESEARCH_MAILTO ?? value('mailto') ?? ''

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : (argv[i + 1] ?? null)
}
/** Every value given to one repeatable flag, in order. */
const values = (name) => {
  const found = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}` && argv[index + 1] !== undefined) found.push(argv[index + 1])
  }
  return found
}
const log = (...parts) => console.log(...parts)

/** The shape of a Zotero object key: eight characters, uppercase letters and digits. */
const KEY_SHAPE = /^[A-Z0-9]{8}$/

/**
 * The filing tool, as an ABSOLUTE path.
 *
 * Every command this program prints is meant to be run by an agent working in a study workspace, where
 * a relative `tools/...` resolves to nothing (`INV-HELPER-1`). So the path is taken from where this file
 * actually lives rather than written down.
 */
const COLLECTION_TOOL = fileURLToPath(new URL('./zotero-collection.mjs', import.meta.url))

/**
 * Collections named with `--collection`, uppercased, deduplicated, in first-seen order.
 *
 * @param {string[]} args Command-line arguments.
 * @returns {string[]} One entry per distinct collection; `''` marks a flag with no value, which
 *   {@link collectionKeyProblems} then refuses rather than dropping silently.
 */
export function parseCollectionKeys(args) {
  const keys = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--collection') continue
    const next = args[index + 1]
    keys.push(next === undefined || next.startsWith('--') ? '' : next.trim().toUpperCase())
  }
  return [...new Set(keys)]
}

/**
 * Why a set of collection keys cannot be used, if it cannot.
 *
 * @param {string[]} keys As {@link parseCollectionKeys} returns them.
 * @returns {string[]} One message per bad key; empty when every key is usable.
 */
export function collectionKeyProblems(keys) {
  const problems = []
  for (const key of keys) {
    if (key === '') problems.push('--collection needs a value')
    else if (!KEY_SHAPE.test(key)) {
      problems.push(`--collection "${key}" is not an eight-character key (node "${COLLECTION_TOOL}" --list prints them)`)
    }
  }
  return problems
}

/**
 * Fields that a manual create cannot take as `--field`, each with the flag that does express it.
 *
 * The library calls every one of these structured or assigned, so a bare string would either be
 * rejected or silently lose the structure - exactly the kind of write this tool refuses.
 */
export const REFUSED_MANUAL_FIELDS = {
  itemType: 'the type is its own flag: --item-type <type>',
  creators: 'use --creator "Last, First" (repeatable)',
  tags: 'use --tag <tag> (repeatable)',
  collections: 'use --collection <key> (repeatable)',
  key: 'the library assigns the key',
  version: 'the library assigns the version',
}

/**
 * Read `--field field=value` arguments for a manual create.
 *
 * @param {string[]} args Command-line arguments.
 * @returns {Record<string, string>} field -> value, later flags winning.
 * @throws {UsageError} For a missing value, a missing `=`, or a structured field.
 */
export function parseFieldFlags(args) {
  const fields = {}
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--field') continue
    const assignment = args[index + 1]
    if (assignment === undefined || assignment.startsWith('--')) throw new UsageError('--field needs field=value')
    const split = assignment.indexOf('=')
    if (split === -1) throw new UsageError(`--field takes field=value, got '${assignment}'`)
    const field = assignment.slice(0, split).trim()
    const content = assignment.slice(split + 1)
    if (REFUSED_MANUAL_FIELDS[field]) {
      throw new UsageError(`--field cannot set '${field}': ${REFUSED_MANUAL_FIELDS[field]}`)
    }
    fields[field] = content
  }
  return fields
}

/**
 * One `--creator` value as Zotero's creator shape.
 *
 * "Last, First" is the only form that states the family name unambiguously, so a comma flips the
 * order; without one the last word is taken as the family name, which is what the metadata resolvers
 * above do with the names they receive.
 *
 * @param {string} text A person's name.
 * @returns {object} `{creatorType, lastName, firstName}` or `{creatorType, name}` for one-word names.
 * @throws {UsageError} When the value is empty.
 */
export function creatorFromExpression(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') throw new UsageError('--creator needs a name')
  if (raw.includes(',')) {
    const [last, ...rest] = raw.split(',')
    return { creatorType: 'author', lastName: last.trim(), firstName: rest.join(',').trim() }
  }
  return splitName(raw)
}

/**
 * The POST body for a note.
 *
 * @param {string} html The note body.
 * @param {string} [parentItem] The record it is filed under; `''` makes a standalone note.
 * @returns {object} The body to POST.
 */
export function notePayload(html, parentItem = '') {
  return parentItem ? { itemType: 'note', note: html, parentItem } : { itemType: 'note', note: html }
}

/**
 * The create body, with the filing added.
 *
 * `collections` is not a schema field of any item type - `/itemTypeFields` does not list it and
 * {@link fillTemplate} therefore drops it - so it is attached here, after the template is filled.
 *
 * @param {object} item The filled template.
 * @param {string[]} keys Collections to file the new record into; none leaves the field off the body.
 * @returns {object} The body to POST.
 */
export function withCollections(item, keys) {
  return keys.length === 0 ? item : { ...item, collections: [...keys] }
}

/**
 * Collections asked for that the record does not read back as filed in.
 *
 * @param {string[]} expected The keys the create body carried.
 * @param {string|string[]|false|null|undefined} filed The record's `collections` as read back.
 * @returns {string[]} The missing keys; empty when the filing stuck.
 */
export function unfiledCollections(expected, filed) {
  const have = normalizeCollections(filed)
  return expected.filter((key) => !have.includes(key))
}

/**
 * Collection keys the library does not have.
 *
 * @param {string[]} keys Keys to look for.
 * @param {object[]} rows Collection rows as `/collections` returns them.
 * @returns {string[]} The unknown keys; empty when every key exists.
 */
export function unknownCollections(keys, rows) {
  const known = new Set(rows.map((row) => row.key))
  return keys.filter((key) => !known.has(key))
}

/** The local API has no /items/new template endpoint; ask it which fields the type accepts. */
async function emptyItem(itemType) {
  const res = await localRequest('GET', `/api/itemTypeFields?itemType=${itemType}`)
  if (res.status !== 200) throw new Error(`itemTypeFields for ${itemType} answered ${res.status}`)
  const item = { itemType, creators: [] }
  for (const field of JSON.parse(res.text)) item[field.field] = ''
  return item
}

/** Use a creator type the schema actually allows for this item type. */
async function creatorTypeFor(itemType, preferred = 'author') {
  const res = await localRequest('GET', `/api/itemTypeCreatorTypes?itemType=${itemType}`)
  if (res.status !== 200) return preferred
  const allowed = JSON.parse(res.text).map((c) => c.creatorType)
  return allowed.includes(preferred) ? preferred : (allowed[0] ?? preferred)
}

/** Split a display name into Zotero's two-field creator shape. */
function splitName(name) {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return { creatorType: 'author', name: parts[0] }
  return { creatorType: 'author', firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) }
}

async function metadataFromArxiv(arxivId) {
  const res = await fetch(`http://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`)
  if (!res.ok) throw new Error(`arXiv answered ${res.status}`)
  const xml = await res.text()
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1]
  if (!entry) throw new Error(`no entry for arXiv id ${arxivId}`)
  const pick = (tag) =>
    entry
      .match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]
      ?.replace(/\s+/g, ' ')
      .trim()
  const title = pick('title')
  if (!title) throw new Error('arXiv entry has no title')
  const journalRef = pick('arxiv:journal_ref')
  return {
    itemType: 'preprint',
    title,
    creators: [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => splitName(m[1])),
    abstractNote: pick('summary') ?? '',
    date: (pick('published') ?? '').slice(0, 10),
    repository: 'arXiv',
    archiveID: `arXiv:${arxivId}`,
    url: `https://arxiv.org/abs/${arxivId}`,
    DOI: pick('arxiv:doi') ?? '',
    extra: journalRef ? `arXiv journal ref: ${journalRef}` : '',
  }
}

async function metadataFromCrossref(doi) {
  const contact = contactAddress() ? `?mailto=${encodeURIComponent(contactAddress())}` : ''
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}${contact}`)
  if (!res.ok) throw new Error(`Crossref answered ${res.status} for ${doi}`)
  const m = (await res.json()).message
  const date = m.issued?.['date-parts']?.[0] ?? []
  return {
    itemType: 'journalArticle',
    title: (m.title ?? [])[0] ?? '',
    creators: (m.author ?? []).map((a) =>
      a.name
        ? { creatorType: 'author', name: a.name }
        : { creatorType: 'author', firstName: a.given ?? '', lastName: a.family ?? '' },
    ),
    abstractNote: (m.abstract ?? '').replace(/<[^>]+>/g, '').trim(),
    date: date.length ? date.join('-') : '',
    publicationTitle: (m['container-title'] ?? [])[0] ?? '',
    volume: m.volume ?? '',
    issue: m.issue ?? '',
    pages: m.page ?? '',
    DOI: m.DOI ?? doi,
    url: m.URL ?? '',
    language: m.language ?? '',
    ISSN: (m.ISSN ?? []).join(', '),
  }
}

/** Copy only the fields the item type actually accepts, so no invalid field is ever sent. */
function fillTemplate(template, source) {
  const item = { ...template }
  const used = []
  const dropped = []
  for (const [key, val] of Object.entries(source)) {
    if (key === 'itemType') continue
    if (val === undefined || val === null || val === '' || (Array.isArray(val) && val.length === 0)) continue
    if (key in template) {
      item[key] = val
      used.push(key)
    } else {
      dropped.push(key)
    }
  }
  return { item, used, dropped }
}

/** Create one item. The gate owns authorization, the key and the per-write token. */
async function createItem(item, gate) {
  const res = await gate.write('POST', '/api/users/0/items', [item])
  if (res.status === 401) throw new Error('401 Unauthorized — the key was rejected; run again')
  // Not thrown for a server-side failure: the POST may still have created the record, and the caller
  // is the only place that can search for it before saying "nothing was written".
  return { status: res.status, text: res.text }
}

/** Refuse to create a second copy of something already in the library. */
async function findExisting(meta) {
  const query = (meta.title || '').split(/\s+/).slice(0, 6).join(' ')
  if (!query) return null
  const res = await localRequest('GET', `/api/users/0/items?q=${encodeURIComponent(query)}&limit=25`)
  if (res.status !== 200) return null
  const hits = JSON.parse(res.text)
  if (!Array.isArray(hits)) return null
  const hit = hits.find(
    (h) =>
      h.data?.title === meta.title ||
      (meta.DOI && h.data?.DOI === meta.DOI) ||
      (meta.archiveID && h.data?.archiveID === meta.archiveID),
  )
  return hit ? { key: hit.key, title: hit.data.title } : null
}

/** Rows per request when the collection keys are checked. The library's own page size for `/items`. */
const COLLECTION_PAGE = 200

/** A ceiling on that list, so an endpoint that ignores `start` stops loudly instead of looping. */
const COLLECTION_CAP = 20 * COLLECTION_PAGE

/**
 * Every collection in the library, paged.
 *
 * A key is checked against this list before anything is written, because a create that carries an
 * unknown key would be refused by the library AFTER the authorization dialog, which reads to the owner
 * as a broken tool rather than as a bad argument.
 *
 * @returns {Promise<object[]>} Collection rows.
 */
async function allCollections() {
  const rows = []
  for (let start = 0; ; start += COLLECTION_PAGE) {
    const page = await getJson(`/api/users/0/collections?format=json&limit=${COLLECTION_PAGE}&start=${start}`)
    if (!Array.isArray(page)) throw new Error('the collections endpoint did not answer a list')
    rows.push(...page)
    if (page.length < COLLECTION_PAGE) return rows
    if (rows.length >= COLLECTION_CAP) {
      throw new Error(
        `the collection list stopped at ${rows.length} rows (cap ${COLLECTION_CAP}) — this endpoint may be ignoring start, ` +
          'so no key has been checked and nothing was written',
      )
    }
  }
}

/** The sources named by the flags, so two of them are refused rather than silently picking one. */
function sourceFlags() {
  const present = []
  if (value('arxiv')) present.push('arxiv')
  if (value('doi')) present.push('doi')
  if (value('item-type')) present.push('manual')
  if (argv.includes('--note')) present.push('note')
  return present
}

/** A manual record: the type plus the fields, creators and tags the caller stated. */
function manualMeta(itemType) {
  if (!/^[A-Za-z]+$/.test(itemType)) throw new UsageError(`'${itemType}' is not an item type name`)
  const fields = parseFieldFlags(argv)
  if (!fields.title) throw new UsageError('a manual record needs at least --field title=...')
  if (value('parent')) throw new UsageError('--parent only applies to --note')
  return {
    itemType,
    ...fields,
    creators: values('creator').map(creatorFromExpression),
    tags: values('tag').map((tag) => ({ tag })),
    manual: true,
  }
}

async function resolve() {
  const sources = sourceFlags()
  if (sources.length === 0) {
    throw new UsageError('pass --arxiv <id>, --doi <doi>, --item-type <type> with --field, or --note <html>')
  }
  if (sources.length > 1) throw new UsageError(`pass ONE source, not ${sources.join(' + ')}`)
  const [source] = sources
  if (source === 'arxiv') return { source: `arXiv ${value('arxiv')}`, meta: await metadataFromArxiv(value('arxiv')) }
  if (source === 'doi') return { source: `DOI ${value('doi')}`, meta: await metadataFromCrossref(value('doi')) }
  if (source === 'manual') return { source: `manual ${value('item-type')}`, meta: manualMeta(value('item-type')) }
  if (value('creator') !== null || values('tag').length > 0) {
    throw new UsageError('--creator and --tag apply to --item-type, not --note')
  }
  const html = value('note') ?? ''
  if (html === '') throw new UsageError('--note needs the note body (HTML)')
  const parentItem = value('parent') ?? ''
  if (parentItem && !KEY_SHAPE.test(parentItem)) {
    throw new UsageError(`--parent "${parentItem}" is not an eight-character item key`)
  }
  return {
    source: `note (${html.length} characters)`,
    meta: { itemType: 'note', title: '', creators: [], noteItem: true, note: html, parentItem },
  }
}

/** Build the payload without writing anything. Shared by the dry run, the write and the test. */
async function buildPayload(meta) {
  const template = await emptyItem(meta.itemType)
  const creatorType = await creatorTypeFor(meta.itemType)
  // `tags` and the bookkeeping flags are not schema fields: tags are attached after the template is
  // filled, and the flags would otherwise be reported as fields the type dropped.
  const { tags, manual, noteItem, note, parentItem, ...fields } = meta
  const withCreators = { ...fields, creators: meta.creators.map((c) => ({ ...c, creatorType })) }
  return fillTemplate(template, withCreators)
}

async function run() {
  // Refused before the first request, so a bad argument costs no authorization dialog and no network.
  const wanted = parseCollectionKeys(argv)
  const keyProblems = collectionKeyProblems(wanted)
  if (keyProblems.length) throw new UsageError(keyProblems.join('; '))

  const gate = createWriteGate({
    appName: APP_NAME,
    onAuthorized: ({ remember }) =>
      log(
        remember
          ? '    authorized for this library: the grant is kept, so later writes need no dialog'
          : '    authorized for this one write: the key is spent by it and is not written down',
      ),
    onGrantDropped: () => log('    the kept authorization was refused (revoked in the reference manager?) — forgotten'),
  })
  const { id: serverId, version, kept } = await gate.open()
  log(`[1] Zotero ${version}, server id ${serverId}${kept ? ' — a kept authorization is on file' : ''}`)

  const { source, meta } = await resolve()
  log(
    `[2] ${source} -> ${
      meta.noteItem
        ? `note${meta.parentItem ? ` under ${meta.parentItem}` : ' (standalone)'}`
        : `"${meta.title}" (${meta.creators.length} creators, ${meta.date || 'no date'})`
    }`,
  )

  if (meta.noteItem && wanted.length) throw new UsageError('a note is filed with its parent; --collection does not apply')

  if (wanted.length) {
    const rows = await allCollections()
    const unknown = unknownCollections(wanted, rows)
    if (unknown.length) {
      throw new Error(
        `no collection ${unknown.join(' · ')} in this library — node "${COLLECTION_TOOL}" --list prints the keys`,
      )
    }
    const names = wanted.map((key) => `${key} "${rows.find((row) => row.key === key)?.data?.name ?? '(unnamed)'}"`)
    log(`    filing    : ${names.join(' · ')} — carried by this create, not a second write`)
  }

  let item
  let used = []
  let dropped = []
  if (meta.noteItem) {
    if (meta.parentItem) {
      const parent = await readItem(meta.parentItem)
      if (parent.itemType === 'note') throw new UsageError('a note cannot be filed under another note')
    }
    item = notePayload(meta.note, meta.parentItem)
  } else {
    const { item: bare, used: filled, dropped: lost } = await buildPayload(meta)
    used = filled
    dropped = lost
    item = withCollections(bare, wanted)
    if (meta.tags?.length) item = { ...item, tags: meta.tags }
  }
  log(`[3] item type ${item.itemType}: filled ${used.length} field(s)${used.length ? `: ${used.join(', ')}` : ''}`)
  if (dropped.length) {
    if (meta.manual) throw new UsageError(`--field names fields this type does not have: ${dropped.join(', ')}`)
    log(`    dropped (not valid for this type): ${dropped.join(', ')}`)
  }

  log('[4] payload:')
  log(JSON.stringify([item], null, 2).split('\n').map((l) => `    ${l}`).join('\n'))

  const existing = meta.noteItem ? null : await findExisting(meta)
  if (existing) log(`[!] already in the library as ${existing.key} — "${existing.title}"`)

  if (!flag('write')) {
    log('\nDRY RUN — nothing was written. Re-run with --write to create the item.')
    return
  }

  if (existing && !flag('force')) {
    // Exit 0, not 1: the state this invocation asks for already holds, which is the answer `zotero-edit`
    // gives for "No change" and the one docs/decisions.md §40 ruled for an already-recorded digest. The
    // word that must NOT appear is "refused" - the exit codes reserve that for a write the library
    // rejected, and a refusal here would read as "nothing exists" to a caller that needs the key.
    log(`\nALREADY IN THE LIBRARY: the record is ${existing.key}. Nothing was written.`)
    log('Pass --force only if a second copy is really wanted.')
    return
  }

  log(
    kept
      ? '\n[5] writing under the authorization already on file — no dialog this time'
      : '\n[5] asking the reference manager for authorization — its dialog will appear',
  )
  if (!kept) log('    (this request waits for you; it has no timeout)')

  writeAttempted = true
  const created = await createItem(item, gate)
  const body = created.status === 200 ? JSON.parse(created.text) : null
  // An array POST answers with the saved object; a single-object POST answers with the key.
  const saved = body?.successful?.['0'] ?? body?.success?.['0']
  const itemKey = typeof saved === 'string' ? saved : saved?.key
  if (!itemKey) {
    if (!mayHaveLanded(created.status) && created.status !== 200) {
      console.error(`\nThe library refused the create (HTTP ${created.status}): ${created.text.slice(0, 300)}`)
      process.exitCode = 1
      return
    }
    // No key came back and the request was sent: search before concluding anything, because a second
    // create is exactly the duplicate this tool exists to refuse.
    const again = await findExisting(item).catch(() => null)
    process.exitCode = reportUnconfirmed({
      key: again?.key ?? '',
      what: `the create answered ${created.status === 200 ? 'success without a key' : `HTTP ${created.status}`}`,
      found: again
        ? `The search finds "${again.title}" as ${again.key}: the record exists, and nothing else was created.`
        : 'The search finds no such record, but the request was sent - search again before creating it twice.',
    })
    return
  }
  log(`[6] created item ${itemKey}`)

  const back = await readItem(itemKey)
  const checks = meta.noteItem
    ? [{ label: 'note body', ok: String(back.note ?? '') === meta.note, detail: '' }]
    : [
        { label: 'title', ok: back.title === item.title, detail: ` ("${back.title}")` },
        { label: 'DOI', ok: !item.DOI || back.DOI === item.DOI, detail: '' },
        { label: 'creators', ok: (back.creators ?? []).length === item.creators.length, detail: ` (${item.creators.length})` },
      ]
  const unfiled = meta.noteItem ? [] : unfiledCollections(wanted, back.collections)
  const filingNote =
    wanted.length === 0
      ? 'not asked'
      : unfiled.length === 0
        ? `matches (${wanted.join(' · ')})`
        : `MISSING (${unfiled.join(' · ')})`
  log(
    `[7] read-back: ${checks
      .map((check) => `${check.label} ${check.ok ? 'matches' : `MISMATCH${check.detail}`}`)
      .join(', ')}, filing ${filingNote}`,
  )
  const failed = checks.filter((check) => !check.ok)
  if (failed.length > 0) {
    process.exitCode = reportUnconfirmed({
      key: itemKey,
      what: `the record was created and ${failed.map((check) => check.label).join(', ')} does not read back as sent`,
      found: 'Read it before editing it: a second create would leave two records for one work.',
    })
    return
  }
  if (unfiled.length) {
    // The record exists; only the filing is in doubt. Saying "added" here would be the exact lie this
    // tool exists to avoid, and writing again to hide it would break one change per invocation.
    console.error(`\nUNFILED — "${back.title}" IS in the library as ${itemKey}, but the filing did not stick.`)
    console.error(
      `The record reads back as collections ${JSON.stringify(normalizeCollections(back.collections))}; ` +
        `the create body carried ${JSON.stringify(wanted)}.`,
    )
    console.error('Nothing was written a second time, and the create was not retried. File it in one more command:')
    for (const key of unfiled) {
      console.error(`  node "${COLLECTION_TOOL}" --assign ${itemKey} --collection ${key} --write`)
    }
    process.exitCode = 3
    return
  }
  const where = wanted.length === 0 ? '' : `, filed under ${wanted.join(' · ')}`
  log(`\nOK — ${meta.noteItem ? 'the note' : `"${back.title}"`} is now in the library (key ${itemKey}${where}).`)
}

async function selftest() {
  let failures = 0
  const ok = (cond, label, detail = '') => {
    if (!cond) failures += 1
    log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? `  -> ${detail}` : ''}`)
  }

  log('[1] local API and server id')
  try {
    const info = await serverInfo()
    ok(Boolean(info.id), 'server id readable', `Zotero ${info.version}`)
  } catch (error) {
    ok(false, 'server id readable', error.message)
  }

  log('[2] schema: valid fields and creator types')
  for (const type of ['preprint', 'journalArticle']) {
    try {
      const t = await emptyItem(type)
      ok('title' in t && 'creators' in t, `fields for ${type}`, `${Object.keys(t).length} fields`)
      ok((await creatorTypeFor(type)) === 'author', `'author' allowed for ${type}`)
    } catch (error) {
      ok(false, `fields for ${type}`, error.message)
    }
  }

  log('[3] metadata resolvers')
  try {
    const m = await metadataFromArxiv('1706.03762')
    ok(m.title.includes('Attention'), 'arXiv resolver', m.title)
    ok(m.creators.length > 5, 'arXiv creators parsed', `${m.creators.length}`)
    ok(m.archiveID === 'arXiv:1706.03762', "archive id shaped like Zotero's own", m.archiveID)
  } catch (error) {
    ok(false, 'arXiv resolver', error.message)
  }
  try {
    const m = await metadataFromCrossref('10.1371/journal.pone.0171234')
    ok(m.title.length > 10, 'Crossref resolver', m.title.slice(0, 60))
    ok(m.creators.length > 0, 'Crossref creators parsed', `${m.creators.length}`)
  } catch (error) {
    ok(false, 'Crossref resolver', error.message)
  }

  log('[4] payload assembly (no write)')
  try {
    const meta = await metadataFromArxiv('1706.03762')
    const { item, dropped } = await buildPayload(meta)
    ok(item.title === meta.title, 'title carried into payload')
    ok(item.archiveID === 'arXiv:1706.03762', 'archiveID carried into payload')
    ok(Array.isArray(item.creators) && item.creators.length > 5, 'creators carried into payload')
    ok(dropped.length === 0, 'no field dropped for the preprint type', dropped.join(', '))
  } catch (error) {
    ok(false, 'payload assembly', error.message)
  }

  log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
  // Same reason as the CLI catch below: the resolvers above end in `fetch`, and a forced exit while a
  // socket is closing replaces this code with 0xC0000409 on Windows.
  process.exitCode = failures === 0 ? 0 : 1
}

const isEntryPoint = process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)

// Only act when this file IS the command: the unit self-test imports the pure parts above, and an
// import must not create a record.
if (isEntryPoint && wantsHelp(process.argv.slice(2))) {
  process.exitCode = reportHelp(USAGE)
} else if (isEntryPoint) {
  try {
    if (flag('selftest')) await selftest()
    else await run()
  } catch (error) {
    const code = reportFailure(error)
    // NOT `process.exit(1)`: on Windows a forced exit while the transport is still closing a socket
    // trips a libuv assertion (`uv_async`), which replaces exit code 1 with 0xC0000409 and prints an
    // assertion line after the real error. Setting the code and letting the loop drain exits with 1.
    process.exitCode =
      code === 1 && writeAttempted && !error.refused
        ? reportUnconfirmed({
            what: 'the create was sent and then the connection failed: OUTCOME UNKNOWN',
            found: 'The record may exist. Search the library for it before creating it a second time.',
          })
        : code
  }
}
