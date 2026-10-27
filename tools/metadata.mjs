#!/usr/bin/env node
// Read bibliographic metadata over the free OpenAlex / Crossref / Unpaywall REST APIs - the cheap
// path for "does this work exist, and what is its canonical record".
//
// WHY THIS FILE EXISTS
//
// `metadata-query` used to hand the model three endpoints and four rules as prose: append
// `&mailto=<address>`, make one request at a time, back off on 429, and "do not report an abstract you
// did not reconstruct". Each of those is a decision a program makes once and a model has to remember
// on every call - the same trade §29 and §31 made for the other two channels, applied to the one
// channel that had no program.
//
// MEASURED TRAPS THIS FILE EXISTS TO HANDLE (all reproduced 2026-10-19 from this machine)
//
//   * THE RECORD THAT COMES BACK MAY NOT CARRY THE DOI YOU ASKED FOR. OpenAlex answered a request for
//     `doi:10.48550/arXiv.1706.03762` with a work whose own `doi` is `10.65215/2q58a426` - same
//     title, same record. A report that quotes only the title and the counts hides that substitution,
//     so every record line prints `asked` and `answered` and says when they differ.
//   * THE TWO SOURCES ARE NOT INTERCHANGEABLE, and the difference is registration rather than
//     quality: the same arXiv DOI answers 200 on OpenAlex and 404 on Crossref ("Resource not found.")
//     because arXiv registers with DataCite while Crossref holds the publisher side.
//   * THE SAME WORK CARRIES DIFFERENT CITATION COUNTS ON THE TWO SOURCES: OpenAlex `cited_by_count`
//     43,412 against Crossref `is-referenced-by-count` 46,513 for 10.1038/s41586-021-03819-2,
//     measured minutes apart. A count without the source that gave it is not a number a report can
//     defend, so the source sits on the count's own line.
//   * THE PAYLOADS DO NOT FIT. One OpenAlex work record measured 24,580 characters and a three-row
//     search 65,619, while the shell tool returns only the first 16,000 characters of one command and
//     the result pruner reduces any tool result over 8,192 to its head and tail once the context is
//     compacted. Printing the response would cost a slice nobody can read back, so every mode converges
//     to a fixed field set first - `--json` prints that record, not the payload.
//   * HTTP 404 FROM UNPAYWALL IS HTML, NOT JSON (`<!doctype html> ... <h1>404 Not Found</h1>`).
//     "This DOI is not in the index", "the body is not JSON", "the channel is rate-limiting us" and
//     "the request failed" must never print the same thing: `classifyResponse` keeps them apart, and
//     a 404 is reported as a fact about what that index holds, never as "no free copy exists".
//   * A POLITE-POOL ADDRESS IS NEVER REQUIRED BY OPENALEX: it answered byte-identical with and without
//     `mailto` (24,580 characters both ways). Unpaywall is the exception - it takes the address in its
//     own `email=` parameter, so `--oa` refuses to run without one instead of guessing.
//   * `mailto` IS NOT AN OPENALEX QUOTA LEVER ANY MORE (measured 2026-10-19): a search answered a
//     `meta.notice` reading "No API key, so this request shares one free daily budget ($0.10) with
//     everyone on your network's IP address. The mailto parameter doesn't raise this limit." The
//     notice is printed when the API sends one, rather than leaving a reader to infer from the
//     discipline that the parameter buys quota. Crossref still wants the address; this is per source.
//   * A TITLE-SHAPED SEARCH ON OPENALEX IS A FULL-TEXT SEARCH: `attention is all you need` answered
//     `total 3230801`, with the API's own reading "get works where full text has (attention is all you
//     need)". A large `total` is not "many works with this title", so that reading is printed beside it.
//
// TRANSPORT. Plain `fetch` with a timeout, like the preprint helper: a public read-only endpoint has
// no human in the loop, which is the premise behind the reference-manager rule that requests there
// must NOT time out.
//
// ONE REQUEST PER INVOCATION, and no paging loop: a second page is a second invocation, made by
// whoever decided the first page was not enough.
//
// Usage:
//   node tools/metadata.mjs --doi 10.1038/s41586-021-03819-2
//   node tools/metadata.mjs --doi 10.48550/arXiv.1706.03762 --source crossref
//   node tools/metadata.mjs --search 'attention is all you need' --rows 5
//   node tools/metadata.mjs --refs 10.1038/s41586-021-03819-2
//   node tools/metadata.mjs --cited-by W2626778328
//   node tools/metadata.mjs --oa 10.1038/s41586-021-03819-2 --mailto you@example.org
//   node tools/metadata.mjs --selftest
//
// Exit codes: 0 answered, including zero results | 1 the request or the response failed | 2 usage.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Refusal, UsageError, reportFailure } from './refusal.mjs'

const OPENALEX_URL = 'https://api.openalex.org'
const CROSSREF_URL = 'https://api.crossref.org'
const UNPAYWALL_URL = 'https://api.unpaywall.org/v2'
const USER_AGENT = 'dsh-autoresearch/1.0 (metadata helper)'
const REQUEST_TIMEOUT_MS = 30_000

/** Default page size, and the ceiling the discipline already states: keep queries small. */
const DEFAULT_ROWS = 5
const MAX_ROWS = 10
/** Per-record abstract characters. One record plus its headers has to fit the pruner. */
const DEFAULT_ABSTRACT_CHARS = 600
/** Referenced/citing ids printed before the line reports how many were held back. */
const IDS_SHOWN = 20

const MODES = ['doi', 'search', 'refs', 'cited-by', 'oa', 'cite', 'verify', 'related']
const SOURCES = ['openalex', 'crossref']
/** The citation formats doi.org content negotiation serves. */
const CITE_FORMATS = ['bibtex', 'ris', 'csljson', 'text']
const DEFAULT_CITE_STYLE = 'apa'
const DEFAULT_CITE_LOCALE = 'en-US'

/**
 * Strip the several ways a DOI is written down before it is used as an identifier.
 *
 * @param {string} value A DOI, with or without a resolver prefix.
 * @returns {string} The bare DOI, trimmed; '' for an empty value.
 */
export function normalizeDoi(value) {
  return String(value ?? '')
    .trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .trim()
}

/**
 * The DOI behind a `--cite` target.
 *
 * doi.org negotiates citations by DOI, so an arXiv id is mapped to its registered DataCite DOI rather
 * than sent as an arXiv URL. A PMID needs a resolver that is not this channel; it is refused with that
 * statement instead of a silent miss.
 *
 * @param {string} value A DOI or an arXiv id.
 * @returns {string} The bare DOI.
 * @throws {Error} When the value is neither.
 */
export function citeDoi(value) {
  const text = normalizeDoi(value)
  if (/^10\.\d{4,9}\//.test(text)) return text
  const arxiv = /^(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?$/i.exec(text)
  if (arxiv) return `10.48550/arXiv.${arxiv[1]}`
  if (/^pmid:/i.test(text)) {
    throw new Error('a PMID needs a resolver: resolve it to a DOI with Europe PMC first, then cite the DOI')
  }
  throw new Error(`--cite takes a DOI or an arXiv id, got '${text}'`)
}

/**
 * The `Accept` value doi.org content negotiation needs for one citation format.
 *
 * @param {string} format One of {@link CITE_FORMATS}.
 * @param {string} style A CSL style id, for `text`.
 * @param {string} locale A CSL locale, for `text`.
 * @returns {string} The `Accept` header.
 */
export function citeAccept(format, style, locale) {
  if (format === 'bibtex') return 'application/x-bibtex'
  if (format === 'ris') return 'application/x-research-info-systems'
  if (format === 'csljson') return 'application/vnd.citationstyles.csl+json'
  return `text/x-bibliography; style=${style}; locale=${locale}`
}

/**
 * The resolver URL for one DOI.
 *
 * @param {string} doi A bare DOI.
 * @returns {string} `https://doi.org/<doi>` with each path segment encoded.
 */
export function citeUrl(doi) {
  return `https://doi.org/${String(doi).split('/').map(encodeURIComponent).join('/')}`
}

/**
 * The OpenAlex work id inside a value, if there is one.
 *
 * @param {string} value A bare id (`W2626778328`), an entity url, or anything else.
 * @returns {string} The id, or '' when the value carries none.
 */
export function openAlexIdOf(value) {
  return /(?:^|\/)(W\d+)(?:$|\/)/i.exec(String(value ?? '').trim())?.[1]?.toUpperCase() ?? ''
}

/**
 * Read what a target argument names, so a mode can refuse the kind it cannot use.
 *
 * @param {string} value A DOI or an OpenAlex id.
 * @returns {{kind: 'doi'|'openalex', value: string}} The normalized target.
 */
export function workRef(value) {
  const id = openAlexIdOf(value)
  return id === '' ? { kind: 'doi', value: normalizeDoi(value) } : { kind: 'openalex', value: id }
}

/**
 * Percent-encode a DOI for use inside a path, leaving the separators a DOI legitimately contains.
 *
 * `encodeURIComponent` would turn every `/` into `%2F`, and `encodeURI` leaves `?` and `#`, which
 * would end the path early. Both endpoints were measured accepting the raw `10.1038/...` form.
 *
 * @param {string} doi A bare DOI.
 * @returns {string} The path segment.
 */
export function doiPath(doi) {
  return encodeURI(doi).replace(/[?#]/g, (character) => encodeURIComponent(character))
}

/**
 * Rebuild an abstract from OpenAlex's `abstract_inverted_index`.
 *
 * This is the one thing the discipline forbids doing by eye ("do not report an abstract you did not
 * reconstruct"), and it is mechanical: the field is a `{word: [positions]}` map. A map that is
 * missing, malformed, or has a hole in the position range yields '' - a partial reconstruction
 * printed as an abstract would be exactly the fabricated quote the rule exists to stop.
 *
 * @param {unknown} index The `abstract_inverted_index` value.
 * @returns {string} The reconstructed text, or '' when it cannot be rebuilt faithfully.
 */
export function reconstructAbstract(index) {
  if (index === null || typeof index !== 'object' || Array.isArray(index)) return ''
  const slots = []
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions) || positions.length === 0) return ''
    for (const position of positions) {
      if (!Number.isInteger(position) || position < 0) return ''
      slots[position] = word
    }
  }
  if (slots.length === 0) return ''
  // NOT `slots.filter((word) => word === undefined)`: `filter` skips the holes of a sparse array, so it
  // reports a holed index as complete - and `join(' ')` then prints those holes as blanks, i.e. a
  // partial abstract that reads like a whole one. The guard has to walk every index.
  for (let position = 0; position < slots.length; position += 1) {
    if (slots[position] === undefined) return ''
  }
  return slots.join(' ')
}

/** JATS markup and entities, which Crossref abstracts carry and a reader should not see. */
function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return String(text ?? '').replace(/&(#?[a-z0-9]+);/gi, (match, body) => {
    if (body.startsWith('#')) {
      const code = /^#x/i.test(body) ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return named[body.toLowerCase()] ?? match
  })
}

/**
 * Plain text from a markup-bearing abstract.
 *
 * @param {unknown} value The field as the API sent it.
 * @returns {string} Tags removed, entities decoded, whitespace collapsed.
 */
export function plainText(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The API's own notice about quota or interpretation, bounded to one readable line.
 *
 * @param {unknown} value A `meta.notice` value.
 * @returns {string} The notice, or '' when the response carried none.
 */
export function boundedNotice(value) {
  const text = plainText(value)
  return text.length > 240 ? `${text.slice(0, 240)} ...` : text
}

/**
 * One reference as a line a reader can act on.
 *
 * The two sources shape a reference differently: OpenAlex sends one entity url per cited work, while
 * Crossref sends an object carrying a `DOI`, an `unstructured` citation string, or (least usefully)
 * only an internal `key`. Measured 2026-10-19, the first reference of 10.1038/s41586-021-03819-2 is
 * `{ key: '3819_CR1', DOI: '10.12688/f1000research.25097.1', unstructured: 'Thompson, M. C., ...' }`,
 * so a listing keyed on `key` prints "3819_CR1" and tells the reader nothing.
 *
 * @param {unknown} reference A reference as the source sent it.
 * @returns {string} A DOI, a bounded citation string, an id, or '' when there is nothing to print.
 */
export function referenceLabel(reference) {
  if (typeof reference === 'string') return openAlexIdOf(reference) || reference
  if (reference === null || typeof reference !== 'object') return ''
  const doi = normalizeDoi(reference.DOI ?? reference.doi ?? '')
  if (doi !== '') return doi
  const citation = plainText(reference.unstructured ?? '')
  if (citation !== '') return citation.length > 140 ? `${citation.slice(0, 140)} ...` : citation
  return String(reference.key ?? '')
}

/**
 * Converge one OpenAlex work record to the fields a report may quote.
 *
 * @param {object} record A `/works/...` record.
 * @returns {object} The bounded record; see `normalizeCrossrefWork` for the same shape.
 */
export function normalizeOpenAlexWork(record) {
  const references = Array.isArray(record?.referenced_works)
    ? record.referenced_works.map((value) => openAlexIdOf(value)).filter((id) => id !== '')
    : []
  const related = Array.isArray(record?.related_works)
    ? record.related_works.map((value) => openAlexIdOf(value)).filter((id) => id !== '')
    : []
  return {
    source: 'openalex',
    id: openAlexIdOf(record?.id),
    doi: normalizeDoi(record?.doi ?? record?.ids?.doi ?? ''),
    title: String(record?.title ?? record?.display_name ?? '').trim(),
    year: Number.isInteger(record?.publication_year) ? record.publication_year : null,
    venue: String(record?.primary_location?.source?.display_name ?? '').trim(),
    authors: (record?.authorships ?? []).map((entry) => String(entry?.author?.display_name ?? '').trim()).filter(Boolean),
    citedBy: Number.isFinite(record?.cited_by_count) ? record.cited_by_count : null,
    type: String(record?.type ?? ''),
    oaStatus: String(record?.open_access?.oa_status ?? ''),
    oaUrl: String(record?.open_access?.oa_url ?? ''),
    abstract: reconstructAbstract(record?.abstract_inverted_index),
    references,
    related,
  }
}

/**
 * Converge one Crossref work record to the same shape as `normalizeOpenAlexWork`.
 *
 * Crossref sends `title` as an ARRAY (measured), so a reader that treats it as a string prints
 * "[object Object]" or nothing at all.
 *
 * @param {object} record A `/works/<doi>` message.
 * @returns {object} The bounded record.
 */
export function normalizeCrossrefWork(record) {
  const first = (value) => (Array.isArray(value) ? value[0] : value)
  const dateParts = record?.issued?.['date-parts'] ?? record?.published?.['date-parts'] ?? []
  const references = Array.isArray(record?.reference) ? record.reference : []
  return {
    source: 'crossref',
    id: '',
    doi: normalizeDoi(record?.DOI ?? ''),
    title: plainText(first(record?.title)),
    year: Number.isInteger(dateParts?.[0]?.[0]) ? dateParts[0][0] : null,
    venue: plainText(first(record?.['container-title'])),
    authors: (record?.author ?? [])
      .map((author) => String(author?.name ?? [author?.given, author?.family].filter(Boolean).join(' ')).trim())
      .filter(Boolean),
    citedBy: Number.isFinite(record?.['is-referenced-by-count']) ? record['is-referenced-by-count'] : null,
    type: String(record?.type ?? ''),
    oaStatus: '',
    oaUrl: String(record?.URL ?? ''),
    abstract: plainText(record?.abstract),
    references,
    referenceCount: references.length,
    updates: (Array.isArray(record?.['update-to']) ? record['update-to'] : [])
      .map((entry) => ({
        type: String(entry?.type ?? ''),
        doi: normalizeDoi(entry?.DOI ?? ''),
        label: plainText(entry?.label ?? ''),
      }))
      .filter((entry) => entry.type !== '' || entry.doi !== ''),
  }
}

/**
 * Compare one registry record against what a reference claims, and look for a retraction.
 *
 * The comparisons are deliberately narrow: a title is a containment match on normalized words, a year
 * is an equality, and an author matches a surname inside a display name. A "match" here means the
 * registry does not contradict the claim, never that the paper supports it.
 *
 * @param {object} work A normalized Crossref record.
 * @param {{title?: string, year?: string|number, author?: string}} [expected] The claim to check.
 * @returns {{checks: Array<{field: string, expected: string, found: string, ok: boolean}>, retractions: object[], retracted: boolean}}
 *   The checks that were asked for, and the retraction notices Crossref carries.
 */
export function verifyWork(work, expected = {}) {
  const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const checks = []
  if (expected.title) {
    const wanted = normalize(expected.title)
    const found = normalize(work?.title)
    checks.push({
      field: 'title',
      expected: String(expected.title),
      found: String(work?.title ?? ''),
      ok: wanted !== '' && found !== '' && (found.includes(wanted) || wanted.includes(found)),
    })
  }
  if (expected.year !== undefined && String(expected.year) !== '') {
    checks.push({
      field: 'year',
      expected: String(expected.year),
      found: String(work?.year ?? ''),
      ok: String(work?.year ?? '') === String(expected.year),
    })
  }
  if (expected.author) {
    const wanted = normalize(expected.author)
    checks.push({
      field: 'author',
      expected: String(expected.author),
      found: (work?.authors ?? []).join('; '),
      ok: wanted !== '' && (work?.authors ?? []).some((author) => normalize(author).includes(wanted)),
    })
  }
  const retractions = (work?.updates ?? []).filter(
    (entry) => /retract/i.test(entry.type) || /retract/i.test(entry.label),
  )
  return { checks, retractions, retracted: retractions.length > 0 }
}

/**
 * Converge one Unpaywall record to the open-access lead it is.
 *
 * @param {object} record A `/v2/<doi>` record.
 * @returns {{doi: string, isOa: boolean, status: string, best: string, locations: Array<{url: string, host: string, version: string}>}}
 */
export function normalizeUnpaywall(record) {
  const location = (entry) => ({
    url: String(entry?.url_for_pdf ?? entry?.url ?? ''),
    host: String(entry?.host_type ?? ''),
    version: String(entry?.version ?? ''),
  })
  return {
    doi: normalizeDoi(record?.doi ?? ''),
    isOa: record?.is_oa === true,
    status: String(record?.oa_status ?? ''),
    best: String(record?.best_oa_location?.url_for_pdf ?? record?.best_oa_location?.url ?? ''),
    locations: (record?.oa_locations ?? []).map(location).filter((entry) => entry.url !== ''),
  }
}

/**
 * What kind of answer this is, so the four kinds of nothing never print alike.
 *
 * @param {{status: number, body: string}} response The raw answer.
 * @returns {'rate-limited'|'not-found'|'not-json'|'failed'|'json'} The classification.
 */
export function classifyResponse(response) {
  if (response.status === 429) return 'rate-limited'
  let parsed = null
  try {
    parsed = JSON.parse(response.body)
  } catch {
    parsed = null
  }
  if (response.status === 404) return 'not-found'
  if (parsed === null) return 'not-json'
  if (response.status >= 400) return 'failed'
  return 'json'
}

/**
 * The API's own error text, when a 200-shaped body is really an error envelope.
 *
 * @param {unknown} payload A parsed response.
 * @returns {string} The message, or '' when this is not an error envelope.
 */
export function errorMessage(payload) {
  if (payload === null || typeof payload !== 'object') return ''
  const message = payload.error ?? payload.message
  return typeof message === 'string' ? message : ''
}

/**
 * Build the one request this invocation makes. Pure, so the self-test can read the url without a
 * network call - which is the only way to prove the address parameter is injected rather than
 * remembered.
 *
 * @param {object} options Parsed options.
 * @returns {string} The absolute url.
 * @throws {Error} When the options cannot name a url (the CLI refuses these at parse time).
 */
export function buildUrl(options) {
  const contact = String(options.mailto ?? '').trim()
  const withContact = (url, parameter) => {
    if (contact === '') return url
    url.searchParams.set(parameter, contact)
    return url
  }
  const rows = String(options.rows ?? DEFAULT_ROWS)

  if (options.mode === 'search') {
    const query = String(options.search ?? '')
    if (options.source === 'crossref') {
      const url = new URL(`${CROSSREF_URL}/works`)
      url.searchParams.set('query.bibliographic', query)
      url.searchParams.set('rows', rows)
      return withContact(url, 'mailto').toString()
    }
    const url = new URL(`${OPENALEX_URL}/works`)
    url.searchParams.set('search', query)
    url.searchParams.set('per-page', rows)
    return withContact(url, 'mailto').toString()
  }

  if (options.mode === 'cited-by') {
    const url = new URL(`${OPENALEX_URL}/works`)
    url.searchParams.set('filter', `cites:${workRef(options.target).value}`)
    url.searchParams.set('per-page', rows)
    return withContact(url, 'mailto').toString()
  }

  if (options.mode === 'oa') {
    const url = new URL(`${UNPAYWALL_URL}/${doiPath(normalizeDoi(options.target))}`)
    if (contact !== '') url.searchParams.set('email', contact)
    return url.toString()
  }

  if (options.mode === 'verify') {
    return withContact(new URL(`${CROSSREF_URL}/works/${doiPath(normalizeDoi(options.target))}`), 'mailto').toString()
  }

  if (options.mode === 'related') {
    const reference = workRef(options.target)
    return withContact(
      new URL(`${OPENALEX_URL}/works/${reference.kind === 'openalex' ? reference.value : `doi:${doiPath(reference.value)}`}`),
      'mailto',
    ).toString()
  }

  // `--doi` and `--refs` read one work record; only what is printed differs.
  const reference = workRef(options.target)
  if (options.source === 'crossref') {
    return withContact(new URL(`${CROSSREF_URL}/works/${doiPath(reference.value)}`), 'mailto').toString()
  }
  const url = new URL(`${OPENALEX_URL}/works/${reference.kind === 'openalex' ? reference.value : `doi:${doiPath(reference.value)}`}`)
  return withContact(url, 'mailto').toString()
}

const USAGE =
  'usage: node tools/metadata.mjs --doi <doi|openalex-id> [--source openalex|crossref] [--abstract N] [--mailto <address>]\n' +
  "       node tools/metadata.mjs --search '<terms>' [--rows 1-10] [--source openalex|crossref] [--mailto <address>]\n" +
  '       node tools/metadata.mjs --refs <doi|openalex-id> [--source openalex|crossref] [--mailto <address>]\n' +
  '       node tools/metadata.mjs --cited-by <openalex-id> [--rows 1-10] [--mailto <address>]\n' +
  '       node tools/metadata.mjs --oa <doi> --mailto <address>\n' +
  '       node tools/metadata.mjs --cite <doi|arxiv-id> [--format bibtex|ris|csljson|text] [--style apa] [--locale en-US]\n' +
  '       node tools/metadata.mjs --verify <doi> [--expect-title "<title>"] [--expect-year YYYY] [--expect-author "<surname>"]\n' +
  '       node tools/metadata.mjs --related <doi|openalex-id>\n' +
  '       node tools/metadata.mjs --selftest'

/**
 * Read the command line, and refuse the combinations that cannot be honoured.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} The options.
 * @throws {UsageError} On a usage error; the CLI turns that into exit code 2.
 */
export function parseArgs(argv) {
  const options = {
    mode: '',
    source: 'openalex',
    search: '',
    target: '',
    rows: DEFAULT_ROWS,
    mailto: String(process.env.AUTORESEARCH_MAILTO ?? '').trim(),
    abstractChars: DEFAULT_ABSTRACT_CHARS,
    citeFormat: 'text',
    citeStyle: DEFAULT_CITE_STYLE,
    citeLocale: DEFAULT_CITE_LOCALE,
    citeDoi: '',
    expectTitle: '',
    expectYear: '',
    expectAuthor: '',
    json: false,
    selftest: false,
  }
  const flag = (name) => argv.includes(`--${name}`)
  const value = (name) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? null : (argv[at + 1] ?? null)
  }
  const integer = (name, raw, { min, max }) => {
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new UsageError(`--${name} takes an integer between ${min} and ${max}, got '${raw}'`)
    }
    return parsed
  }

  const present = MODES.filter((mode) => flag(mode))
  if (present.length > 1) {
    throw new UsageError(`pass one of ${MODES.map((mode) => `--${mode}`).join(' / ')}, not ${present.length}`)
  }
  options.mode = present[0] ?? ''
  if (options.mode === '') {
    if (!flag('selftest')) throw new UsageError(`pass one of ${MODES.map((mode) => `--${mode}`).join(' / ')}`)
    return { ...options, selftest: true }
  }
  options.target = ['doi', 'refs', 'cited-by', 'oa', 'cite', 'verify', 'related'].includes(options.mode) ? String(value(options.mode) ?? '') : ''
  options.search = options.mode === 'search' ? String(value('search') ?? '') : ''
  if (['doi', 'refs', 'cited-by', 'oa', 'cite', 'verify', 'related'].includes(options.mode) && options.target.trim() === '') {
    throw new UsageError(`--${options.mode} needs its identifier`)
  }
  if (options.mode === 'search' && options.search.trim() === '') throw new UsageError('--search needs a query')
  if (options.mode === 'cite') {
    try {
      options.citeDoi = citeDoi(options.target)
    } catch (error) {
      throw new UsageError(error.message)
    }
  }
  if (options.mode === 'verify' && workRef(options.target).kind !== 'doi') {
    throw new UsageError('--verify reads a DOI record through Crossref; an OpenAlex id has no registry record to check')
  }
  const expectTitle = value('expect-title')
  if (expectTitle !== null) {
    if (options.mode !== 'verify') throw new UsageError('--expect-title applies to --verify only')
    options.expectTitle = String(expectTitle)
  }
  const expectYear = value('expect-year')
  if (expectYear !== null) {
    if (options.mode !== 'verify') throw new UsageError('--expect-year applies to --verify only')
    options.expectYear = String(expectYear)
  }
  const expectAuthor = value('expect-author')
  if (expectAuthor !== null) {
    if (options.mode !== 'verify') throw new UsageError('--expect-author applies to --verify only')
    options.expectAuthor = String(expectAuthor)
  }

  const format = value('format')
  if (format !== null) {
    if (options.mode !== 'cite') throw new UsageError('--format applies to --cite only')
    if (!CITE_FORMATS.includes(format)) throw new UsageError(`--format takes ${CITE_FORMATS.join(' or ')}, got '${format}'`)
    options.citeFormat = format
  }
  const style = value('style')
  if (style !== null) {
    if (options.mode !== 'cite') throw new UsageError('--style applies to --cite only')
    options.citeStyle = String(style)
  }
  const locale = value('locale')
  if (locale !== null) {
    if (options.mode !== 'cite') throw new UsageError('--locale applies to --cite only')
    options.citeLocale = String(locale)
  }

  const source = value('source')
  if (source !== null) {
    if (!SOURCES.includes(source)) throw new UsageError(`--source takes ${SOURCES.join(' or ')}, got '${source}'`)
    options.source = source
  }
  if (source !== null && options.mode === 'oa') throw new UsageError('--oa reads Unpaywall only; --source does not apply')
  if (source !== null && options.mode === 'cite') throw new UsageError('--cite reads doi.org; --source does not apply')
  if (source !== null && (options.mode === 'verify' || options.mode === 'related')) {
    throw new UsageError(`--${options.mode} reads one channel; --source does not apply`)
  }
  if (options.mode === 'verify') options.source = 'crossref'
  if (options.mode === 'related') options.source = 'openalex'
  if (source === 'crossref' && options.mode === 'cited-by') {
    throw new UsageError('--cited-by reads OpenAlex only: Crossref carries a count, not a citing list')
  }
  if (options.mode === 'cited-by' && workRef(options.target).kind !== 'openalex') {
    throw new UsageError(
      '--cited-by needs an OpenAlex work id (W...): `cites:` is an id filter, so resolve the DOI with --doi first (one request per invocation)',
    )
  }
  const rows = value('rows')
  if (rows !== null) {
    if (!['search', 'cited-by'].includes(options.mode)) {
      throw new UsageError(`--rows applies to a result list; --${options.mode} answers one record`)
    }
    options.rows = integer('rows', rows, { min: 1, max: MAX_ROWS })
  }
  const abstract = value('abstract')
  if (abstract !== null) {
    if (!['doi', 'refs'].includes(options.mode)) throw new UsageError(`--abstract applies to a work record, not to --${options.mode}`)
    options.abstractChars = integer('abstract', abstract, { min: 0, max: 20_000 })
  }
  const mailto = value('mailto')
  if (mailto !== null) options.mailto = String(mailto).trim()
  if (options.mode === 'oa' && options.mailto === '') {
    throw new UsageError(
      '--oa needs --mailto <address> or AUTORESEARCH_MAILTO: Unpaywall takes the address in its own `email=` parameter, so it cannot be asked without one',
    )
  }
  options.json = flag('json')
  return options
}

/** One request. No retry: a rate limit or an outage is a finding about the channel, not a loop. */
async function fetchOnce(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { status: response.status, body: await response.text() }
}

/** A creator list with its count, which is what a reader checks a record against. */
function describeAuthors(names) {
  if (names.length === 0) return 'unknown'
  const shown = names.length <= 4 ? names : [...names.slice(0, 3), 'et al.']
  return `${names.length}  (${shown.join('; ')})`
}

/** Today, as the retrieval date every quoted count has to carry. */
function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * One work record as lines a report can quote.
 *
 * @param {object} work A normalized record.
 * @param {{asked: string, abstractChars: number}} context What was asked, and the abstract budget.
 * @returns {string} The block.
 */
export function formatWork(work, context) {
  const asked = normalizeDoi(context.asked)
  const lines = [
    `mode     : work record (${work.source})`,
    `asked    : ${asked}`,
    `answered : ${work.doi}${work.doi !== '' && asked !== '' && work.doi !== asked ? '   <- DIFFERENT from the DOI asked for; quote both' : ''}`,
    `title    : ${work.title || '(no title in this record)'}`,
    `year     : ${work.year ?? 'unknown'}`,
    `venue    : ${work.venue || '(none in this record)'}`,
    `authors  : ${describeAuthors(work.authors)}`,
    `type     : ${work.type || 'unknown'}`,
  ]
  if (work.source === 'openalex') {
    lines.push(
      `cited by : ${work.citedBy ?? 'unknown'}  (OpenAlex cited_by_count, retrieved ${today()} - a snapshot, not a stable property)`,
    )
    lines.push(`open acc.: ${[work.oaStatus, work.oaUrl].filter(Boolean).join('  ') || '(not reported)'}`)
  } else {
    lines.push(
      `cited by : ${work.citedBy ?? 'unknown'}  (Crossref is-referenced-by-count, retrieved ${today()} - a snapshot, and it need not match OpenAlex)`,
    )
    if (work.oaUrl) lines.push(`url      : ${work.oaUrl}`)
  }
  const count = work.references.length
  lines.push(`refs     : ${count}${count > 0 ? '  (--refs lists them)' : ''}`)
  const limit = context.abstractChars
  if (work.abstract === '') {
    lines.push(
      work.source === 'openalex'
        ? 'abstract : (absent in this record - OpenAlex ships only abstract_inverted_index and it is often missing; do not write one from the title)'
        : 'abstract : (absent in this record - do not write one from the title)',
    )
  } else if (limit === 0) {
    lines.push(`abstract : [omitted by --abstract 0; ${work.abstract.length} characters available from this record]`)
  } else if (work.abstract.length <= limit) {
    lines.push(`abstract : ${work.abstract}${work.source === 'openalex' ? '  [rebuilt from abstract_inverted_index]' : ''}`)
  } else {
    lines.push(
      `abstract : ${work.abstract.slice(0, limit)} ... [${work.abstract.length - limit} characters held back; --abstract ${work.abstract.length} shows all]${work.source === 'openalex' ? '  [rebuilt from abstract_inverted_index]' : ''}`,
    )
  }
  return lines.join('\n')
}

/**
 * A candidate list, which is deliberately not shaped like a record.
 *
 * @param {object[]} works Normalized records, already bounded by `--rows`.
 * @param {{source: string, query: string, total: number|null, rows: number}} context Where they came from.
 * @returns {string} The block.
 */
export function formatSearch(works, context) {
  const lines = [
    `mode     : candidate list (${context.source} search) - NOT a work record`,
    `query    : ${context.query}`,
    `scope    : ${context.total === null ? 'total unknown' : `total ${context.total}`} · showing ${works.length} · rows ${context.rows}`,
    'nothing here is confirmed metadata: confirm one with --doi <its doi> before quoting it',
    '',
  ]
  if (context.parsed) lines.splice(3, 0, `parsed   : ${context.parsed}   [the API's own reading of the query]`)
  if (context.notice) lines.splice(4, 0, `notice   : ${context.notice}`)
  works.forEach((work, index) => {
    lines.push(
      `${String(index + 1).padStart(2)}. ${work.title || '(no title)'} · ${work.year ?? 'unknown'} · cited ${work.citedBy ?? 'unknown'} · ${work.doi || '(no doi)'}`,
    )
    if (work.venue) lines.push(`    ${work.venue}`)
  })
  if (works.length === 0) lines.push('0 results - the query was answered and matched nothing. This is not a failure.')
  return lines.join('\n')
}

/**
 * Referenced works, as ids and a count, from the one record that carries them.
 *
 * @param {object} work A normalized record.
 * @returns {string} The block.
 */
export function formatRefs(work) {
  const ids = work.references.map((reference) => referenceLabel(reference))
  const lines = [
    `mode     : referenced works of ${work.doi || work.id} (${work.source}) - what this work cites`,
    `title    : ${work.title || '(no title)'}`,
    `count    : ${ids.length}`,
  ]
  const shown = ids.slice(0, IDS_SHOWN)
  shown.forEach((id, index) => lines.push(`${String(index + 1).padStart(3)}. ${id}`))
  if (ids.length > shown.length) {
    lines.push(`... ${ids.length - shown.length} more held back; this tool makes one request, so read the rest from the source`)
  }
  if (ids.length > 0 && work.source === 'openalex') lines.push('resolve one with: --doi <id>')
  return lines.join('\n')
}

/**
 * Works that cite the given one, as a candidate list.
 *
 * @param {object[]} works Normalized records.
 * @param {{target: string, total: number|null, rows: number}} context What was asked.
 * @returns {string} The block.
 */
export function formatCitedBy(works, context) {
  const lines = [
    `mode     : candidate list (OpenAlex, works citing ${context.target}) - NOT a work record`,
    `scope    : ${context.total === null ? 'total unknown' : `total ${context.total}`} · showing ${works.length} · rows ${context.rows}`,
    'one page only: a second page is a second invocation',
    '',
  ]
  works.forEach((work, index) => {
    lines.push(`${String(index + 1).padStart(2)}. ${work.title || '(no title)'} · ${work.year ?? 'unknown'} · cited ${work.citedBy ?? 'unknown'} · ${work.doi || work.id || '(no id)'}`)
  })
  if (works.length === 0) lines.push('0 results - this work has no citing works indexed here.')
  return lines.join('\n')
}

/**
 * The open-access lead, and what it is not.
 *
 * @param {object} record A normalized Unpaywall record.
 * @returns {string} The block.
 */
export function formatOa(record) {
  const lines = [
    'mode     : open-access lead (Unpaywall)',
    `doi      : ${record.doi}`,
    `is_oa    : ${record.isOa} · ${record.status || 'status not reported'}`,
    `best     : ${record.best || '(none offered)'}`,
  ]
  record.locations.slice(0, 5).forEach((entry) => lines.push(`  also   : ${entry.url}  [${entry.host} ${entry.version}]`))
  lines.push('a listed copy is a LEAD, not a retrieval: only fetching that url shows what is there, and a dead or wrong-version link is a failed lead to report rather than drop')
  return lines.join('\n')
}

/**
 * One registry record as a verification report.
 *
 * @param {object} work A normalized Crossref record.
 * @param {{checks: object[], retractions: object[], retracted: boolean}} verdict The comparison.
 * @returns {string} The report.
 */
export function formatVerify(work, verdict) {
  const lines = [
    'mode     : registry record (Crossref)',
    `doi      : ${work.doi || '(none)'}`,
    `title    : ${work.title || '(none)'}`,
    `authors  : ${describeAuthors(work.authors)}`,
    `year     : ${work.year ?? '(none)'}`,
    `venue    : ${work.venue || '(none)'}`,
    `retracted: ${verdict.retracted ? 'YES - a retraction notice is registered' : 'no retraction notice registered'}`,
  ]
  for (const update of verdict.retractions) {
    lines.push(`  notice : ${update.type} ${update.doi}${update.label ? ` - ${update.label}` : ''}`)
  }
  if (verdict.checks.length === 0) {
    lines.push('match    : no expectation was given; only existence and retraction were checked')
  } else {
    for (const check of verdict.checks) {
      lines.push(
        `match    : ${check.field} ${check.ok ? 'OK' : 'MISMATCH'} · expected ${JSON.stringify(check.expected)} · found ${JSON.stringify(check.found)}`,
      )
    }
  }
  lines.push('note     : a match means the registry does not contradict the claim, not that the paper supports it')
  return lines.join('\n')
}

/**
 * One work's OpenAlex related list.
 *
 * @param {object} work A normalized OpenAlex record.
 * @returns {string} The report.
 */
export function formatRelated(work) {
  const lines = [
    'mode     : related works (OpenAlex)',
    `work     : ${work.title || work.id || '(none)'}`,
    `doi      : ${work.doi || '(none)'}`,
    `related  : ${work.related.length}`,
  ]
  for (const id of work.related) lines.push(`  ${id}   resolve with --doi ${id}`)
  if (work.related.length === 0) lines.push('none     : OpenAlex lists no related works for this record; this is not a failure')
  lines.push('note     : related works are a similarity list, not citations; resolve one with --doi before using it')
  return lines.join('\n')
}

/** The name this round should use for the channel it asked. Unpaywall answers `--oa` only. */
function channelName(options) {
  return options.mode === 'oa' ? 'Unpaywall' : options.source
}

/**
 * A short excerpt of an answer body, and nothing at all when that body is markup.
 *
 * A 404 from these channels often carries an HTML error page. Dumping it printed a screen of tags with
 * no information in it, and the reader's question was already answered by the status.
 */
export function summaryOf(body) {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (text === '' || text.startsWith('<') || /<html|<!doctype/i.test(text.slice(0, 200))) return ''
  return text.slice(0, 160)
}

/** The command that would run this same tool, as an absolute path a reader can paste. */
const CLI = `node "${fileURLToPath(import.meta.url)}"`

/**
 * The one thing to do when a channel answers 404, per mode.
 *
 * Narrow on purpose. `--cited-by` reads OpenAlex ids only, `--oa` reads Unpaywall only, and `--refs`
 * accepts a bare OpenAlex id that Crossref cannot resolve - so the "ask the other channel" swap is
 * offered only where the command it hands over would actually work. Everything else gets prose.
 */
export function missingRecordRemedy(options) {
  const target = options.target
  if (options.mode === 'cited-by') {
    return { fix: '--cited-by reads OpenAlex work ids; if this is a DOI, resolve it with --doi first' }
  }
  if (options.mode === 'related') {
    return { fix: '--related reads OpenAlex works; if this is a DOI, OpenAlex answers it - check the string, then retry' }
  }
  if (options.mode === 'verify') {
    return {
      fix: 'a DOI Crossref does not register is a finding, not a channel mismatch: check the string before citing it',
    }
  }
  if (options.mode === 'oa') {
    return {
      fix: 'Unpaywall lists open-access copies only, so a DOI with no open copy answers 404 here - the record itself may still exist',
      command: `${CLI} --doi ${target}`,
    }
  }
  const other = options.source === 'crossref' ? 'openalex' : 'crossref'
  if (options.mode !== 'search' && !target.startsWith('10.')) {
    return { fix: `the two channels index different records; ${other} resolves DOIs, so ask by DOI with --doi` }
  }
  const asked = options.mode === 'search' ? `--search "${options.search}"` : `--${options.mode} ${target}`
  return {
    fix: `the two channels index different records - the same DOI is often in one and not the other; ask ${other}`,
    command: `${CLI} ${asked} --source ${other}`,
  }
}

/**
 * One line per kind of nothing, each distinguishable from the others - and, where exactly one action
 * helps, that action.
 *
 * The 404 is the one that matters: this file's header records a measured case where the same arXiv DOI
 * answered 200 on OpenAlex and 404 on Crossref. That knowledge used to live in a comment; the reader who
 * hits the 404 is the one who needs it.
 *
 * @param {'rate-limited'|'not-found'|'not-json'|'failed'} kind What kind of answer this was.
 * @param {{status: number, body: string}} response The raw answer.
 * @param {object} options The parsed command line.
 * @returns {Error} A Refusal when the way out is known, a plain Error when it is not.
 */
function channelFailure(kind, response, options) {
  const head = summaryOf(response.body)
  const source = channelName(options)
  if (kind === 'rate-limited') {
    return new Refusal(`HTTP 429: ${source} is asking this client to slow down`, {
      fix: 'wait a minute and ask again - the number is a limit on rate, not a verdict on the query',
    })
  }
  if (kind === 'not-found') {
    const asked = options.mode === 'search' ? `"${options.search}"` : options.target
    return new Refusal(`${source} has no record for ${asked}`, missingRecordRemedy(options))
  }
  if (kind === 'not-json') {
    return new Error(`HTTP ${response.status} from ${source}, and the body is not JSON${head ? `: ${head}` : ''}`)
  }
  return new Error(`HTTP ${response.status} from ${source}${head ? `: ${head}` : ''}`)
}

/** Render one answered request. */
function render(options, payload) {
  const retrieved = today()
  if (options.mode === 'search') {
    const works =
      options.source === 'crossref'
        ? (payload?.message?.items ?? []).map((record) => normalizeCrossrefWork(record))
        : (payload?.results ?? []).map((record) => normalizeOpenAlexWork(record))
    const total = options.source === 'crossref' ? (payload?.message?.['total-results'] ?? null) : (payload?.meta?.count ?? null)
    return formatSearch(works, {
      source: options.source,
      query: options.search,
      total,
      rows: options.rows,
      parsed: String(payload?.meta?.x_query?.oql ?? ''),
      notice: boundedNotice(payload?.meta?.notice),
    })
  }
  if (options.mode === 'cited-by') {
    const works = (payload?.results ?? []).map((record) => normalizeOpenAlexWork(record))
    return formatCitedBy(works, { target: options.target, total: payload?.meta?.count ?? null, rows: options.rows })
  }
  if (options.mode === 'oa') return formatOa(normalizeUnpaywall(payload))
  const work =
    options.source === 'crossref'
      ? normalizeCrossrefWork(payload?.message ?? {})
      : normalizeOpenAlexWork(payload ?? {})
  if (options.mode === 'refs') return formatRefs(work)
  return `${formatWork(work, { asked: options.target, abstractChars: options.abstractChars })}\nretrieved: ${retrieved}`
}

/** The record the request actually answered, which is what `--json` prints. */
function jsonView(options, payload) {
  if (options.mode === 'search') {
    const works =
      options.source === 'crossref'
        ? (payload?.message?.items ?? []).map((record) => normalizeCrossrefWork(record))
        : (payload?.results ?? []).map((record) => normalizeOpenAlexWork(record))
    return {
      mode: 'search',
      source: options.source,
      query: options.search,
      retrieved: today(),
      total: options.source === 'crossref' ? (payload?.message?.['total-results'] ?? null) : (payload?.meta?.count ?? null),
      parsedAs: String(payload?.meta?.x_query?.oql ?? ''),
      notice: boundedNotice(payload?.meta?.notice),
      candidates: works,
    }
  }
  if (options.mode === 'cited-by') {
    return { mode: 'cited-by', target: options.target, retrieved: today(), candidates: (payload?.results ?? []).map((record) => normalizeOpenAlexWork(record)) }
  }
  if (options.mode === 'oa') return { mode: 'oa', retrieved: today(), openAccess: normalizeUnpaywall(payload) }
  const work =
    options.source === 'crossref'
      ? normalizeCrossrefWork(payload?.message ?? {})
      : normalizeOpenAlexWork(payload ?? {})
  return { mode: options.mode, asked: options.target, retrieved: today(), work }
}

/** One citation request. It carries its own Accept header, which the JSON transport cannot. */
async function fetchCitation(url, accept) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return {
    status: response.status,
    contentType: String(response.headers.get('content-type') ?? ''),
    body: await response.text(),
  }
}

/**
 * Ask the DOI resolver for one authoritative citation.
 *
 * A landing page is not a citation: when content negotiation is unsupported the resolver answers HTML
 * with a 200, and printing that would put a web page where a reference belongs.
 */
async function runCite(options) {
  const accept = citeAccept(options.citeFormat, options.citeStyle, options.citeLocale)
  const result = await fetchCitation(citeUrl(options.citeDoi), accept)
  if (result.status === 404) {
    throw new Refusal(`doi.org has no registered record for ${options.citeDoi} (404)`, {
      fix: 'check the identifier; a DOI is not a title, and a preprint may carry a DataCite DOI instead',
    })
  }
  if (result.status === 406) {
    throw new Refusal(`the registration agency cannot answer ${options.citeDoi} as ${options.citeFormat}`, {
      fix: 'try --format text or --format csljson, which the registration agencies answer most often',
    })
  }
  if (result.status === 429) {
    throw new Refusal('doi.org is asking this client to slow down (429)', {
      fix: 'wait a minute and retry the same identifier once',
    })
  }
  if (result.status !== 200) {
    throw new Refusal(`doi.org answered HTTP ${result.status} for ${options.citeDoi}`, {
      fix: 'retry once; if it repeats, the DOI resolver is unavailable rather than the record missing',
    })
  }
  if (result.contentType.toLowerCase().includes('text/html')) {
    throw new Refusal(`the registration agency answered an HTML page, not a ${options.citeFormat} citation`, {
      fix: 'this DOI may not support content negotiation; read its Crossref record with --doi instead',
    })
  }
  const text = result.body.trim()
  if (text === '') {
    throw new Refusal(`doi.org returned an empty ${options.citeFormat} answer for ${options.citeDoi}`, {
      fix: 'try --format csljson, which every registration agency answers',
    })
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          target: options.target,
          doi: options.citeDoi,
          format: options.citeFormat,
          style: options.citeFormat === 'text' ? options.citeStyle : undefined,
          locale: options.citeFormat === 'text' ? options.citeLocale : undefined,
          retrieved: today(),
          text,
        },
        null,
        2,
      ),
    )
    return 0
  }
  console.log(text)
  return 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.selftest) {
    // The checks live beside this file, mirroring it. They report through `failedChecks` instead of
    // calling process.exit themselves, which would trip Node's unsettled-top-level-await check.
    const { failedChecks } = await import('./tests/metadata-selftest.mjs')
    if (failedChecks) process.exit(1)
    return
  }

  if (options.mode === 'cite') {
    process.exitCode = await runCite(options)
    return
  }

  if (options.mode === 'verify' || options.mode === 'related') {
    const response = await fetchOnce(buildUrl(options))
    const kind = classifyResponse(response)
    if (kind !== 'json') throw channelFailure(kind, response, options)
    const payload = JSON.parse(response.body)
    const error = errorMessage(payload)
    if (error !== '') throw new Error(`${options.source} reported an error at HTTP ${response.status}: ${error}`)
    if (options.mode === 'verify') {
      const work = normalizeCrossrefWork(payload?.message ?? {})
      const verdict = verifyWork(work, {
        title: options.expectTitle,
        year: options.expectYear,
        author: options.expectAuthor,
      })
      console.log(
        options.json
          ? JSON.stringify({ mode: 'verify', retrieved: today(), work, ...verdict }, null, 2)
          : formatVerify(work, verdict),
      )
      return
    }
    const work = normalizeOpenAlexWork(payload ?? {})
    console.log(options.json ? JSON.stringify({ mode: 'related', retrieved: today(), work }, null, 2) : formatRelated(work))
    return
  }

  const url = buildUrl(options)
  const response = await fetchOnce(url)
  const kind = classifyResponse(response)
  if (kind !== 'json') throw channelFailure(kind, response, options)
  const payload = JSON.parse(response.body)
  const error = errorMessage(payload)
  if (error !== '') {
    throw new Error(`${options.source} reported an error at HTTP ${response.status}: ${error}`)
  }
  console.log(options.json ? JSON.stringify(jsonView(options, payload), null, 2) : render(options, payload))
}

// Only act when this file IS the command: the self-test imports the pure functions above, and an
// import must not make a network request.
const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

// NOT `await main()`: this module is the entry point AND it dynamically imports its own self-test,
// which statically imports this file back. A pending top-level await here would make that cycle wait
// on itself - the self-test body never runs and the process exits 13 with only a warning.
if (isEntryPoint) {
  main().catch((error) => {
    process.exitCode = reportFailure(error, { usage: USAGE })
  })
}
