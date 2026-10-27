#!/usr/bin/env node
// Source adapters for the scholarly search helper.
//
// WHY THIS FILE EXISTS
//
// Seven indexes answer a literature query in seven shapes, and each one fails in its own way. The
// search helper needs one paper shape and one failure shape, so the normalisation lives here rather
// than in the command that fans out. Keeping the adapters pure (a response in, papers or a typed
// failure out) is what lets the self-test pin every parser without a network.
//
// WHAT THIS FILE DOES NOT DO
//
// It does not decide which sources to ask, fuse the results, or mark the library. Those are the
// command's jobs. It also does not retry: one invocation asks each source once, and a failure is
// reported as a failure rather than hidden behind a loop.
//
// MEASURED SOURCE FACTS (2026-10-24, no API key)
//
//   * Semantic Scholar answered HTTP 429 from the shared pool. It is therefore only asked when
//     AUTORESEARCH_S2_KEY is set, or when the caller names it explicitly (which then reports the 429).
//   * DBLP answered HTTP 202 with an Anubis bot-challenge HTML page, also with a browser User-Agent.
//     This client cannot pass that page; the adapter reports `blocked` and never pretends it is empty.
//   * PubMed search is two requests (esearch then esummary), both JSON; efetch XML is not used, so no
//     XML parser is introduced.
import { parseFeed } from './arxiv.mjs'
import {
  normalizeCrossrefWork,
  normalizeDoi,
  normalizeOpenAlexWork,
  openAlexIdOf,
  plainText,
} from './metadata.mjs'

/** The source ids, in the order a result block reports them. */
export const SOURCE_IDS = [
  'arxiv',
  'openalex',
  'crossref',
  'semanticscholar',
  'pubmed',
  'europepmc',
  'dblp',
]

/** The name a reader sees for each source id. */
export const SOURCE_NAMES = {
  arxiv: 'arXiv',
  openalex: 'OpenAlex',
  crossref: 'Crossref',
  semanticscholar: 'Semantic Scholar',
  pubmed: 'PubMed',
  europepmc: 'Europe PMC',
  dblp: 'DBLP',
}

const USER_AGENT = 'dsh-autoresearch/1.0 (scholarly helper)'
const REQUEST_TIMEOUT_MS = 30_000

/**
 * A failure one source can report without taking the whole search down.
 *
 * `code` is what a caller reasons about: `rate-limited` means the source asked us to slow down,
 * `blocked` means the source answered a page this client cannot pass, `no-key` means the source is
 * known to be unusable without a credential, and the rest are transport or parse failures.
 */
export class SourceError extends Error {
  /**
   * @param {string} message What happened, in the reader's terms.
   * @param {{code?: string, retryable?: boolean}} [options] The typed cause.
   */
  constructor(message, { code = 'failed', retryable = false } = {}) {
    super(message)
    this.name = 'SourceError'
    this.code = code
    this.retryable = retryable
  }
}

/**
 * One HTTP request. No retries, no redirects beyond `fetch`'s own, a hard timeout.
 *
 * @param {string} url The absolute URL.
 * @param {{accept?: string, headers?: Record<string, string>, timeoutMs?: number}} [options] Request knobs.
 * @returns {Promise<{status: number, contentType: string, body: string}>} The answer, unparsed.
 * @throws {SourceError} When the request itself failed.
 */
export async function requestText(url, { accept = 'application/json', headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let response
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept, ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new SourceError(`request failed: ${error?.message ?? error}`, { code: 'network' })
  }
  let body = ''
  try {
    body = await response.text()
  } catch (error) {
    throw new SourceError(`the body could not be read: ${error?.message ?? error}`, { code: 'network' })
  }
  return { status: response.status, contentType: String(response.headers.get('content-type') ?? ''), body }
}

/**
 * Parse one JSON answer, turning the four kinds of "no" into typed failures.
 *
 * @param {{status: number, contentType: string, body: string}} response The raw answer.
 * @param {string} source The source's display name, for the message.
 * @returns {any} The parsed body.
 * @throws {SourceError} On rate limiting, an HTTP error, or a body that is not JSON.
 */
export function jsonOf(response, source) {
  if (response.status === 429) {
    throw new SourceError(`${source} rate-limited this client (HTTP 429)`, { code: 'rate-limited', retryable: true })
  }
  if (response.status === 403) {
    throw new SourceError(`${source} refused this client (HTTP 403)`, { code: 'blocked' })
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SourceError(`${source} answered HTTP ${response.status}: ${response.body.slice(0, 160)}`, { code: 'http' })
  }
  try {
    return JSON.parse(response.body)
  } catch {
    throw new SourceError(`${source} answered a body that is not JSON`, { code: 'parse' })
  }
}

/** A DOI in the form the sources write it, or ''. */
export function cleanDoi(value) {
  return normalizeDoi(value)
}

/** The arXiv id inside a value, or ''. Handles `arXiv:`, DataCite DOIs, and bare ids. */
export function arxivIdOf(value) {
  const text = String(value ?? '').trim()
  const direct = /^(?:arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?$/i.exec(text)?.[1]
  if (direct) return direct
  const doi = /10\.48550\/arxiv\.(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(text)?.[1]
  if (doi) return doi
  return /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i.exec(text)?.[1] ?? ''
}

/** The 4-digit year at the start of a date-ish string, or undefined. */
export function yearOf(value) {
  const match = /(1[5-9]\d\d|20\d\d)/.exec(String(value ?? ''))
  return match ? Number(match[1]) : undefined
}

/**
 * One paper, in the single shape every source converges to.
 *
 * Missing values are `undefined`, never `''`: "the source did not say" and "the source said empty"
 * are different facts, and a title of '' would win a fusion slot.
 *
 * @param {object} paper A partially filled paper.
 * @returns {object} The normalized paper.
 */
export function normalizePaper(paper) {
  const title = plainText(paper.title ?? '').trim()
  const doi = cleanDoi(paper.doi ?? '')
  const arxiv = paper.arxiv || arxivIdOf(doi)
  return {
    ...paper,
    title,
    authors: [...new Set((paper.authors ?? []).map((author) => String(author).trim()).filter(Boolean))],
    year: Number.isInteger(paper.year) ? paper.year : yearOf(paper.year ?? paper.date),
    doi: doi || undefined,
    arxiv: arxiv || undefined,
    pmid: paper.pmid ? String(paper.pmid) : undefined,
    pmcid: paper.pmcid ? String(paper.pmcid).toUpperCase() : undefined,
    openalex: paper.openalex || undefined,
    s2: paper.s2 || undefined,
    citations: Number.isFinite(paper.citations) ? paper.citations : undefined,
    openAccess: paper.openAccess === true ? true : paper.openAccess === false ? false : undefined,
    pdfUrl: String(paper.pdfUrl ?? '').trim() || undefined,
    url: String(paper.url ?? '').trim() || undefined,
    abstract: plainText(paper.abstract ?? '') || undefined,
    sources: [...new Set((paper.sources ?? []).filter(Boolean))],
  }
}

// --- adapters ------------------------------------------------------------------------------------

/** One arXiv Atom entry as a paper. */
export function paperFromArxiv(entry) {
  const id = entry.base || entry.bare || arxivIdOf(entry.id)
  return normalizePaper({
    title: entry.title,
    authors: entry.authors,
    year: yearOf(entry.published),
    date: entry.published,
    venue: entry.journalRef || 'arXiv',
    doi: entry.doi || (id ? `10.48550/arXiv.${id}` : ''),
    arxiv: id,
    url: entry.absUrl || (id ? `https://arxiv.org/abs/${id}` : ''),
    pdfUrl: entry.pdfUrl || (id ? `https://arxiv.org/pdf/${id}` : ''),
    openAccess: true,
    abstract: entry.summary,
    type: 'preprint',
    sources: ['arxiv'],
  })
}

/** One OpenAlex work as a paper. */
export function paperFromOpenAlex(record) {
  const work = normalizeOpenAlexWork(record)
  return normalizePaper({
    title: work.title,
    authors: work.authors,
    year: work.year,
    venue: work.venue,
    doi: work.doi,
    openalex: work.id,
    citations: work.citedBy ?? undefined,
    openAccess: work.oaStatus === '' ? undefined : work.oaStatus !== 'closed',
    pdfUrl: work.oaUrl,
    url: work.doi ? `https://doi.org/${work.doi}` : undefined,
    abstract: work.abstract,
    type: work.type,
    sources: ['openalex'],
  })
}

/** One Crossref work as a paper. */
export function paperFromCrossref(record) {
  const work = normalizeCrossrefWork(record)
  return normalizePaper({
    title: work.title,
    authors: work.authors,
    year: work.year,
    venue: work.venue,
    doi: work.doi,
    citations: work.citedBy ?? undefined,
    url: work.doi ? `https://doi.org/${work.doi}` : work.oaUrl,
    abstract: work.abstract,
    type: work.type,
    sources: ['crossref'],
  })
}

/** One Semantic Scholar entry as a paper. */
export function paperFromSemanticScholar(entry) {
  const ids = entry.externalIds ?? {}
  return normalizePaper({
    title: entry.title,
    authors: (entry.authors ?? []).map((author) => author?.name),
    year: entry.year,
    venue: entry.venue,
    doi: ids.DOI,
    arxiv: ids.ArXiv,
    pmid: ids.PubMed,
    s2: entry.paperId,
    citations: entry.citationCount,
    openAccess: entry.openAccessPdf ? true : undefined,
    pdfUrl: entry.openAccessPdf?.url,
    url: entry.url,
    abstract: entry.abstract,
    sources: ['semanticscholar'],
  })
}

/** One PubMed esummary record as a paper. */
export function paperFromPubmed(uid, summary) {
  const articleIds = Array.isArray(summary?.articleids) ? summary.articleids : []
  const idOf = (type) => articleIds.find((entry) => entry?.idtype === type)?.value ?? ''
  const doi = idOf('doi')
  const pmcid = idOf('pmc')
  return normalizePaper({
    title: summary?.title,
    authors: (summary?.authors ?? []).map((author) => author?.name),
    year: yearOf(summary?.pubdate),
    date: summary?.pubdate,
    venue: summary?.fulljournalname || summary?.source,
    doi,
    pmid: uid,
    pmcid,
    url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
    sources: ['pubmed'],
  })
}

/** One Europe PMC record as a paper. */
export function paperFromEuropePmc(entry) {
  const pdfUrl = (entry.fullTextUrlList?.fullTextUrl ?? []).find((item) => item?.documentStyle === 'pdf')?.url
  const listedAuthors = (entry.authorList?.author ?? []).map((author) => author?.fullName ?? author?.collectiveName ?? '')
  const splitAuthors = String(entry.authorString ?? '')
    .split(',')
    .map((author) => author.trim())
    .filter(Boolean)
  return normalizePaper({
    title: entry.title,
    authors: splitAuthors.length > 0 ? splitAuthors : listedAuthors,
    year: entry.pubYear,
    venue: entry.journalTitle || entry.journalInfo?.journal?.title,
    doi: entry.doi,
    pmid: entry.pmid,
    pmcid: entry.pmcid,
    citations: entry.citedByCount,
    openAccess: entry.isOpenAccess === 'Y' ? true : undefined,
    pdfUrl,
    url: entry.pmcid ? `https://europepmc.org/article/PMC/${entry.pmcid}` : entry.pmid ? `https://europepmc.org/article/MED/${entry.pmid}` : undefined,
    abstract: entry.abstractText,
    sources: ['europepmc'],
  })
}

/** One DBLP hit as a paper. */
export function paperFromDblp(hit) {
  const info = hit?.info ?? {}
  const authors = Array.isArray(info.authors?.author)
    ? info.authors.author.map((author) => (typeof author === 'string' ? author : author?.text))
    : [info.authors?.author?.text ?? info.authors?.author].filter(Boolean)
  return normalizePaper({
    title: info.title,
    authors,
    year: info.year,
    venue: info.venue,
    doi: info.doi,
    url: info.ee || info.url,
    type: 'article',
    sources: ['dblp'],
  })
}

// --- searches ------------------------------------------------------------------------------------

/**
 * Search arXiv.
 *
 * A bare query is turned into `(ti:"…" OR abs:"…")`; a fielded query (`au:`, `cat:`, `all:`) is passed
 * through, because the caller already knows the syntax. A zero-result answer is an empty list, never
 * an error.
 */
export async function searchArxiv(query) {
  const text = query.query.trim()
  const fielded = /\b(?:ti|au|abs|cat|co|jr|rn|all|id):/.test(text)
  const phrase = text.replace(/"/g, ' ')
  const terms = fielded ? `(${text})` : `(ti:"${phrase}" OR abs:"${phrase}")`
  const parts = [terms]
  if (query.categories?.length) parts.push(`(${query.categories.map((category) => `cat:${category}`).join(' OR ')})`)
  if (query.yearFrom !== undefined || query.yearTo !== undefined) {
    const from = String(query.yearFrom ?? 1991).padStart(4, '0')
    const to = String(query.yearTo ?? 2100).padStart(4, '0')
    parts.push(`submittedDate:[${from}01010000 TO ${to}12312359]`)
  }
  const params = new URLSearchParams({
    search_query: parts.join(' AND '),
    start: '0',
    max_results: String(query.limit),
    sortBy: query.sort === 'date' ? 'submittedDate' : 'relevance',
    sortOrder: 'descending',
  })
  const response = await requestText(`https://export.arxiv.org/api/query?${params}`, { accept: 'application/atom+xml' })
  if (response.status !== 200) {
    throw new SourceError(`arXiv answered HTTP ${response.status}`, { code: 'http' })
  }
  let feed
  try {
    feed = parseFeed(response.body)
  } catch (error) {
    throw new SourceError(`arXiv answered a body that is not an Atom feed: ${error.message}`, { code: 'parse' })
  }
  if (feed.error) throw new SourceError(`arXiv reported an error: ${feed.error}`, { code: 'http' })
  return feed.entries.map(paperFromArxiv)
}

/** Search OpenAlex. */
export async function searchOpenAlex(query, keys = {}) {
  const params = new URLSearchParams({ search: query.query, 'per-page': String(query.limit) })
  const filters = []
  if (query.yearFrom !== undefined || query.yearTo !== undefined) {
    filters.push(`publication_year:${query.yearFrom ?? ''}-${query.yearTo ?? ''}`)
  }
  if (query.openAccess) filters.push('open_access.is_oa:true')
  if (filters.length) params.set('filter', filters.join(','))
  if (query.sort === 'date') params.set('sort', 'publication_date:desc')
  if (query.sort === 'citations') params.set('sort', 'cited_by_count:desc')
  if (keys.mailto) params.set('mailto', keys.mailto)
  const headers = keys.openalexKey ? { authorization: `Bearer ${keys.openalexKey}` } : {}
  const response = await requestText(`https://api.openalex.org/works?${params}`, { headers })
  const body = jsonOf(response, 'OpenAlex')
  return (body.results ?? []).map(paperFromOpenAlex).filter((paper) => paper.title !== '')
}

/** Search Crossref. */
export async function searchCrossref(query, keys = {}) {
  const params = new URLSearchParams({
    'query.bibliographic': query.query,
    rows: String(query.limit),
    select: 'DOI,title,author,issued,container-title,abstract,type,is-referenced-by-count',
  })
  const filters = []
  if (query.yearFrom !== undefined) filters.push(`from-pub-date:${query.yearFrom}`)
  if (query.yearTo !== undefined) filters.push(`until-pub-date:${query.yearTo}`)
  if (filters.length) params.set('filter', filters.join(','))
  if (query.sort === 'date') params.set('sort', 'published')
  if (query.sort === 'citations') params.set('sort', 'is-referenced-by-count')
  if (keys.mailto) params.set('mailto', keys.mailto)
  const response = await requestText(`https://api.crossref.org/works?${params}`)
  const body = jsonOf(response, 'Crossref')
  return (body.message?.items ?? []).map(paperFromCrossref).filter((paper) => paper.title !== '')
}

/**
 * Search Semantic Scholar.
 *
 * Without a key this client has measured HTTP 429 from the shared pool, so the adapter refuses with
 * `no-key` instead of spending a request that is almost certain to be refused. An explicit call still
 * reaches the network only when a key exists.
 */
export async function searchSemanticScholar(query, keys = {}) {
  if (!keys.s2Key) {
    throw new SourceError('Semantic Scholar needs AUTORESEARCH_S2_KEY; the shared pool answered 429 without one', {
      code: 'no-key',
    })
  }
  const params = new URLSearchParams({
    query: query.query,
    limit: String(query.limit),
    fields: 'title,authors,year,venue,externalIds,citationCount,openAccessPdf,abstract,url',
  })
  if (query.openAccess) params.set('openAccessPdf', '')
  const response = await requestText(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, {
    headers: { 'x-api-key': keys.s2Key },
  })
  const body = jsonOf(response, 'Semantic Scholar')
  return (body.data ?? []).map(paperFromSemanticScholar).filter((paper) => paper.title !== '')
}

/** Search PubMed (esearch then esummary, both JSON). */
export async function searchPubMed(query, keys = {}) {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
  const common = { tool: 'dsh-autoresearch-scholarly', retmode: 'json' }
  if (keys.mailto) common.email = keys.mailto
  if (keys.ncbiKey) common.api_key = keys.ncbiKey
  const clauses = [query.query]
  if (query.yearFrom !== undefined || query.yearTo !== undefined) {
    clauses.push(`${query.yearFrom ?? 1800}:${query.yearTo ?? 3000}[dp]`)
  }
  if (query.openAccess) clauses.push('free full text[sb]')
  const term = clauses.length === 1 ? clauses[0] : clauses.map((clause, index) => (index === 0 ? `(${clause})` : clause)).join(' AND ')
  const searchParams = new URLSearchParams({
    db: 'pubmed',
    term,
    retmax: String(query.limit),
    sort: query.sort === 'date' ? 'pub_date' : 'relevance',
    ...common,
  })
  const searchResponse = await requestText(`${base}/esearch.fcgi?${searchParams}`)
  const found = jsonOf(searchResponse, 'PubMed')
  const ids = found.esearchresult?.idlist ?? []
  if (ids.length === 0) return []
  const fetchParams = new URLSearchParams({ db: 'pubmed', id: ids.join(','), ...common })
  const summaryResponse = await requestText(`${base}/esummary.fcgi?${fetchParams}`)
  const summary = jsonOf(summaryResponse, 'PubMed')
  return ids
    .map((id) => (summary.result?.[id] ? paperFromPubmed(id, summary.result[id]) : undefined))
    .filter((paper) => paper !== undefined && paper.title !== '')
}

/** Search Europe PMC. */
export async function searchEuropePmc(query, keys = {}) {
  const clauses = [query.query]
  if (query.yearFrom !== undefined || query.yearTo !== undefined) {
    clauses.push(`PUB_YEAR:[${query.yearFrom ?? 1800} TO ${query.yearTo ?? 2100}]`)
  }
  if (query.openAccess) clauses.push('OPEN_ACCESS:y')
  const expression = clauses.length === 1 ? clauses[0] : clauses.map((clause, index) => (index === 0 ? `(${clause})` : clause)).join(' AND ')
  const params = new URLSearchParams({
    query: expression,
    format: 'json',
    resultType: 'core',
    pageSize: String(query.limit),
  })
  if (query.sort === 'date') params.set('sort', 'P_PDATE_D desc')
  if (keys.mailto) params.set('email', keys.mailto)
  const response = await requestText(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`)
  const body = jsonOf(response, 'Europe PMC')
  return (body.resultList?.result ?? []).map(paperFromEuropePmc).filter((paper) => paper.title !== '')
}

/**
 * Search DBLP.
 *
 * DBLP has answered this client with HTTP 202 and an Anubis challenge page, including with a browser
 * User-Agent. That is `blocked`, not "no results": the body is a web page, and a caller that reads it
 * as an empty list would report a false absence.
 */
export async function searchDblp(query) {
  const params = new URLSearchParams({ q: query.query, format: 'json', h: String(Math.min(100, query.limit * 2)) })
  const response = await requestText(`https://dblp.org/search/publ/api?${params}`)
  if (response.status === 202 || response.body.trimStart().startsWith('<')) {
    throw new SourceError('DBLP answered a bot-challenge page (HTTP 202), which this client cannot pass', {
      code: 'blocked',
    })
  }
  const body = jsonOf(response, 'DBLP')
  const hits = body.result?.hits?.hit ?? []
  return hits
    .map((hit) => paperFromDblp(Array.isArray(hit) ? hit[0] : hit))
    .filter(
      (paper) =>
        paper.title !== '' &&
        (query.yearFrom === undefined || paper.year === undefined || paper.year >= query.yearFrom) &&
        (query.yearTo === undefined || paper.year === undefined || paper.year <= query.yearTo),
    )
    .slice(0, query.limit)
}

/** The search function for one source id. */
export const SEARCHERS = {
  arxiv: searchArxiv,
  openalex: searchOpenAlex,
  crossref: searchCrossref,
  semanticscholar: searchSemanticScholar,
  pubmed: searchPubMed,
  europepmc: searchEuropePmc,
  dblp: searchDblp,
}

/**
 * Resolve a reader's identifier to the OpenAlex id the graph reads.
 *
 * A PMCID is resolved through Europe PMC because OpenAlex's id filter is not guaranteed to carry the
 * PMCID form; the DOI is then the identity OpenAlex does carry.
 *
 * @param {string} raw A DOI, arXiv id, PMID, PMCID, or OpenAlex id.
 * @param {{mailto?: string}} [keys] Contact address.
 * @returns {Promise<{kind: string, id: string, openalex: string}|null>} The resolved identifier.
 */
export async function resolveIdentifier(raw, keys = {}) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  const openalex = openAlexIdOf(text)
  if (openalex) return { kind: 'openalex', id: openalex, openalex: `https://openalex.org/${openalex}` }
  const arxiv = arxivIdOf(text)
  if (arxiv) return { kind: 'arxiv', id: arxiv, openalex: `doi:10.48550/arXiv.${arxiv}` }
  const pmcid = /^(?:PMCID:\s*)?(PMC\d+)$/i.exec(text)?.[1]
  if (pmcid) {
    const params = new URLSearchParams({ query: `PMCID:${pmcid}`, format: 'json', resultType: 'lite', pageSize: '1' })
    if (keys.mailto) params.set('email', keys.mailto)
    const response = await requestText(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`)
    const body = jsonOf(response, 'Europe PMC')
    const doi = body.resultList?.result?.[0]?.doi
    return doi ? { kind: 'pmcid', id: pmcid, openalex: `doi:${cleanDoi(doi)}` } : { kind: 'pmcid', id: pmcid, openalex: '' }
  }
  const pmid = /^(?:PMID:\s*)?(\d{4,9})$/i.exec(text)?.[1]
  if (pmid) return { kind: 'pmid', id: pmid, openalex: `pmid:${pmid}` }
  const doi = cleanDoi(text)
  if (doi) return { kind: 'doi', id: doi, openalex: `doi:${doi}` }
  return null
}

/**
 * One OpenAlex work by identifier.
 *
 * @param {string} id An OpenAlex id or a `doi:`/`pmid:` form.
 * @param {{mailto?: string, openalexKey?: string}} [keys] Contact and credential.
 * @returns {Promise<object>} The work.
 */
export async function lookupOpenAlexWork(id, keys = {}) {
  const params = new URLSearchParams()
  if (keys.mailto) params.set('mailto', keys.mailto)
  const headers = keys.openalexKey ? { authorization: `Bearer ${keys.openalexKey}` } : {}
  const response = await requestText(`https://api.openalex.org/works/${encodeURIComponent(id)}${params.size ? `?${params}` : ''}`, {
    headers,
  })
  return jsonOf(response, 'OpenAlex')
}

/**
 * Papers linked to one OpenAlex work.
 *
 * @param {string} openalexId The bare `W…` id.
 * @param {'cites'|'cited_by'|'related_to'} relation The OpenAlex filter.
 * @param {number} limit How many to ask for.
 * @param {{mailto?: string, openalexKey?: string}} [keys] Contact and credential.
 * @returns {Promise<{papers: object[], total: number|undefined}>} The papers and the index's own total.
 */
export async function linkedWorks(openalexId, relation, limit, keys = {}) {
  const params = new URLSearchParams({ filter: `${relation}:${openalexId}`, 'per-page': String(limit) })
  if (relation !== 'related_to') params.set('sort', 'cited_by_count:desc')
  if (keys.mailto) params.set('mailto', keys.mailto)
  const headers = keys.openalexKey ? { authorization: `Bearer ${keys.openalexKey}` } : {}
  const response = await requestText(`https://api.openalex.org/works?${params}`, { headers })
  const body = jsonOf(response, 'OpenAlex')
  return {
    papers: (body.results ?? []).map(paperFromOpenAlex).filter((paper) => paper.title !== ''),
    total: Number.isFinite(body.meta?.count) ? body.meta.count : undefined,
  }
}
