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
import { UsageError, reportFailure } from './refusal.mjs'

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

async function resolve() {
  const arxiv = value('arxiv')
  const doi = value('doi')
  if (arxiv) return { source: `arXiv ${arxiv}`, meta: await metadataFromArxiv(arxiv) }
  if (doi) return { source: `DOI ${doi}`, meta: await metadataFromCrossref(doi) }
  throw new UsageError('pass --arxiv <id> or --doi <doi>')
}

/** Build the payload without writing anything. Shared by the dry run, the write and the test. */
async function buildPayload(meta) {
  const template = await emptyItem(meta.itemType)
  const creatorType = await creatorTypeFor(meta.itemType)
  const withCreators = { ...meta, creators: meta.creators.map((c) => ({ ...c, creatorType })) }
  return fillTemplate(template, withCreators)
}

async function run() {
  // Refused before the first request, so a bad argument costs no authorization dialog and no network.
  const wanted = parseCollectionKeys(argv)
  const keyProblems = collectionKeyProblems(wanted)
  if (keyProblems.length) throw new Error(keyProblems.join('; '))

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
  log(`[2] ${source} -> "${meta.title}" (${meta.creators.length} creators, ${meta.date || 'no date'})`)

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

  const { item: bare, used, dropped } = await buildPayload(meta)
  const item = withCollections(bare, wanted)
  log(`[3] item type ${meta.itemType}: filled ${used.length} field(s): ${used.join(', ')}`)
  if (dropped.length) log(`    dropped (not valid for this type): ${dropped.join(', ')}`)

  log('[4] payload:')
  log(JSON.stringify([item], null, 2).split('\n').map((l) => `    ${l}`).join('\n'))

  const existing = await findExisting(meta)
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
  const titleOk = back.title === item.title
  const doiOk = !item.DOI || back.DOI === item.DOI
  const creatorsOk = (back.creators ?? []).length === item.creators.length
  const unfiled = unfiledCollections(wanted, back.collections)
  const filingNote =
    wanted.length === 0
      ? 'not asked'
      : unfiled.length === 0
        ? `matches (${wanted.join(' · ')})`
        : `MISSING (${unfiled.join(' · ')})`
  log(
    `[7] read-back: title ${titleOk ? 'matches' : `MISMATCH ("${back.title}")`}, ` +
      `DOI ${doiOk ? 'matches' : 'MISMATCH'}, creators ${creatorsOk ? `matches (${item.creators.length})` : 'MISMATCH'}, ` +
      `filing ${filingNote}`,
  )
  if (!titleOk || !doiOk || !creatorsOk) {
    process.exitCode = reportUnconfirmed({
      key: itemKey,
      what: `the record was created and does not read back as sent (title ${titleOk ? 'ok' : 'differs'}, DOI ${
        doiOk ? 'ok' : 'differs'
      }, creators ${creatorsOk ? 'ok' : 'differ'})`,
      found: 'Read it before editing it: a second create would leave two records for one paper.',
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
  log(`\nOK — "${back.title}" is now in the library (key ${itemKey}${where}).`)
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
if (isEntryPoint) {
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
