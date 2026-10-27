#!/usr/bin/env node
// Search the arXiv preprint index and read one record's metadata, without an MCP server.
//
// WHY THIS FILE EXISTS
//
// The `mcp-arxiv` row provided this channel with 19 tools. That surface cost 17,828 characters
// (~5.0k tokens) of prompt on EVERY request, and the DSH MCP client has no field that filters a
// server's tool list, so it could not be trimmed. Two of those 19 are all the disciplines use:
// search, and "give me the record for this id" - and both are one call to the public Atom API.
//
// MEASURED TRAPS THIS FILE EXISTS TO HANDLE (all reproduced 2026-10-15)
//
//   * `http://export.arxiv.org/api/query` answers 301 to https. A client that does not follow the
//     redirect receives an EMPTY body, which is silent and reads exactly like "no results". The
//     https URL is used directly here.
//   * Errors arrive as Atom too, and the status code is NOT reliable: an invalid query answers
//     HTTP 400, and `max_results` above 30,000 answers HTTP 500 - while the manual claims 400 for
//     that one. Both bodies are a feed whose `totalResults` is 1 and which carries exactly ONE
//     <entry> - <id>https://arxiv.org/api/errors</id>, <title>Error</title>, even an <author>. A
//     parser that reads the first <entry> therefore reports a failure AS A PAPER, and one that
//     trusts the status code misses half the cases. `parseFeed` returns `error` instead, keyed on
//     the sentinel, and the CLI prints no record.
//   * An unknown id is NOT an error: HTTP 200, `totalResults` 0, no <entry> at all. "Searched and
//     answered nothing" and "the request failed" must never print the same thing.
//   * The API sorts by relevance by default, which is NOT the date order of the web interface.
//   * arXiv asks for at most one request every three seconds on a single connection. This CLI makes
//     exactly one request per run; several ids ride that one request through `id_list`.
//
// TRANSPORT. Plain `fetch` with a timeout. The repository's other rule - Zotero's local API goes
// through node:http with NO timeout - exists because such a request blocks until a human answers an
// authorization dialog. That premise does not hold for a public read-only endpoint, and a timeout is
// wanted here.
//
// Usage:
//   node tools/arxiv.mjs --search 'cat:cs.CL AND abs:"retrieval augmented"' --max 10
//   node tools/arxiv.mjs --search 'au:hinton' --sort submittedDate --order descending
//   node tools/arxiv.mjs --id 1706.03762 --id 2610.19549 --full
//   node tools/arxiv.mjs --selftest
//
// Exit codes: 0 answered, including zero results | 1 the request or the response failed | 2 usage.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Refusal, UsageError, reportFailure } from './refusal.mjs'

const API_URL = 'https://export.arxiv.org/api/query'
const USER_AGENT = 'dsh-autoresearch/1.0'
const REQUEST_TIMEOUT_MS = 30_000

/** Default page size, matching the API's own default so nothing is silently widened. */
const DEFAULT_MAX = 10
/**
 * Ours, not arXiv's. The API allows 2,000 per slice, but the shell tool returns only the first 16,000
 * characters of one command, and the result pruner reduces any tool result over 8,192 to its head and
 * tail once the context is compacted — so a wider page is paid for in slices that cannot be re-read.
 */
const MAX_RESULTS_CAP = 100
/** Per-entry abstract characters, and the budget for a whole response. 10 x (400 + ~120 header) fits the pruner. */
const DEFAULT_ABSTRACT_CHARS = 400
const ABSTRACT_BUDGET_CHARS = 6_000

const SORTS = ['relevance', 'lastUpdatedDate', 'submittedDate']
const ORDERS = ['ascending', 'descending']

/**
 * Resolve the named and numeric XML character references an Atom feed actually carries.
 *
 * @param {string} text Escaped element text or attribute value.
 * @returns {string} The text with references resolved; an unrecognised reference is left as-is.
 */
export function decodeXml(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return text.replace(/&(#[0-9a-fx]+|[a-z]+);/gi, (match, body) => {
    if (body.startsWith('#')) {
      const code = /^#x/i.test(body) ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return named[body.toLowerCase()] ?? match
  })
}

/** Text of the first matching element, whitespace-collapsed and decoded. '' when absent. */
function elementText(xml, tag) {
  const raw = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1]
  return raw === undefined ? '' : decodeXml(raw).replace(/\s+/g, ' ').trim()
}

/** The `href` of the first <link> matching every given attribute, or ''. */
function findLink(entry, attributes) {
  for (const [, body] of entry.matchAll(/<link\s([^>]*?)\/?>/g)) {
    const value = (name) => decodeXml(body.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '')
    if (Object.entries(attributes).every(([name, wanted]) => value(name) === wanted)) return value('href')
  }
  return ''
}

/**
 * Split an atom <id> url into the bare id and its version.
 *
 * @param {string} url A value such as `http://arxiv.org/abs/2610.19549v1`.
 * @returns {{bare: string, base: string, version: string}} `base` drops the version suffix.
 */
function splitId(url) {
  const bare = url.replace(/^https?:\/\/arxiv\.org\/abs\//, '')
  const versioned = /^(.*?)(v\d+)$/.exec(bare)
  return versioned ? { bare, base: versioned[1], version: versioned[2] } : { bare, base: bare, version: '' }
}

/**
 * Whether an entry is the sentinel arXiv uses to report a failure inside an otherwise normal feed.
 *
 * The id is the stable marker; the title is checked as well because an error printed as a record is
 * a fabricated citation, which is the one failure this preset's contract forbids above all others.
 *
 * @param {{id: string, title: string}} entry A parsed entry.
 * @returns {boolean} True for the error sentinel.
 */
function isErrorEntry(entry) {
  return entry.id.includes('/api/errors') || entry.title === 'Error'
}

/** One <entry> body as a record. */
function parseEntry(body) {
  const { bare, base, version } = splitId(elementText(body, 'id'))
  return {
    bare,
    base,
    version,
    id: elementText(body, 'id'),
    title: elementText(body, 'title'),
    authors: [...body.matchAll(/<name>([^<]*)<\/name>/g)].map((match) => decodeXml(match[1])),
    published: elementText(body, 'published'),
    updated: elementText(body, 'updated'),
    summary: elementText(body, 'summary'),
    categories: [...body.matchAll(/<category\s+term="([^"]*)"/g)].map((match) => decodeXml(match[1])),
    primaryCategory: decodeXml(/<arxiv:primary_category\s+term="([^"]*)"/.exec(body)?.[1] ?? ''),
    doi: elementText(body, 'arxiv:doi'),
    journalRef: elementText(body, 'arxiv:journal_ref'),
    comment: elementText(body, 'arxiv:comment'),
    absUrl: findLink(body, { rel: 'alternate' }),
    pdfUrl: findLink(body, { title: 'pdf' }) || (base ? `https://arxiv.org/pdf/${base}` : ''),
  }
}

/**
 * Parse one Atom response into the record set the CLI reports.
 *
 * @param {string} xml The response body.
 * @returns {{query: string, totalResults: number, startIndex: number, itemsPerPage: number, entries: object[], error: string}}
 *   `error` is non-empty when the feed is an error feed, in which case `entries` is empty; the
 *   caller must treat that as a failure rather than as a record set.
 * @throws {Error} When the body is not an Atom feed at all.
 */
export function parseFeed(xml) {
  const firstEntry = xml.search(/<entry[\s>]/)
  const head = firstEntry === -1 ? xml : xml.slice(0, firstEntry)
  if (!/<feed[\s>]/.test(head)) throw new Error('the response is not an Atom feed')
  const count = (tag) => Number(elementText(head, tag) || 0)
  const entries = [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/g)].map(([, body]) => parseEntry(body))
  const failed = entries.find(isErrorEntry)
  return {
    query: elementText(head, 'title'),
    totalResults: count('opensearch:totalResults'),
    startIndex: count('opensearch:startIndex'),
    itemsPerPage: count('opensearch:itemsPerPage'),
    entries: failed ? [] : entries,
    error: failed ? failed.summary || 'arXiv reported an error' : '',
  }
}

/**
 * Cut an abstract to a character budget, reporting what was dropped so the caller can say so.
 *
 * @param {string} text The abstract.
 * @param {number} limit Maximum characters to keep; 0 keeps none, Infinity keeps all.
 * @returns {{text: string, shown: number, total: number, truncated: boolean}} The cut and its size.
 */
export function truncateAbstract(text, limit) {
  const total = text.length
  const take = Math.max(0, limit)
  return take >= total
    ? { text, shown: total, total, truncated: false }
    : { text: text.slice(0, take), shown: take, total, truncated: true }
}

/** A creator list with its count, which is what a read-back verifies against. */
function describeAuthors(names) {
  if (names.length === 0) return 'unknown'
  const shown = names.length <= 4 ? names : [...names.slice(0, 3), 'et al.']
  return `${names.length}  (${shown.join('; ')})`
}

/**
 * Render records for a reader, holding the whole response to one abstract budget.
 *
 * @param {object[]} entries Records from `parseFeed`.
 * @param {{abstractChars?: number, abstractBudget?: number}} [options] Per-entry limit and total budget.
 * @returns {string} One block per record, separated by a blank line.
 */
export function formatEntries(entries, options = {}) {
  const abstractChars = options.abstractChars ?? DEFAULT_ABSTRACT_CHARS
  let budgetLeft = options.abstractBudget ?? ABSTRACT_BUDGET_CHARS
  const blocks = []
  entries.forEach((entry, index) => {
    const lines = [
      `${index + 1}. ${entry.bare}  ${entry.published.slice(0, 10) || 'unknown'}  [${entry.primaryCategory || 'uncategorised'}]`,
      `   ${entry.title}`,
      `   authors : ${describeAuthors(entry.authors)}`,
    ]
    if (entry.comment) lines.push(`   comment : ${entry.comment}`)
    if (entry.doi) lines.push(`   DOI     : ${entry.doi}`)
    if (entry.journalRef) lines.push(`   journal : ${entry.journalRef}`)
    if (entry.absUrl) lines.push(`   abs     : ${entry.absUrl}`)
    if (entry.pdfUrl) lines.push(`   pdf     : ${entry.pdfUrl}`)
    const budgeted = Math.min(abstractChars, budgetLeft)
    const abstract = truncateAbstract(entry.summary, budgeted)
    budgetLeft -= abstract.shown
    if (abstract.total === 0) {
      lines.push('   abstract: (none in the record)')
    } else if (abstract.truncated && budgeted < abstractChars) {
      lines.push(
        `   abstract: [omitted - this response's ${options.abstractBudget ?? ABSTRACT_BUDGET_CHARS}-character budget is spent; rerun with --id ${entry.bare} --full]`,
      )
    } else {
      const tail = abstract.truncated
        ? ` [truncated ${abstract.shown} of ${abstract.total} chars - rerun with --id ${entry.bare} --full]`
        : ''
      lines.push(`   abstract: ${abstract.text}${tail}`)
    }
    blocks.push(lines.join('\n'))
  })
  return blocks.join('\n\n')
}

/**
 * Describe the ordering the caller actually asked for, naming only what was sent.
 *
 * Writing the API's defaults here would put a claim in the output that the request never made: when
 * no `--sort` is given, `sortBy` is not sent at all and the API falls back to relevance.
 *
 * @param {{sort?: string, order?: string}} options Parsed options.
 * @returns {string} A one-line description for the scope line.
 */
export function describeSort(options) {
  if (!options.sort && !options.order) return 'relevance (API default; not the web interface order)'
  return [options.sort || 'relevance (API default)', options.order].filter(Boolean).join('/')
}

/**
 * Build the query url. Parameters are set only when they carry a choice, so the request says what
 * the caller meant rather than restating defaults back to the API.
 *
 * @param {{search?: string, ids?: string[], start?: number, max?: number, sort?: string, order?: string}} [options]
 * @returns {string} The absolute url to call.
 */
export function buildQueryUrl(options = {}) {
  const params = new URLSearchParams()
  if (options.search) params.set('search_query', options.search)
  if (options.ids?.length) params.set('id_list', options.ids.join(','))
  params.set('start', String(options.start ?? 0))
  params.set('max_results', String(options.max ?? DEFAULT_MAX))
  if (options.sort) params.set('sortBy', options.sort)
  if (options.order) params.set('sortOrder', options.order)
  return `${API_URL}?${params}`
}

const USAGE =
  "usage: node tools/arxiv.mjs --search '<arXiv query>' [--start N] [--max N] [--sort ...] [--order ...]\n" +
  '       node tools/arxiv.mjs --id <id> [--id <id> ...] [--full] [--json]\n' +
  '       node tools/arxiv.mjs --selftest'

/**
 * What an arXiv refusal means, and the one action that follows it.
 *
 * Three different situations hide behind "not 200", and they need different advice: a 4xx with a
 * sentinel entry is arXiv objecting to the QUERY, a 5xx with one is usually a page that was too large,
 * and 429/503 is the rate limiter. Telling a reader to "wait a minute" for a malformed id wastes the
 * minute and teaches nothing; telling them to fix the query for a 429 invites the loop that caused it.
 *
 * Pure, and exported, so every branch is checked without asking arXiv to fail on demand.
 *
 * @param {{status: number, feedError?: string}} answer The status, and the sentinel text when there is one.
 * @returns {Error} A refusal carrying the action.
 */
export function arxivFailure({ status, feedError = '' }) {
  if (feedError) {
    return new Refusal(`arXiv refused this query (HTTP ${status}): ${feedError}`, {
      fix:
        status === 400
          ? 'arXiv objects to the query itself, not to the rate: correct the id or the terms and ask again'
          : 'arXiv answered 500 on this page size; lower --max and ask again',
    })
  }
  const throttled = status === 429 || status === 503
  return new Refusal(`arXiv answered HTTP ${status}${throttled ? ' (it is throttling this client)' : ''}`, {
    fix: throttled
      ? 'wait a minute and ask again - the number is a limit on rate, not a verdict on the query'
      : 'arXiv failed on its own side; ask again in a minute, and do not read this as "no such paper"',
  })
}

/**
 * Read the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} The options, with `abstractChars` already resolved from `--full`.
 * @throws {UsageError} On a usage error; the CLI turns that into exit code 2.
 */
export function parseArgs(argv) {
  const options = {
    search: '',
    ids: [],
    start: 0,
    max: DEFAULT_MAX,
    sort: '',
    order: '',
    abstractChars: DEFAULT_ABSTRACT_CHARS,
    full: false,
    json: false,
    selftest: false,
  }
  const integer = (name, value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new UsageError(`--${name} takes an integer between ${min} and ${max}, got '${value}'`)
    }
    return parsed
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = argv[index + 1]
    switch (flag) {
      case '--search':
        options.search = next ?? ''
        index += 1
        break
      case '--id':
        if (!next) throw new UsageError('--id needs an arXiv id')
        options.ids.push(next)
        index += 1
        break
      case '--start':
        options.start = integer('start', next)
        index += 1
        break
      case '--max':
        options.max = integer('max', next, { min: 1, max: MAX_RESULTS_CAP })
        index += 1
        break
      case '--sort':
        if (!SORTS.includes(next)) throw new UsageError(`--sort takes one of ${SORTS.join(', ')}, got '${next}'`)
        options.sort = next
        index += 1
        break
      case '--order':
        if (!ORDERS.includes(next)) throw new UsageError(`--order takes one of ${ORDERS.join(', ')}, got '${next}'`)
        options.order = next
        index += 1
        break
      case '--abstract':
        options.abstractChars = integer('abstract', next)
        index += 1
        break
      case '--full':
        options.full = true
        break
      case '--json':
        options.json = true
        break
      case '--selftest':
        options.selftest = true
        break
      default:
        throw new UsageError(`unrecognised argument '${flag}'`)
    }
  }
  if (options.full) options.abstractChars = Number.POSITIVE_INFINITY
  if (options.selftest) return options
  if (options.search && options.ids.length > 0) throw new UsageError('pass --search or --id, not both')
  if (!options.search && options.ids.length === 0) throw new UsageError('pass --search or --id')
  return options
}

/** One request. No retry: a rate limit or an outage is a finding about the channel, not a loop. */
async function fetchFeed(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { ok: response.ok, status: response.status, body: await response.text() }
}

/** Ids asked for that the response did not carry, in the order asked. */
function findMissingIds(requested, entries) {
  const returned = new Set(entries.map((entry) => entry.base))
  return requested.filter((id) => !returned.has(splitId(id).base))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.selftest) {
    // The checks live beside this file, mirroring it. They report through `failedChecks` instead of
    // calling process.exit themselves, which would trip Node's unsettled-top-level-await check.
    const { failedChecks } = await import('./tests/arxiv-selftest.mjs')
    if (failedChecks) process.exit(1)
    return
  }

  const url = buildQueryUrl(options)
  const response = await fetchFeed(url)
  let feed
  try {
    feed = parseFeed(response.body)
  } catch (error) {
    throw new Error(`arXiv answered HTTP ${response.status}, and the body is not an Atom feed: ${error.message}`)
  }

  if (feed.error) {
    // Measured shapes: HTTP 400 for an invalid query, HTTP 500 for an oversized page. In both, the
    // feed carries exactly one sentinel <entry> and `totalResults` is 1. Never a record.
    throw arxivFailure({ status: response.status, feedError: feed.error })
  }
  if (!response.ok) throw arxivFailure({ status: response.status })

  const missing = findMissingIds(options.ids, feed.entries)
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          query: feed.query,
          totalResults: feed.totalResults,
          startIndex: feed.startIndex,
          itemsPerPage: feed.itemsPerPage,
          sort: describeSort(options),
          sortBySent: options.sort || null,
          sortOrderSent: options.order || null,
          idsRequested: options.ids.length,
          idsMissing: missing,
          entries: feed.entries,
        },
        null,
        2,
      ),
    )
    return
  }

  const shown = feed.entries.length === 0 ? 'none' : `${feed.startIndex + 1}-${feed.startIndex + feed.entries.length}`
  console.log(`query : ${feed.query}`)
  console.log(
    `scope : total ${feed.totalResults} · showing ${shown} · max ${options.max} · sort ${describeSort(options)}`,
  )
  if (options.ids.length > 0) console.log(`ids   : requested ${options.ids.length} · returned ${feed.entries.length}`)
  if (missing.length > 0) console.log(`warning: no record came back for ${missing.join(', ')}`)
  if (feed.entries.length === 0) {
    console.log('\n0 results - the query was answered and matched nothing. This is not a failure.')
    return
  }
  console.log(`\n${formatEntries(feed.entries, { abstractChars: options.abstractChars })}`)
}

// Only act when this file IS the command: the self-test imports the pure functions above, and an
// import must not make a network request.
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

// NOT `await main()`: this module is the entry point AND it dynamically imports its own self-test,
// which statically imports this file back. A pending top-level await here would make that cycle
// wait on itself - the self-test body never runs and the process exits 13 with only a warning.
if (isEntryPoint) {
  main().catch((error) => {
    process.exitCode = reportFailure(error, { usage: USAGE })
  })
}
