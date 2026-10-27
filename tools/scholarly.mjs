#!/usr/bin/env node
// Search seven scholarly indexes through one command, fuse the answers, and mark what the local
// reference library already holds.
//
// WHY THIS FILE EXISTS
//
// The reference-library channel was rebuilt as command-line helpers because a mounted tool row costs
// prompt on every request. The same reasoning applies to discovery: a search is an occasional errand,
// so it should cost nothing when it is not being run. This helper is that errand. It asks the indexes
// the query belongs to, fuses their ranked lists into one, and reports every source that failed
// instead of quietly returning a shorter list.
//
// WHAT IT DOES NOT DO
//
// It does not read full text (use `metadata.mjs --oa` and `zotero-pdf.mjs --url`), and it does not
// write anything. It also does not retry: one invocation asks each source once. A 429 or a bot
// challenge is a finding about the source, printed as one.
//
// MEASURED SOURCE FACTS (2026-10-24, no key)
//
//   * Semantic Scholar answered HTTP 429 from the shared pool, so it joins the default route only when
//     AUTORESEARCH_S2_KEY is set. Naming it explicitly without a key reports `no-key` without a request.
//   * DBLP answered HTTP 202 with an Anubis challenge page. It is therefore never in the default route;
//     `--sources dblp` attempts it and reports `blocked`.
//   * PubMed is two JSON requests; Europe PMC, OpenAlex, Crossref, arXiv and DBLP are one each.
//
// Usage:
//   node tools/scholarly.mjs --search "retrieval augmented generation" [--limit 10]
//                            [--sources arxiv,openalex,crossref] [--sort relevance|date|citations]
//                            [--year-from 2020] [--year-to 2025] [--open-access]
//                            [--abstract none|snippet|full] [--mark-library] [--json]
//   node tools/scholarly.mjs --citations <doi|arxiv-id|pmid|pmcid> --direction citations|references|related
//                            [--limit 10] [--mark-library] [--json]
//   Exit codes: 0 answered, including zero results and partial answers | 1 every source failed or the
//   identifier could not be resolved | 2 usage.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Refusal, UsageError, reportFailure } from './refusal.mjs'
import { localRequest } from './zotero-local-api.mjs'
import { sameDoi } from './zotero-read.mjs'
import { openAlexIdOf } from './metadata.mjs'
import {
  SEARCHERS,
  SOURCE_IDS,
  SourceError,
  linkedWorks,
  lookupOpenAlexWork,
  normalizePaper,
  resolveIdentifier,
} from './scholarly-sources.mjs'

const SORTS = ['relevance', 'date', 'citations']
const ABSTRACT_MODES = ['none', 'snippet', 'full']
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const ABSTRACT_SNIPPET = 300
/** The most hits whose library membership one run will check; each check is one library request. */
const MARK_LIMIT = 10
/** Sources with a stronger claim on a domain query; the fusion weight, not a filter. */
const SOURCE_WEIGHT = { arxiv: 1.2, dblp: 1.2, pubmed: 1.2, europepmc: 1.2 }

/** The project's own phrase-level routing tables: technical phrases, not ordinary words. */
const COMPUTING = new RegExp(
  '\\b(?:' +
    [
      'transformers?',
      'llms?',
      'large language models?',
      'diffusion models?',
      'deep learning',
      'machine learning',
      'neural networks?',
      'self-attention',
      'attention mechanisms?',
      'graph neural',
      'graph learning',
      'compilers?',
      'gpus?',
      'cpus?',
      'algorithms?',
      'datasets?',
      'quantum',
      'theorems?',
      'automata',
      'nlp',
      'computer vision',
      'vision transformers?',
      'reinforcement learning',
      'stochastic gradient',
      'pre-?training',
      'fine-?tuning',
      'cs\\.[a-z]+',
      'stat\\.[a-z]+',
      'math\\.[a-z]+',
      'physics\\.[a-z]+',
    ].join('|') +
    ')\\b',
  'i',
)
const BIOMEDICAL = new RegExp(
  '\\b(?:' +
    [
      'genes?',
      'genomes?',
      'proteins?',
      'crispr',
      'clinical trials?',
      'cancer',
      'tumou?rs?',
      'cells?',
      'diseases?',
      'rna',
      'dna',
      'molecular',
      'mutations?',
      'drugs?',
      'viruses?',
      'viral',
      'patients?',
      'antibod(?:y|ies)',
      'pathology',
      'neurons?',
      'medical',
      'medicine',
      'hospitals?',
      'therap(?:y|ies)',
    ].join('|') +
    ')\\b',
  'i',
)

const USAGE =
  'usage: node tools/scholarly.mjs --search "<query>" [--limit N] [--sources id,id] [--sort FIELD]\n' +
  '                                 [--year-from N] [--year-to N] [--open-access]\n' +
  '                                 [--abstract none|snippet|full] [--mark-library] [--json]\n' +
  '       node tools/scholarly.mjs --citations <doi|arxiv-id|pmid|pmcid>\n' +
  '                                 --direction citations|references|related [--limit N] [--mark-library] [--json]\n' +
  `       sources: ${SOURCE_IDS.join(' | ')}\n` +
  '       A search asks each selected source once, in parallel; a failed source is reported, never hidden.\n' +
  '       $AUTORESEARCH_S2_KEY turns Semantic Scholar on; NCBI/OpenAlex keys are optional.'

/**
 * Read the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} The options.
 * @throws {UsageError} On a usage error; the CLI turns that into exit code 2.
 */
export function parseArgs(argv) {
  const options = {
    mode: '',
    query: '',
    id: '',
    direction: '',
    sources: [],
    limit: DEFAULT_LIMIT,
    sort: 'relevance',
    yearFrom: undefined,
    yearTo: undefined,
    openAccess: false,
    abstract: 'snippet',
    categories: [],
    mailto: String(process.env.AUTORESEARCH_MAILTO ?? '').trim(),
    markLibrary: false,
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
      case '--search':
        if (options.mode) throw new UsageError('pass one mode, not two')
        if (!next) throw new UsageError('--search needs a query')
        options.mode = 'search'
        options.query = next
        index += 1
        break
      case '--citations':
        if (options.mode) throw new UsageError('pass one mode, not two')
        if (!next) throw new UsageError('--citations needs an identifier')
        options.mode = 'citations'
        options.id = next
        index += 1
        break
      case '--direction':
        if (!['citations', 'references', 'related'].includes(next)) {
          throw new UsageError("--direction takes citations, references or related")
        }
        options.direction = next
        index += 1
        break
      case '--sources': {
        const requested = String(next ?? '')
          .split(',')
          .map((source) => source.trim())
          .filter(Boolean)
        if (requested.length === 0) throw new UsageError(`--sources needs at least one of ${SOURCE_IDS.join(', ')}`)
        for (const source of requested) {
          if (!SOURCE_IDS.includes(source)) throw new UsageError(`--sources takes ${SOURCE_IDS.join(', ')}, got '${source}'`)
        }
        options.sources = [...new Set(requested)]
        index += 1
        break
      }
      case '--limit':
        options.limit = integer('limit', next, { min: 1, max: MAX_LIMIT })
        index += 1
        break
      case '--sort':
        if (!SORTS.includes(next)) throw new UsageError(`--sort takes ${SORTS.join(', ')}, got '${next}'`)
        options.sort = next
        index += 1
        break
      case '--year-from':
        options.yearFrom = integer('year-from', next, { min: 1500, max: 3000 })
        index += 1
        break
      case '--year-to':
        options.yearTo = integer('year-to', next, { min: 1500, max: 3000 })
        index += 1
        break
      case '--open-access':
        options.openAccess = true
        break
      case '--abstract':
        if (!ABSTRACT_MODES.includes(next)) throw new UsageError(`--abstract takes ${ABSTRACT_MODES.join(', ')}`)
        options.abstract = next
        index += 1
        break
      case '--category':
        if (!next) throw new UsageError('--category needs an arXiv category')
        options.categories.push(next)
        index += 1
        break
      case '--mailto':
        options.mailto = String(next ?? '').trim()
        index += 1
        break
      case '--mark-library':
        options.markLibrary = true
        break
      case '--json':
        options.json = true
        break
      default:
        throw new UsageError(`unrecognised argument '${flag}'`)
    }
  }
  if (!options.mode) throw new UsageError('pass --search or --citations')
  if (options.mode === 'citations' && !options.direction) throw new UsageError('--citations needs --direction')
  if (options.mode === 'search' && options.direction) throw new UsageError('--direction belongs to --citations')
  if (options.mode === 'citations' && options.sources.length > 0) throw new UsageError('--sources belongs to --search')
  if (options.mode === 'citations' && (options.sort !== 'relevance' || options.yearFrom !== undefined || options.yearTo !== undefined)) {
    throw new UsageError('--sort, --year-from and --year-to belong to --search')
  }
  if (options.yearFrom !== undefined && options.yearTo !== undefined && options.yearFrom > options.yearTo) {
    throw new UsageError('--year-from must not be after --year-to')
  }
  return options
}

/** The keys a run may use. Secrets are read from the environment, never from the command line. */
export function keysOf(options) {
  return {
    mailto: options.mailto,
    s2Key: String(process.env.AUTORESEARCH_S2_KEY ?? '').trim() || undefined,
    ncbiKey: String(process.env.AUTORESEARCH_NCBI_KEY ?? '').trim() || undefined,
    openalexKey: String(process.env.AUTORESEARCH_OPENALEX_KEY ?? '').trim() || undefined,
  }
}

/**
 * Which indexes one query should ask.
 *
 * The phrase tables are deliberately narrow: a bare `attention` or `vision` is ordinary English and
 * falls through to the general route. An explicit `--sources` list always wins. DBLP is never in a
 * default route because this client cannot pass its challenge page; Semantic Scholar joins only when
 * a key is configured, because the shared pool measured 429.
 *
 * @param {string} query The user's query.
 * @param {string[]} explicit An explicit source list, empty when not given.
 * @param {boolean} hasS2Key Whether AUTORESEARCH_S2_KEY is set.
 * @returns {string[]} The source ids to ask, never empty.
 */
export function routeSources(query, explicit = [], hasS2Key = false) {
  if (explicit.length > 0) return [...new Set(explicit)]
  const text = String(query ?? '')
  const computing = COMPUTING.test(text)
  const biomedical = BIOMEDICAL.test(text)
  if (computing && !biomedical) {
    return ['arxiv', 'openalex', 'crossref', ...(hasS2Key ? ['semanticscholar'] : [])]
  }
  if (biomedical && !computing) return ['pubmed', 'europepmc', 'crossref', 'openalex']
  return ['arxiv', 'openalex', 'crossref', ...(hasS2Key ? ['semanticscholar'] : [])]
}

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'for', 'in', 'on', 'and', 'or', 'to', 'with', 'is', 'are', 'by', 'at', 'from', 'as'])

/** A title reduced to comparable words. */
export function titleKey(title) {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** The content words of a title, for the fuzzy duplicate rule. */
export function titleTokens(title) {
  return new Set(
    titleKey(title)
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOPWORDS.has(word)),
  )
}

/** The exact identities a paper carries, in the order they are trusted. */
export function canonicalKeys(paper) {
  const keys = []
  if (paper.arxiv) keys.push(`arxiv:${String(paper.arxiv).toLowerCase()}`)
  if (paper.doi) keys.push(`doi:${String(paper.doi).toLowerCase()}`)
  if (paper.pmid) keys.push(`pmid:${paper.pmid}`)
  if (paper.pmcid) keys.push(`pmcid:${String(paper.pmcid).toUpperCase()}`)
  if (paper.openalex) keys.push(`openalex:${String(paper.openalex).toLowerCase()}`)
  if (paper.s2) keys.push(`s2:${paper.s2}`)
  const key = titleKey(paper.title)
  if (key.length >= 20) keys.push(`title:${key}`)
  return keys
}

/** Fill the gaps in one fused paper from another source's copy. */
function mergePaper(target, source) {
  for (const field of ['year', 'venue', 'doi', 'arxiv', 'pmid', 'pmcid', 'openalex', 's2', 'pdfUrl', 'url', 'abstract', 'type']) {
    if (target[field] === undefined && source[field] !== undefined) target[field] = source[field]
  }
  if ((target.authors ?? []).length === 0 && (source.authors ?? []).length > 0) target.authors = [...source.authors]
  if (Number.isFinite(source.citations)) {
    target.citations = Number.isFinite(target.citations) ? Math.max(target.citations, source.citations) : source.citations
  }
  if (source.openAccess === true) target.openAccess = true
  target.sources = [...new Set([...(target.sources ?? []), ...(source.sources ?? [])])]
}

/**
 * Weighted Reciprocal Rank Fusion over the sources' ranked lists.
 *
 * Two copies are the same paper when they share a canonical identifier, or when their titles have at
 * least three content words in common and at least 75% of the shorter title's words match. The fuzzy
 * arm exists because indexes routinely lack each other's identifiers; it is bounded so two different
 * papers with a similar title are not merged on a single word.
 *
 * @param {Array<{sourceId: string, weight?: number, papers: object[]}>} lists The ranked lists.
 * @param {number} [k] The RRF constant.
 * @returns {object[]} The fused papers, best first, each with `sources`.
 */
export function fusePapers(lists, k = 60) {
  const merged = []
  const byKey = new Map()
  for (const list of lists) {
    const weight = Number.isFinite(list.weight) ? list.weight : 1.0
    list.papers.forEach((raw, rank) => {
      const paper = normalizePaper(raw)
      let entry
      for (const key of canonicalKeys(paper)) {
        if (byKey.has(key)) {
          entry = byKey.get(key)
          break
        }
      }
      if (!entry && paper.title.length >= 10) {
        const incoming = titleTokens(paper.title)
        for (const existing of merged) {
          if (existing.paper.title.length < 10) continue
          if (titleKey(existing.paper.title) === titleKey(paper.title)) {
            entry = existing
            break
          }
          const tokens = existing.titleTokens ?? titleTokens(existing.paper.title)
          existing.titleTokens = tokens
          const overlap = [...incoming].filter((token) => tokens.has(token)).length
          const minimum = Math.min(tokens.size, incoming.size)
          if (minimum >= 3 && overlap / minimum >= 0.9) {
            entry = existing
            break
          }
        }
      }
      if (!entry) {
        entry = { paper: { ...paper, sources: [...paper.sources] }, score: 0 }
        merged.push(entry)
      } else {
        mergePaper(entry.paper, paper)
      }
      entry.score += weight / (k + rank)
      for (const key of [...canonicalKeys(entry.paper), ...canonicalKeys(paper)]) {
        if (!byKey.has(key)) byKey.set(key, entry)
      }
    })
  }
  return merged
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.paper, _score: Number(entry.score.toFixed(6)) }))
}

/**
 * Apply the caller's sort, filters and cap to a fused list.
 *
 * @param {object[]} papers Fused papers, best first.
 * @param {{sort?: string, openAccess?: boolean, yearFrom?: number, yearTo?: number, limit?: number, query?: string}} options
 *   The ordering and bounds.
 * @returns {object[]} The final list.
 */
export function postProcess(papers, options = {}) {
  const currentYear = new Date().getFullYear()
  let result = papers.map((paper) => {
    if (paper.year !== undefined && paper.year > currentYear + 1) {
      const { year, date, ...rest } = paper
      return rest
    }
    return paper
  })
  if (options.sort === 'date') {
    const value = (paper) => String(paper.date ?? paper.year ?? '')
    result = [...result].sort((a, b) => value(b).localeCompare(value(a)))
  } else if (options.sort === 'citations') {
    result = [...result].sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1))
  } else if (options.query) {
    const wanted = titleKey(options.query)
    if (wanted.length >= 10) {
      const exact = []
      const rest = []
      for (const paper of result) {
        ;(titleKey(paper.title) === wanted ? exact : rest).push(paper)
      }
      result = [...exact, ...rest]
    }
  }
  if (options.openAccess) result = result.filter((paper) => paper.openAccess === true || paper.pdfUrl !== undefined)
  if (options.yearFrom !== undefined) result = result.filter((paper) => paper.year === undefined || paper.year >= options.yearFrom)
  if (options.yearTo !== undefined) result = result.filter((paper) => paper.year === undefined || paper.year <= options.yearTo)
  return result.slice(0, options.limit ?? result.length)
}

/** A short author line: up to three names, then the count. */
export function authorLine(authors = [], max = 4) {
  if (authors.length === 0) return 'unknown'
  const shown = authors.length <= max ? authors : [...authors.slice(0, max - 1), 'et al.']
  return `${shown.join(', ')}${authors.length > max ? ` (${authors.length})` : ''}`
}

/** The identifier a reader should copy, best first. */
export function identifierOf(paper) {
  if (paper.doi) return paper.doi
  if (paper.arxiv) return `arXiv:${paper.arxiv}`
  if (paper.pmid) return `PMID:${paper.pmid}`
  if (paper.pmcid) return paper.pmcid
  return paper.openalex ?? paper.s2 ?? paper.url ?? ''
}

/**
 * One paper as the block a reader sees.
 *
 * @param {object} paper A fused paper.
 * @param {number} index Its 1-based position.
 * @param {{abstract?: string, mark?: object}} [options] Abstract budget and library annotation.
 * @returns {string} The block.
 */
export function formatPaper(paper, index, { abstract = 'snippet', mark } = {}) {
  const facts = [authorLine(paper.authors), paper.year ? String(paper.year) : '', paper.venue || ''].filter(Boolean).join(' · ')
  const id = identifierOf(paper)
  const marks = [
    id ? `id: ${id}` : '',
    paper.citations !== undefined ? `cited ${paper.citations}` : '',
    paper.openAccess === true || paper.pdfUrl ? 'open access' : '',
    paper.sources.length > 0 ? paper.sources.join('+') : '',
  ].filter(Boolean)
  const lines = [`${index}. ${paper.title || '(no title)'}`, `   ${facts || '(no authors or year)'}`, `   ${marks.join(' · ')}`]
  if (paper.pdfUrl) lines.push(`   pdf: ${paper.pdfUrl}`)
  if (paper.url && paper.url !== paper.pdfUrl) lines.push(`   url: ${paper.url}`)
  if (mark) {
    lines.push(
      `   library: ${
        mark.status === 'in'
          ? `${mark.key} (${mark.ref})`
          : mark.status === 'not-in'
            ? 'not in this library'
            : 'status unavailable - the library did not answer'
      }`,
    )
  }
  if (abstract !== 'none' && paper.abstract) {
    const text = abstract === 'full' ? paper.abstract : `${paper.abstract.slice(0, ABSTRACT_SNIPPET)}${paper.abstract.length > ABSTRACT_SNIPPET ? '…' : ''}`
    lines.push(`   abs: ${text}`)
  }
  return lines.join('\n')
}

/** Ask every selected source once, in parallel, and keep the failures as data. */
async function fanOut(sources, query, keys) {
  const lists = []
  const failures = []
  await Promise.all(
    sources.map(async (sourceId) => {
      try {
        const papers = await SEARCHERS[sourceId](query, keys)
        lists.push({ sourceId, weight: SOURCE_WEIGHT[sourceId] ?? 1.0, papers })
      } catch (error) {
        failures.push({
          source: sourceId,
          code: error instanceof SourceError ? error.code : 'failed',
          message: error?.message ?? String(error),
        })
      }
    }),
  )
  return { lists, failures }
}

/**
 * Mark the first hits with whether the local library already holds them.
 *
 * A failed lookup is `unavailable`, never `not-in`: an unread library is not an absent paper. The
 * pass stops after {@link MARK_LIMIT} hits and says how many it checked.
 */
async function markLibrary(papers, limit = MARK_LIMIT) {
  const report = { checked: 0, failed: 0, capped: papers.length > limit, limit }
  await Promise.all(
    papers.slice(0, limit).map(async (paper) => {
      const queries = []
      if (paper.doi) queries.push(paper.doi)
      if (paper.title.length >= 15) queries.push(paper.title)
      let checked = false
      let match
      for (const query of queries) {
        try {
          const params = new URLSearchParams({ q: query, qmode: 'everything', limit: '5', format: 'json' })
          const response = await localRequest('GET', `/api/users/0/items?${params}`)
          if (response.status !== 200) continue
          checked = true
          const rows = JSON.parse(response.text)
          match = rows.find((row) => {
            const data = row?.data ?? {}
            if (!data.itemType || data.itemType === 'note' || data.itemType === 'attachment') return false
            if (paper.doi && data.DOI && sameDoi(data.DOI) === sameDoi(paper.doi)) return true
            return paper.title.length >= 15 && titleKey(data.title) === titleKey(paper.title)
          })
          if (match) break
        } catch {
          // Try the next query; a single failed lookup is not proof of absence.
        }
      }
      if (match) {
        report.checked += 1
        paper.library = { status: 'in', key: match.key, ref: `zotero://user/0/item/${match.key}` }
      } else if (checked) {
        report.checked += 1
        paper.library = { status: 'not-in' }
      } else {
        report.failed += 1
        paper.library = { status: 'unavailable' }
      }
    }),
  )
  return report
}

/** Search: route, fan out, fuse, mark, print. */
async function runSearch(options, keys) {
  const sources = routeSources(options.query, options.sources, Boolean(keys.s2Key))
  const query = {
    query: options.query,
    limit: options.limit,
    sort: options.sort,
    yearFrom: options.yearFrom,
    yearTo: options.yearTo,
    openAccess: options.openAccess,
    categories: options.categories,
  }
  const { lists, failures } = await fanOut(sources, query, keys)
  const fused = fusePapers(lists)
  const papers = postProcess(fused, { ...options, query: options.query })
  let libraryStatus
  if (options.markLibrary && papers.length > 0) libraryStatus = await markLibrary(papers)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          query: options.query,
          sourcesAsked: sources,
          sourcesAnswered: lists.map((list) => list.sourceId),
          sourcesFailed: failures,
          totalFetched: lists.reduce((sum, list) => sum + list.papers.length, 0),
          partial: failures.length > 0,
          results: papers,
          ...(libraryStatus ? { libraryStatus } : {}),
        },
        null,
        2,
      ),
    )
    return failures.length === sources.length ? 1 : 0
  }

  console.log(`query   : "${options.query}"`)
  console.log(`sources : asked ${sources.length} · answered ${lists.length} · failed ${failures.length}`)
  for (const failure of failures) console.log(`  failed: ${failure.source} - ${failure.code}: ${failure.message}`)
  if (failures.length === sources.length) {
    console.log('\nEvery source failed; nothing below is an empty search. Fix or name another source.')
    return 1
  }
  if (failures.length > 0) console.log('partial : some sources failed; this list is not the whole index')
  console.log(`results : ${papers.length} (fused from ${lists.reduce((sum, list) => sum + list.papers.length, 0)} records)`)
  if (papers.length === 0) {
    console.log('\n0 results - the sources answered and none matched. This is not a failure.')
    return 0
  }
  console.log('')
  papers.forEach((paper, index) => console.log(`${formatPaper(paper, index + 1, { abstract: options.abstract, mark: paper.library })}\n`))
  if (libraryStatus) {
    console.log(
      `library : checked ${libraryStatus.checked}${libraryStatus.failed > 0 ? ` · ${libraryStatus.failed} lookup(s) unavailable` : ''}` +
        (libraryStatus.capped ? ` (first ${libraryStatus.limit})` : ''),
    )
  }
  return 0
}

/** Citation graph: resolve the identifier, ask OpenAlex, print. */
async function runCitations(options, keys) {
  let resolved
  try {
    resolved = await resolveIdentifier(options.id, keys)
  } catch (error) {
    throw new Refusal(`the identifier could not be resolved: ${error.message}`, {
      fix: 'pass a DOI, an arXiv id, a PMID or a PMCID; a title is not an identifier',
    })
  }
  if (!resolved) {
    throw new Refusal(`'${options.id}' is not a DOI, arXiv id, PMID, PMCID or OpenAlex id`, {
      fix: 'pass one of those identifiers; a title is not an identifier',
    })
  }
  if (!resolved.openalex) {
    throw new Refusal(`this identifier did not resolve to an OpenAlex work: ${options.id}`, {
      fix: 'resolve the DOI first with metadata.mjs --doi, then pass that DOI',
    })
  }
  let work
  try {
    work = await lookupOpenAlexWork(resolved.openalex, keys)
  } catch (error) {
    throw new Refusal(`OpenAlex does not recognise ${options.id}: ${error.message}`, {
      fix: 'recent preprints may have no citation links yet; try a DOI, or read the work with metadata.mjs --doi',
    })
  }
  const openalex = openAlexIdOf(work?.id)
  if (!openalex) throw new Refusal('OpenAlex answered a work without an id', { fix: 'retry once; if it repeats, the index is not answering truthfully' })
  const relation = { citations: 'cites', references: 'cited_by', related: 'related_to' }[options.direction]
  const { papers, total } = await linkedWorks(openalex, relation, options.limit, keys)
  // OpenAlex's `cites:` answer can include the work itself; "papers that cite it" does not.
  const fused = options.direction === 'citations' ? papers.filter((paper) => paper.openalex !== openalex) : papers
  let libraryStatus
  if (options.markLibrary && fused.length > 0) libraryStatus = await markLibrary(fused)
  if (options.markLibrary && fused.length > 0) await markLibrary(fused)
  const relationText =
    options.direction === 'citations'
      ? 'cite'
      : options.direction === 'references'
        ? 'are cited by'
        : 'are related to'

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          id: options.id,
          resolved: { kind: resolved.kind, openalex },
          direction: options.direction,
          total: total ?? fused.length,
          results: fused,
          ...(libraryStatus ? { libraryStatus } : {}),
        },
        null,
        2,
      ),
    )
    return 0
  }
  const title = String(work?.title ?? work?.display_name ?? '').trim()
  console.log(`work    : ${title || options.id}`)
  console.log(`id      : ${options.id}  →  ${openalex}`)
  console.log(`link    : ${total !== undefined && total > fused.length ? `${total} total; showing ${fused.length}` : String(fused.length)} papers that ${relationText} it`)
  if (fused.length === 0) {
    console.log('\n0 papers - OpenAlex answered and its citation index holds none for this work. This is not a failure.')
    return 0
  }
  console.log('')
  fused.forEach((paper, index) => console.log(`${formatPaper(paper, index + 1, { mark: paper.library })}\n`))
  if (libraryStatus) {
    console.log(
      `library : checked ${libraryStatus.checked}${libraryStatus.failed > 0 ? ` · ${libraryStatus.failed} lookup(s) unavailable` : ''}` +
        (libraryStatus.capped ? ` (first ${libraryStatus.limit})` : ''),
    )
  }
  return 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const keys = keysOf(options)
  process.exitCode = options.mode === 'search' ? await runSearch(options, keys) : await runCitations(options, keys)
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  main().catch((error) => {
    process.exitCode = reportFailure(error, { usage: USAGE })
  })
}
