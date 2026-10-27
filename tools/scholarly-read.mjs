#!/usr/bin/env node
// Read the open-access full text of one paper, with sections and BM25 passages.
//
// WHY THIS FILE EXISTS
//
// Discovery hands back a lead; evidence needs text. The cheap lawful routes are the author's own HTML
// (arXiv LaTeXML / ar5iv), the publisher's JATS XML through Europe PMC, and an open-access PDF found by
// OpenAlex. Each answers a different shape, and the reader wants one: a text with headings it can
// outline, a section it can name, and passages it can rank against a question.
//
// WHAT IT DOES NOT DO
//
// It does not search, write, or read a paywalled copy. It resolves one identifier, tries the routes in
// order, and names every route that failed rather than saying "likely a paywall". There is no cache and
// no retry: one invocation, one bounded set of requests.
//
// Usage:
//   node tools/scholarly-read.mjs --id <doi|arxiv-id|pmid|pmcid|pdf-url> [--outline]
//   node tools/scholarly-read.mjs --id <id> --section "3" [--query "terms"]
//   node tools/scholarly-read.mjs --id <id> --query "terms" [--passages N]
//   node tools/scholarly-read.mjs --id <id> [--start N] [--max-chars N]
//   Exit codes: 0 read | 1 no open-access text could be read | 2 usage.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeXml } from './arxiv.mjs'
import { Refusal, UsageError, reportFailure } from './refusal.mjs'
import { chunkText, rankPassages, sliceText } from './zotero-read.mjs'
import { extractPdfText } from './zotero-pdf.mjs'
import {
  SourceError,
  jsonOf,
  lookupOpenAlexWork,
  requestText,
  resolveIdentifier,
} from './scholarly-sources.mjs'

const DEFAULT_CHARS = 12_000
const MAX_CHARS = 50_000
const DEFAULT_PASSAGES = 5
const MAX_PASSAGES = 12
const MAX_HTML_CHARS = 5_000_000
const MAX_PDF_BYTES = 80 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 45_000

const USAGE =
  'usage: node tools/scholarly-read.mjs --id <doi|arxiv-id|pmid|pmcid|pdf-url> [--outline]\n' +
  '       node tools/scholarly-read.mjs --id <id> --section "3" [--query "terms"]\n' +
  '       node tools/scholarly-read.mjs --id <id> --query "terms" [--passages N]\n' +
  '       node tools/scholarly-read.mjs --id <id> [--start N] [--max-chars N]\n' +
  '       Routes: arXiv HTML → ar5iv → arXiv PDF; PMC JATS; an OA PDF via OpenAlex; or a URL passed as --id.\n' +
  '       A route that fails is named in the refusal; nothing is retried. [--mailto ADDR] [--json]'

/**
 * Read the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} The options.
 * @throws {UsageError} On a usage error.
 */
export function parseArgs(argv) {
  const options = {
    id: '',
    outline: false,
    section: '',
    query: '',
    passages: DEFAULT_PASSAGES,
    start: 0,
    maxChars: DEFAULT_CHARS,
    mailto: String(process.env.AUTORESEARCH_MAILTO ?? '').trim(),
    json: false,
  }
  const integer = (name, raw, { min, max }) => {
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
      case '--id':
        if (!next) throw new UsageError('--id needs an identifier or a PDF URL')
        options.id = next
        index += 1
        break
      case '--outline':
        options.outline = true
        break
      case '--section':
        if (!next) throw new UsageError('--section needs a number or a title')
        options.section = next
        index += 1
        break
      case '--query':
        if (!next) throw new UsageError('--query needs terms')
        options.query = next
        index += 1
        break
      case '--passages':
        options.passages = integer('passages', next, { min: 1, max: MAX_PASSAGES })
        index += 1
        break
      case '--start':
        options.start = integer('start', next, { min: 0, max: 10_000_000 })
        index += 1
        break
      case '--max-chars':
        options.maxChars = integer('max-chars', next, { min: 500, max: MAX_CHARS })
        index += 1
        break
      case '--mailto':
        options.mailto = String(next ?? '').trim()
        index += 1
        break
      case '--json':
        options.json = true
        break
      default:
        throw new UsageError(`unrecognised argument '${flag}'`)
    }
  }
  if (!options.id) throw new UsageError('--id is required')
  if (options.outline && (options.section || options.query)) {
    throw new UsageError('--outline lists the sections; it does not combine with --section or --query')
  }
  return options
}

/** Strip tags and decode the entities an HTML or XML body carries. */
export function textOf(markup) {
  return decodeXml(String(markup ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * One HTML article as text with `#` headings.
 *
 * arXiv's LaTeXML and ar5iv both express a section as an `<hN>`; the rest is paragraphs. Script and
 * style bodies are dropped, because their text is not the paper's. A short denylist drops the reader
 * chrome (the "Report GitHub Issue" link is an `<h2>` on arXiv's own HTML).
 */
const UI_HEADING = /^(?:report github issue|back to arxiv|skip to main content|arxiv\.org|about|help)$/i

export function parseHtmlToText(html) {
  const text = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
      const title = textOf(body)
      if (title === '' || UI_HEADING.test(title)) return '\n\n'
      return `\n\n${'#'.repeat(Number(level))} ${title}\n\n`
    })
    .replace(/<\/(p|div|section|article|li|tr|figure|figcaption)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  return decodeXml(text.replace(/<[^>]*>/g, ' '))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * One JATS XML article as text with `#` headings.
 *
 * The `<body>` is read, not the reference list. Section depth is tracked from `<sec>` nesting, so a
 * subsection's `<title>` becomes `##` even when the XML carries no explicit level attribute.
 */
export function parseJatsToText(xml) {
  const source = String(xml ?? '')
  const bodyStart = source.search(/<body[\s>]/i)
  const bodyEnd = source.search(/<\/body>/i)
  const body = bodyStart === -1 ? source : source.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd)
  let out = ''
  let depth = 0
  let last = 0
  const tag = /<(\/?)([a-zA-Z][\w:-]*)([^>]*)>/g
  let match
  while ((match = tag.exec(body))) {
    out += decodeXml(body.slice(last, match.index))
    last = tag.lastIndex
    const closing = match[1] === '/'
    const name = match[2].toLowerCase()
    if (name === 'sec') {
      depth = Math.max(0, depth + (closing ? -1 : 1))
    } else if (name === 'title' && !closing) {
      const end = body.indexOf('</title>', tag.lastIndex)
      if (end === -1) continue
      const title = textOf(body.slice(tag.lastIndex, end))
      if (title !== '') out += `\n\n${'#'.repeat(Math.min(6, Math.max(1, depth)))} ${title}\n\n`
      tag.lastIndex = end + '</title>'.length
      last = tag.lastIndex
    } else if (['p', 'br', 'list-item', 'caption', 'table-wrap'].includes(name)) {
      out += '\n'
    }
  }
  out += decodeXml(body.slice(last))
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The headings of one text, with the span each section owns.
 *
 * A section ends where the next heading of the same or a higher level begins, so a top-level section
 * carries its subsections. The char range is what a later `--section` reads.
 *
 * @param {string} text The structured text.
 * @returns {Array<{level: number, title: string, start: number, end: number}>} The sections.
 */
export function extractSections(text) {
  const lines = String(text ?? '').split('\n')
  const sections = []
  let offset = 0
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match) sections.push({ level: match[1].length, title: match[2].trim(), start: offset })
    offset += line.length + 1
  }
  for (let index = 0; index < sections.length; index += 1) {
    const next = sections.slice(index + 1).find((section) => section.level <= sections[index].level)
    sections[index].end = next ? next.start : String(text ?? '').length
  }
  return sections
}

/**
 * Find one section by its number or title.
 *
 * `3` matches a heading that starts with `3`, `3.1` matches `3.1 …`, and a word matches a heading that
 * contains it case-insensitively. An exact title wins over a containment match.
 */
export function findSection(sections, wanted) {
  const query = String(wanted ?? '').trim().toLowerCase()
  if (query === '') return undefined
  const exact = sections.find((section) => section.title.toLowerCase() === query)
  if (exact) return exact
  const numbered = sections.find((section) => new RegExp(`^${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|\\.|$)`).test(section.title))
  if (numbered) return numbered
  return sections.find((section) => section.title.toLowerCase().includes(query))
}

/** Fetch an HTML/XML body, bounded. */
async function fetchText(url, accept) {
  const response = await requestText(url, { accept, timeoutMs: REQUEST_TIMEOUT_MS })
  if (response.status !== 200) throw new SourceError(`HTTP ${response.status}`, { code: 'http' })
  if (response.body.length > MAX_HTML_CHARS) throw new SourceError(`body is ${response.body.length} characters, above the bound`, { code: 'too-large' })
  return response.body
}

/** Fetch binary bytes, bounded, and require a PDF magic header. */
async function fetchPdf(url) {
  let response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'user-agent': 'dsh-autoresearch/1.0 (scholarly reader)', accept: 'application/pdf,*/*' },
    })
  } catch (error) {
    throw new SourceError(`request failed: ${error?.message ?? error}`, { code: 'network' })
  }
  if (!response.ok) throw new SourceError(`HTTP ${response.status}`, { code: 'http' })
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > MAX_PDF_BYTES) throw new SourceError(`file is ${Math.round(bytes.length / 1024 / 1024)} MB, above the bound`, { code: 'too-large' })
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new SourceError('body is not a PDF', { code: 'not-a-pdf' })
  return bytes
}

/** Count what a refused set of routes tried, for the terminal message. */
function routeFailure(what, errors) {
  return new Refusal(`no open-access full text for ${what}`, {
    fix: `routes tried: ${errors.length === 0 ? 'none' : errors.join(' · ')}`,
  })
}

/** arXiv: LaTeXML HTML, ar5iv HTML, then the PDF. */
async function resolveArxiv(id) {
  const errors = []
  for (const [label, url] of [
    ["arXiv's HTML version (LaTeXML)", `https://arxiv.org/html/${id}`],
    ["ar5iv's HTML version", `https://ar5iv.labs.arxiv.org/html/${id}`],
  ]) {
    try {
      const text = parseHtmlToText(await fetchText(url, 'text/html,*/*'))
      if (text.length >= 1500) return { source: label, url, text, structured: true }
      errors.push(`${label}: only ${text.length} characters`)
    } catch (error) {
      errors.push(`${label}: ${error.message}`)
    }
  }
  try {
    const bytes = await fetchPdf(`https://arxiv.org/pdf/${id}`)
    const { text, pageCount } = await extractPdfText(bytes)
    if (text.replace(/\s+/g, '').length >= 500) {
      return { source: 'the arXiv PDF', url: `https://arxiv.org/pdf/${id}`, text, structured: false, pageCount }
    }
    errors.push('arXiv PDF: no extractable text')
  } catch (error) {
    errors.push(`arXiv PDF: ${error.message}`)
  }
  throw routeFailure(`arXiv:${id}`, errors)
}

/** PubMed / DOI: Europe PMC's JATS, then an OA PDF OpenAlex knows about. */
async function europePmcId(parsed, keys) {
  const query = parsed.kind === 'doi' ? `DOI:"${parsed.id}"` : `EXT_ID:${parsed.id} AND SRC:MED`
  const params = new URLSearchParams({ query, format: 'json', resultType: 'lite', pageSize: '1' })
  if (keys.mailto) params.set('email', keys.mailto)
  try {
    const body = jsonOf(await requestText(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`), 'Europe PMC')
    return body.resultList?.result?.[0]?.pmcid
  } catch {
    return undefined
  }
}

/** Europe PMC's JATS XML. */
async function resolvePmc(pmcid) {
  const clean = String(pmcid).toUpperCase().startsWith('PMC') ? String(pmcid).toUpperCase() : `PMC${pmcid}`
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(clean)}/fullTextXML`
  const xml = await fetchText(url, 'application/xml,text/xml,*/*')
  const text = parseJatsToText(xml)
  if (text.replace(/\s+/g, '').length < 500) throw new SourceError('JATS body carried no extractable text', { code: 'empty' })
  return { source: `Europe PMC JATS (${clean})`, url, text, structured: true }
}

/** DOI / PMID: a PMCID when Europe PMC has one, then an OA PDF from OpenAlex. */
async function resolveDoi(parsed, keys) {
  const errors = []
  const pmcid = await europePmcId(parsed, keys)
  if (pmcid) {
    try {
      return await resolvePmc(pmcid)
    } catch (error) {
      errors.push(`Europe PMC JATS: ${error.message}`)
    }
  } else {
    errors.push('Europe PMC: no PMCID for this identifier')
  }
  try {
    const work = await lookupOpenAlexWork(parsed.openalex, keys)
    const candidates = [
      work?.best_oa_location?.pdf_url,
      work?.best_oa_location?.landing_page_url,
      work?.open_access?.oa_url,
      work?.primary_location?.pdf_url,
    ].filter(Boolean)
    if (candidates.length === 0) errors.push('OpenAlex: no open-access PDF or landing page on this record')
    for (const url of [...new Set(candidates)]) {
      try {
        const bytes = await fetchPdf(url)
        const { text, pageCount } = await extractPdfText(bytes)
        if (text.replace(/\s+/g, '').length >= 500) {
          return { source: 'the open-access PDF', url, text, structured: false, pageCount }
        }
        errors.push(`${url}: no extractable text`)
      } catch (error) {
        errors.push(`${url}: ${error.message}`)
      }
    }
  } catch (error) {
    errors.push(`OpenAlex: ${error.message}`)
  }
  throw routeFailure(parsed.kind === 'doi' ? parsed.id : `PMID:${parsed.id}`, errors)
}

/** One URL: a PDF, or an HTML article. */
async function resolveUrl(url) {
  try {
    const bytes = await fetchPdf(url)
    const { text, pageCount } = await extractPdfText(bytes)
    if (text.replace(/\s+/g, '').length < 500) throw new SourceError('PDF carried no extractable text', { code: 'empty' })
    return { source: 'the URL (PDF)', url, text, structured: false, pageCount }
  } catch (error) {
    if (error?.code !== 'not-a-pdf') {
      try {
        const html = await fetchText(url, 'text/html,*/*')
        const text = parseHtmlToText(html)
        if (text.length < 500) throw new SourceError('HTML carried no article text', { code: 'empty' })
        return { source: 'the URL (HTML)', url, text, structured: true }
      } catch (htmlError) {
        throw routeFailure(url, [`PDF: ${error.message}`, `HTML: ${htmlError.message}`])
      }
    }
    throw routeFailure(url, [`PDF: ${error.message}`])
  }
}

/**
 * Resolve one identifier to open-access text.
 *
 * @param {string} raw A DOI, arXiv id, PMID, PMCID, or an http(s) PDF/article URL.
 * @param {{mailto?: string, openalexKey?: string}} keys Contact and credential.
 * @returns {Promise<{source: string, url: string, text: string, structured: boolean, pageCount?: number}>} The text.
 */
export async function resolveFullText(raw, keys = {}) {
  if (/^https?:\/\//i.test(raw)) return resolveUrl(raw)
  const parsed = await resolveIdentifier(raw, keys)
  if (!parsed) {
    throw new Refusal(`'${raw}' is not a DOI, arXiv id, PMID, PMCID or URL`, {
      fix: 'pass one of those identifiers; a title is not an identifier',
    })
  }
  if (parsed.kind === 'arxiv') return resolveArxiv(parsed.id)
  if (parsed.kind === 'pmcid') return resolvePmc(parsed.id)
  return resolveDoi(parsed, keys)
}

/** The metadata block every JSON answer shares; the full text is never dumped beside it. */
function metaOf(result) {
  return {
    source: result.source,
    url: result.url,
    structured: result.structured,
    characters: result.text.length,
    ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
  }
}

/**
 * Read, outline, read a section, or rank passages.
 *
 * @param {object} options Parsed options.
 * @returns {Promise<number>} The exit code.
 */
async function runRead(options) {
  const text = await resolveFullText(options.id, { mailto: options.mailto })
  const sections = extractSections(text.text)

  if (options.outline) {
    if (options.json) {
      console.log(JSON.stringify({ id: options.id, ...metaOf(text), sections }, null, 2))
      return 0
    }
    console.log(`id      : ${options.id}`)
    console.log(`source  : ${text.source}`)
    console.log(`url     : ${text.url}`)
    console.log(`chars   : ${text.text.length.toLocaleString('en-US')} · ${text.structured ? 'structured' : 'unstructured'} · ${sections.length} heading(s)`)
    if (sections.length === 0) {
      console.log('\nNo headings in this copy; read it in chunks or search it with --query.')
      return 0
    }
    console.log('')
    for (const section of sections) {
      console.log(`${'  '.repeat(Math.min(3, section.level - 1))}${section.title}  [${section.start}-${section.end}]`)
    }
    return 0
  }

  let scope = text.text
  let scopeLabel = ''
  let scopeOffset = 0
  if (options.section) {
    const section = findSection(sections, options.section)
    if (!section) {
      const available = sections.slice(0, 20).map((entry) => `"${entry.title}"`).join(', ')
      throw new Refusal(`section '${options.section}' is not in this copy`, {
        fix: sections.length === 0 ? 'this copy has no headings; read it in chunks or use --query' : `available: ${available}`,
      })
    }
    scope = text.text.slice(section.start, section.end)
    scopeLabel = ` [${section.title}]`
    scopeOffset = section.start
  }

  if (options.query) {
    const chunks = chunkText(scope, { size: 1200, overlap: 200 })
    const ranked = rankPassages(chunks, options.query, { limit: options.passages })
    const passages = ranked.map((chunk) => ({
      start: scopeOffset + chunk.from,
      end: scopeOffset + chunk.to,
      score: Number(chunk.score.toFixed(4)),
      text: chunk.text.trim(),
    }))
    if (options.json) {
      console.log(
        JSON.stringify(
          { id: options.id, ...metaOf(text), sections, section: options.section || undefined, passages },
          null,
          2,
        ),
      )
      return 0
    }
    console.log(`id      : ${options.id}${scopeLabel}`)
    console.log(`source  : ${text.source}`)
    console.log(`url     : ${text.url}`)
    console.log(`query   : "${options.query}" · ${passages.length} passage(s) of ${chunks.length} chunk(s)`)
    if (passages.length === 0) {
      console.log('\n0 passages - the text was read and no chunk matched. This is not a failure.')
      return 0
    }
    console.log('')
    passages.forEach((passage, index) => {
      console.log(`--- passage ${index + 1} · score ${passage.score} · chars ${passage.start}-${passage.end} ---`)
      console.log(passage.text)
      console.log('')
    })
    return 0
  }

  const slice = sliceText(scope, { offset: options.start, limit: options.maxChars })
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          id: options.id,
          ...metaOf(text),
          sections,
          section: options.section || undefined,
          start: slice.from,
          end: slice.to,
          nextStart: slice.nextOffset,
          truncated: slice.nextOffset !== null,
          text: slice.text,
        },
        null,
        2,
      ),
    )
    return 0
  }
  console.log(`id      : ${options.id}${scopeLabel}`)
  console.log(`source  : ${text.source}`)
  console.log(`url     : ${text.url}`)
  console.log(`chars   : ${text.text.length.toLocaleString('en-US')} · ${text.structured ? 'structured' : 'unstructured'} · ${sections.length} heading(s)`)
  console.log(
    `slice   : ${slice.from}-${slice.to} of ${slice.total}` +
      (slice.nextOffset === null ? '  (end)' : `  next: --start ${slice.nextOffset}`),
  )
  console.log('')
  console.log(slice.text)
  return 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  process.exitCode = await runRead(options)
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  main().catch((error) => {
    process.exitCode = reportFailure(error, { usage: USAGE })
  })
}
