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
//   node tools/zotero-export.mjs --item <key> [--item <key> ...] --format bibtex
//   node tools/zotero-export.mjs --collection <key> --format bibliography [--style apa] [--locale en-US]
//   node tools/zotero-export.mjs --item <key> --format citation
//   formats: citation | bibliography | bibtex | biblatex | ris | csljson
//   [--library user:0|group:<id>] [--json]
// Exit codes: 0 exported | 1 the library refused, or there is nothing to export | 2 usage.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PERSONAL_LIBRARY,
  itemRef,
  libraryPrefix,
  localRequest,
  parseLibrary,
} from './zotero-local-api.mjs'
import { Refusal, UsageError, reportFailure } from './refusal.mjs'

const FORMATS = ['citation', 'bibliography', 'bibtex', 'biblatex', 'ris', 'csljson']
const DEFAULT_STYLE = 'apa'
const DEFAULT_LOCALE = 'en-US'
/** Zotero's own itemKey batched-read cap; a larger set is a second invocation, not a silent split. */
const ITEMKEY_CAP = 50
const COLLECTION_PAGE = 100
const COLLECTION_CAP = 500

const USAGE =
  'usage: node tools/zotero-export.mjs --item <key> [--item <key> ...] --format <format>\n' +
  '       node tools/zotero-export.mjs --collection <key> --format <format> [--limit N]\n' +
  `       formats: ${FORMATS.join(' | ')}\n` +
  '       [--style <csl-style>] [--locale <csl-locale>] [--library user:0|group:<id>] [--json]\n' +
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
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = argv[index + 1]
    switch (flag) {
      case '--item':
        if (!next) throw new UsageError('--item needs a record key')
        options.items.push(next)
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
      console.log(
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
      )
      return 0
    }
    console.log(`format : ${options.format} · style ${options.style} · locale ${options.locale} · ${citations.length} record(s)`)
    citations.forEach((entry, index) => console.log(`${index + 1}. ${entry.key}\n   ${entry.citation}`))
    return 0
  }

  if (options.json) {
    console.log(
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
    )
    return 0
  }
  console.log(body)
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

if (isEntryPoint) {
  main().catch((error) => {
    process.exitCode = reportFailure(error, { usage: USAGE })
  })
}
