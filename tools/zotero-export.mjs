#!/usr/bin/env node
// Export records through the reference library's own translator.
//
// WHY THIS FILE EXISTS
//
// A citation written from memory is a fabrication, and the library already owns the only authoritative
// answer: its translator pipeline. The local API exposes three shapes of it - per-record HTML
// citations, a joined bibliography, and the raw translator formats - and this helper is the one place
// that asks for them, so a discipline never has to spell a citation by hand.
//
// The reference manager must be running with its local API enabled. Reads need no authorization.
//
// Usage:
//   node tools/zotero-export.mjs --item <key>[,<key> ...] [--item <key> ...] --format bibtex
//   node tools/zotero-export.mjs --collection <key> --format bibliography [--style apa] [--locale en-US]
//   node tools/zotero-export.mjs --item <key> --format citation
//   formats: citation | bibliography | bibtex | biblatex | ris | csljson | csv
//   [--library user:0|group:<id>] [--json] [--output <path>]
// Exit codes: 0 exported | 1 the library refused, or there is nothing to export | 2 usage.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PERSONAL_LIBRARY,
  itemRef,
  libraryPrefix,
  localRequest,
  parseLibrary,
  requireCollection,
} from './zotero-local-api.mjs'
import { Refusal, UsageError, reportFailure, reportHelp, wantsHelp } from './refusal.mjs'

const FORMATS = ['citation', 'bibliography', 'bibtex', 'biblatex', 'ris', 'csljson', 'csv']
const DEFAULT_STYLE = 'apa'
const DEFAULT_LOCALE = 'en-US'
/** Zotero's own itemKey batched-read cap; a larger set is a second invocation, not a silent split. */
const ITEMKEY_CAP = 50
const COLLECTION_PAGE = 100
const COLLECTION_CAP = 500

const USAGE =
  'usage: node tools/zotero-export.mjs --item <key>[,<key> ...] [--item <key> ...] --format <format>\n' +
  '       node tools/zotero-export.mjs --collection <key> --format <format> [--limit N]\n' +
  `       formats: ${FORMATS.join(' | ')}\n` +
  '       [--style <csl-style>] [--locale <csl-locale>] [--library user:0|group:<id>] [--json]\n' +
  '       [--output <path>]\n' +
  '       --limit applies to a collection export (default 50, at most 100).'

/**
 * Read the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} The options.
 * @throws {UsageError} On a usage error; the CLI turns that into exit code 2.
 */
export function parseArgs(argv) {
  const options = {
    items: [],
    collection: '',
    format: '',
    style: DEFAULT_STYLE,
    locale: DEFAULT_LOCALE,
    limit: ITEMKEY_CAP,
    libraryRaw: '',
    library: PERSONAL_LIBRARY,
    json: false,
    output: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = argv[index + 1]
    switch (flag) {
      case '--item':
        if (!next) throw new UsageError('--item needs a record key')
        options.items.push(...next.split(',').map((key) => key.trim()).filter(Boolean))
        index += 1
        break
      case '--collection':
        if (!next) throw new UsageError('--collection needs a collection key')
        if (options.collection) throw new UsageError('pass one --collection')
        options.collection = next
        index += 1
        break
      case '--format':
        if (!FORMATS.includes(next)) throw new UsageError(`--format takes ${FORMATS.join(' | ')}, got '${next}'`)
        options.format = next
        index += 1
        break
      case '--style':
        if (!next) throw new UsageError('--style needs a CSL style id')
        options.style = next
        index += 1
        break
      case '--locale':
        if (!next) throw new UsageError('--locale needs a CSL locale')
        options.locale = next
        index += 1
        break
      case '--limit': {
        const parsed = Number(next)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > ITEMKEY_CAP) {
          throw new UsageError(`--limit takes an integer between 1 and ${ITEMKEY_CAP}, got '${next}'`)
        }
        options.limit = parsed
        index += 1
        break
      }
      case '--library':
        options.libraryRaw = next ?? ''
        index += 1
        break
      case '--json':
        options.json = true
        break
      case '--output':
        if (!next) throw new UsageError('--output needs a file path')
        options.output = next
        index += 1
        break
      default:
        throw new UsageError(`unrecognised argument '${flag}'`)
    }
  }
  if (!options.format) throw new UsageError(`pass --format <${FORMATS.join('|')}>`)
  if (options.items.length === 0 && options.collection === '') {
    throw new UsageError('pass --item <key> (repeatable) or --collection <key>')
  }
  if (options.items.length > 0 && options.collection !== '') {
    throw new UsageError('pass --item or --collection, not both')
  }
  try {
    options.library = parseLibrary(options.libraryRaw)
  } catch (error) {
    throw new UsageError(error.message)
  }
  return options
}

/**
 * The one path an export asks for.
 *
 * `format=bib` is the bibliography; `include=citation` is the per-record HTML citation; every other
 * format is passed through to the translator under its own name. The key order is the caller's, and
 * Zotero preserves it within one request.
 *
 * @param {string[]} keys The record keys, in citation order.
 * @param {{format: string, style: string, locale: string, library: object}} options The export.
 * @returns {string} The request path.
 */
export function buildExportPath(keys, options) {
  const params = new URLSearchParams()
  params.set('itemKey', keys.join(','))
  if (options.format === 'citation') {
    params.set('include', 'citation')
    params.set('style', options.style)
    params.set('locale', options.locale)
  } else if (options.format === 'bibliography') {
    params.set('format', 'bib')
    params.set('style', options.style)
    params.set('locale', options.locale)
  } else {
    params.set('format', options.format)
  }
  return `${libraryPrefix(options.library)}/items?${params}`
}

/**
 * The records in rows that a citation can name.
 *
 * A note or an attachment is not a work: exporting its children would put a file in a bibliography.
 * Duplicates keep their first position, because the caller's order is the citation order.
 *
 * @param {object[]} rows Rows from an item listing.
 * @returns {string[]} The record keys.
 */
export function selectExportKeys(rows) {
  const seen = new Set()
  const keys = []
  for (const row of rows) {
    const type = row?.data?.itemType
    if (type === 'note' || type === 'attachment') continue
    if (typeof row?.key !== 'string' || row.key === '' || seen.has(row.key)) continue
    seen.add(row.key)
    keys.push(row.key)
  }
  return keys
}

/**
 * Pair each requested key with the citation the library returned for it.
 *
 * The library may answer in a different order, or omit a record; the caller's order is restored and a
 * missing citation is an empty string, which the caller reports rather than printing a blank line.
 *
 * @param {object[]} rows Rows carrying `key` and `citation`.
 * @param {string[]} keys The requested keys, in order.
 * @returns {Array<{key: string, citation: string}>} The citations in request order.
 */
export function orderCitations(rows, keys) {
  const byKey = new Map(rows.map((row) => [row?.key, row?.citation ?? '']))
  return keys.map((key) => ({ key, citation: byKey.get(key) ?? '' }))
}

/** Ask the library for one export. */
async function requestExport(path) {
  const res = await localRequest('GET', path)
  if (res.status === 404) {
    throw new Refusal('the library has no record under one of the keys asked for (404)', {
      fix: 'read the keys again with zotero-read --item; a key copied from a search result is not always the record key',
    })
  }
  if (res.status !== 200) {
    throw new Refusal(`the export answered HTTP ${res.status}: ${res.text.slice(0, 200)}`, {
      fix: 'check that the reference manager is running with its local API enabled, then retry once',
    })
  }
  return res.text
}

/** A collection's records, paged, in library order. */
async function collectionKeys(options) {
  await requireCollection(options.collection, { library: options.library })
  const rows = []
  for (let start = 0; start < COLLECTION_CAP; start += COLLECTION_PAGE) {
    const path =
      `${libraryPrefix(options.library)}/collections/${options.collection}/items` +
      `?format=json&limit=${COLLECTION_PAGE}&start=${start}`
    const res = await localRequest('GET', path)
    if (res.status !== 200) {
      throw new Refusal(`the collection listing answered HTTP ${res.status}`, {
        fix: 'read the collection tree with zotero-read --collections and use a key it lists',
      })
    }
    const page = JSON.parse(res.text)
    rows.push(...page)
    if (page.length < COLLECTION_PAGE || rows.length >= COLLECTION_CAP || selectExportKeys(rows).length >= options.limit) break
  }
  return selectExportKeys(rows).slice(0, options.limit)
}

/**
 * The columns a CSV export carries, in order.
 *
 * These are the fields a reference-row spreadsheet is read for: identity, the citation as the
 * library holds it, and the abstract and tags for filtering. Citation keys are included because
 * 1.0.1 made them a first-class field and a spreadsheet is where a missing one is spotted.
 */
export const CSV_COLUMNS = [
  'key',
  'itemType',
  'title',
  'creators',
  'date',
  'publicationTitle',
  'volume',
  'issue',
  'pages',
  'DOI',
  'ISBN',
  'url',
  'citationKey',
  'abstractNote',
  'tags',
]

/**
 * One CSV cell, quoted only when it has to be.
 *
 * RFC 4180 quoting: a comma, a quote or a line break forces quotes, and an embedded quote doubles.
 * Leading and trailing spaces are quoted too, because a spreadsheet trims them on read otherwise.
 *
 * @param {unknown} value The cell value.
 * @returns {string} The cell as it goes into the row.
 */
export function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value)
  if (!/[",\r\n]/.test(text) && text.trim() === text) return text
  return `"${text.replaceAll('"', '""')}"`
}

/** The creators of a record as one semicolon-joined cell, "First Last" per creator. */
export function creatorsText(creators) {
  return (Array.isArray(creators) ? creators : [])
    .map((creator) => `${creator.firstName ?? ''} ${creator.lastName ?? ''}`.trim() || (creator.name ?? ''))
    .filter((name) => name !== '')
    .join('; ')
}

/** The tags of a record as one semicolon-joined cell. */
export function tagsText(tags) {
  return (Array.isArray(tags) ? tags : []).map((tag) => tag.tag ?? '').filter((tag) => tag !== '').join('; ')
}

/**
 * One record as a CSV row, in CSV_COLUMNS order.
 *
 * @param {object} item A row from `/items` (fields either at the top level or under `data`).
 * @returns {string[]} The cells, unquoted.
 */
export function itemToCsvRow(item = {}) {
  const data = item.data ?? item
  return [
    item.key ?? data.key ?? '',
    data.itemType ?? '',
    data.title ?? '',
    creatorsText(data.creators),
    data.date ?? '',
    data.publicationTitle ?? '',
    data.volume ?? '',
    data.issue ?? '',
    data.pages ?? '',
    data.DOI ?? '',
    data.ISBN ?? '',
    data.url ?? '',
    data.citationKey ?? '',
    data.abstractNote ?? '',
    tagsText(data.tags),
  ]
}

/**
 * A whole CSV document, header included and newline-terminated.
 *
 * @param {object[]} items The records, in the caller's order.
 * @returns {string} The document.
 */
export function buildCsv(items) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')]
  for (const item of items) lines.push(itemToCsvRow(item).map(csvCell).join(','))
  return `${lines.join('\n')}\n`
}

/** Print an export, or write it to --output and say where it went. */
function emitText(text, options) {
  const body = text.endsWith('\n') ? text : `${text}\n`
  if (!options.output) {
    process.stdout.write(body)
    return
  }
  try {
    writeFileSync(options.output, body, 'utf8')
  } catch (error) {
    throw new Refusal(`cannot write ${options.output}: ${error.message}`, {
      fix: 'pass --output a path whose directory exists and is writable',
    })
  }
  console.log(`wrote ${options.output} (${Buffer.byteLength(body, 'utf8')} bytes)`)
}

/** One record per key, in the caller's order, for formats that need fields rather than a translator. */
async function requestItems(keys, options) {
  const path = `${libraryPrefix(options.library)}/items?itemKey=${keys.join(',')}&format=json`
  const res = await localRequest('GET', path)
  if (res.status !== 200) {
    throw new Refusal(`the record listing answered HTTP ${res.status}: ${res.text.slice(0, 200)}`, {
      fix: 'read the keys again with zotero-read --item and check that the library still holds them',
    })
  }
  const rows = JSON.parse(res.text)
  const byKey = new Map(rows.map((row) => [row.key ?? row.data?.key, row]))
  const missing = keys.filter((key) => !byKey.has(key))
  if (missing.length > 0) {
    throw new Refusal(`the library returned no record for ${missing.join(', ')}`, {
      fix: 'read each key with zotero-read --item; a key copied from a search result is not always the record key',
    })
  }
  return keys.map((key) => byKey.get(key))
}

/**
 * Export, print, and return the exit code.
 *
 * @param {object} options Parsed options.
 * @returns {Promise<number>} 0 on success, 1 when the library refused.
 */
async function runExport(options) {
  const keys = options.collection
    ? await collectionKeys(options)
    : [...new Set(options.items)]
  if (keys.length === 0) {
    throw new Refusal('there is no record to export', {
      fix: 'a collection holding only notes and attachments has no work to cite; name a record with --item',
    })
  }
  if (keys.length > ITEMKEY_CAP) {
    throw new Refusal(
      `this export asks for ${keys.length} records, and Zotero answers at most ${ITEMKEY_CAP} per request`,
      {
        fix: `split the export into batches of ${ITEMKEY_CAP} keys; the library's own order is preserved per request`,
      },
    )
  }

  if (options.format === 'csv') {
    const items = await requestItems(keys, options)
    const csv = buildCsv(items)
    if (options.json) {
      emitText(
        JSON.stringify(
          {
            format: options.format,
            library: options.library,
            items: items.map((row) => ({ key: row.key ?? row.data?.key, ref: itemRef(row.key ?? row.data?.key, options.library) })),
            csv,
          },
          null,
          2,
        ),
        options,
      )
      return 0
    }
    emitText(csv, options)
    return 0
  }

  const body = await requestExport(buildExportPath(keys, options))
  if (options.format === 'citation') {
    const rows = JSON.parse(body)
    const citations = orderCitations(Array.isArray(rows) ? rows : [], keys)
    const missing = citations.filter((entry) => entry.citation.trim() === '')
    if (missing.length > 0) {
      throw new Refusal(`the library returned no citation for ${missing.map((entry) => entry.key).join(', ')}`, {
        fix: 'read each record with zotero-read --item and check that the library still holds it',
      })
    }
    if (options.json) {
      emitText(
        JSON.stringify(
          {
            format: options.format,
            style: options.style,
            locale: options.locale,
            library: options.library,
            items: citations.map((entry) => ({ key: entry.key, ref: itemRef(entry.key, options.library), citation: entry.citation })),
          },
          null,
          2,
        ),
        options,
      )
      return 0
    }
    const lines = [
      `format : ${options.format} · style ${options.style} · locale ${options.locale} · ${citations.length} record(s)`,
      ...citations.map((entry, index) => `${index + 1}. ${entry.key}\n   ${entry.citation}`),
    ]
    emitText(lines.join('\n'), options)
    return 0
  }

  if (options.json) {
    emitText(
      JSON.stringify(
        {
          format: options.format,
          style: options.format === 'bibliography' ? options.style : undefined,
          locale: options.format === 'bibliography' ? options.locale : undefined,
          library: options.library,
          items: keys.map((key) => ({ key, ref: itemRef(key, options.library) })),
          text: body,
        },
        null,
        2,
      ),
      options,
    )
    return 0
  }
  emitText(body, options)
  return 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const info = await localRequest('GET', '/api/')
  if (info.status !== 200) {
    throw new Refusal('the reference library is not answering', {
      fix: 'start the reference manager, enable its local API, and run this again',
    })
  }
  process.exitCode = await runExport(options)
}

const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint && wantsHelp(process.argv.slice(2))) {
  process.exitCode = reportHelp(USAGE)
} else if (isEntryPoint) {
  main().catch((error) => {
    process.exitCode = reportFailure(error, { usage: USAGE })
  })
}
