// Unit self-test for the scholarly discovery helper, runnable without a network.
//
// Usage: node tools/tests/scholarly-selftest.mjs
//
// The fixtures are the shapes the indexes actually answer, trimmed to the fields under test. The
// failure fixtures are the measured ones from 2026-10-24: Semantic Scholar's 429 (no key), and DBLP's
// 202 Anubis challenge page. Both must stay distinguishable from "no results".
import {
  paperFromArxiv,
  paperFromCrossref,
  paperFromDblp,
  paperFromEuropePmc,
  paperFromOpenAlex,
  paperFromPubmed,
  paperFromSemanticScholar,
  jsonOf,
  searchDblp,
  searchSemanticScholar,
} from '../scholarly-sources.mjs'
import {
  canonicalKeys,
  fusePapers,
  formatPaper,
  keysOf,
  parseArgs,
  postProcess,
  routeSources,
  titleKey,
} from '../scholarly.mjs'

delete process.env.AUTORESEARCH_S2_KEY
delete process.env.AUTORESEARCH_NCBI_KEY
delete process.env.AUTORESEARCH_OPENALEX_KEY

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  -> ${detail}` : ''}`)
  if (!condition) failures += 1
}
const throws = (label, run, expected = '') => {
  try {
    run()
    check(false, label, 'nothing was thrown')
  } catch (error) {
    check(true, label, expected ? `${error.code ?? ''} ${error.message}` : '')
  }
}

console.log('scholarly discovery self-test')

// --- the same paper in seven shapes ---------------------------------------------------------------

console.log('\n[1] each index converges to one paper shape')

const OPENALEX = paperFromOpenAlex({
  id: 'https://openalex.org/W123',
  doi: 'https://doi.org/10.1000/a',
  title: 'A paper',
  publication_year: 2020,
  authorships: [{ author: { display_name: 'Ada Lovelace' } }],
  primary_location: { source: { display_name: 'Journal of Examples' } },
  cited_by_count: 5,
  open_access: { oa_status: 'gold', oa_url: 'https://example.org/a.pdf' },
  abstract_inverted_index: { A: [0], paper: [1] },
})
check(OPENALEX.title === 'A paper' && OPENALEX.year === 2020, 'OpenAlex maps its core fields')
check(OPENALEX.doi === '10.1000/a' && OPENALEX.openalex === 'W123', 'the DOI is bare and the OpenAlex id is kept')
check(OPENALEX.citations === 5 && OPENALEX.openAccess === true, 'citations and open-access status survive')
check(OPENALEX.authors.join(',') === 'Ada Lovelace', 'authors are names, not objects')

const CROSSREF = paperFromCrossref({
  DOI: '10.1000/b',
  title: ['B paper'],
  author: [{ given: 'Alan', family: 'Turing' }],
  issued: { 'date-parts': [[1950]] },
  'container-title': ['Mind'],
  'is-referenced-by-count': 7,
})
check(CROSSREF.title === 'B paper' && CROSSREF.year === 1950, 'Crossref maps its array title and issued date')
check(CROSSREF.venue === 'Mind' && CROSSREF.citations === 7, 'venue and count survive')

const S2 = paperFromSemanticScholar({
  paperId: 's2-1',
  title: 'C paper',
  authors: [{ name: 'Grace Hopper' }],
  year: 1952,
  venue: 'Proceedings',
  externalIds: { DOI: '10.1000/c', ArXiv: '1234.5678', PubMed: '123' },
  citationCount: 3,
  openAccessPdf: { url: 'https://example.org/c.pdf' },
  abstract: 'An abstract.',
  url: 'https://example.org/c',
})
check(S2.doi === '10.1000/c' && S2.arxiv === '1234.5678' && S2.pmid === '123', 'Semantic Scholar external ids are split')
check(S2.pdfUrl === 'https://example.org/c.pdf' && S2.openAccess === true, 'its open PDF is carried')

const PUBMED = paperFromPubmed('999', {
  title: 'D paper',
  authors: [{ name: 'A. Author' }],
  pubdate: '2020 Jan',
  fulljournalname: 'Journal of Medicine',
  articleids: [
    { idtype: 'doi', value: '10.1000/d' },
    { idtype: 'pmc', value: 'PMC999' },
  ],
})
check(PUBMED.pmid === '999' && PUBMED.pmcid === 'PMC999', 'PubMed keeps its own ids')
check(PUBMED.doi === '10.1000/d' && PUBMED.year === 2020, 'its DOI and year are extracted')

const EPMC = paperFromEuropePmc({
  title: 'E paper',
  authorString: 'A. Author, B. Author',
  pubYear: '2021',
  journalTitle: 'Journal of Biology',
  doi: '10.1000/e',
  pmid: '456',
  pmcid: 'PMC456',
  citedByCount: 2,
  isOpenAccess: 'Y',
  abstractText: 'Another abstract.',
  fullTextUrlList: { fullTextUrl: [{ documentStyle: 'pdf', url: 'https://example.org/e.pdf' }] },
})
check(EPMC.authors.length === 2 && EPMC.pmcid === 'PMC456', 'Europe PMC splits authors and keeps the PMCID')
check(EPMC.pdfUrl === 'https://example.org/e.pdf' && EPMC.citations === 2, 'its PDF and citation count survive')

const DBLP = paperFromDblp({
  info: {
    title: 'F paper',
    authors: { author: [{ text: 'A. Author' }, { text: 'B. Author' }] },
    year: '2019',
    venue: 'Conference',
    doi: '10.1000/f',
    ee: 'https://example.org/f',
  },
})
check(DBLP.title === 'F paper' && DBLP.authors.length === 2, 'DBLP maps its nested authors')
check(DBLP.year === 2019 && DBLP.doi === '10.1000/f', 'its year and DOI survive')

const ARXIV = paperFromArxiv({
  base: '2305.06983',
  bare: '2305.06983v2',
  title: 'G paper',
  authors: ['A. Author'],
  published: '2023-05-11T00:00:00Z',
  summary: 'A preprint abstract.',
  absUrl: 'https://arxiv.org/abs/2305.06983v2',
  pdfUrl: 'https://arxiv.org/pdf/2305.06983v2',
})
check(ARXIV.arxiv === '2305.06983' && ARXIV.year === 2023, 'arXiv keeps the versionless id and the year')
check(ARXIV.doi === '10.48550/arXiv.2305.06983' && ARXIV.openAccess === true, 'and gets its DataCite DOI')

// --- routing -------------------------------------------------------------------------------------

console.log('\n[2] a query asks the indexes it belongs to')
check(routeSources('graph neural networks', [], false).join(',') === 'arxiv,openalex,crossref', 'a computing phrase asks arXiv, not PubMed')
check(routeSources('cancer therapy', [], false).join(',') === 'pubmed,europepmc,crossref,openalex', 'a biomedical phrase asks PubMed and Europe PMC')
check(routeSources('attention economy', [], false).join(',') === 'arxiv,openalex,crossref', 'a bare ambiguous word falls through to the general route')
check(routeSources('anything', ['dblp']).join(',') === 'dblp', 'an explicit source list wins')
check(!routeSources('anything', [], false).includes('dblp'), 'DBLP is never in a default route')
check(!routeSources('anything', [], false).includes('semanticscholar'), 'Semantic Scholar is absent without a key')
check(routeSources('anything', [], true).includes('semanticscholar'), 'and joins when a key is configured')

// --- fusion --------------------------------------------------------------------------------------

console.log('\n[3] duplicates collapse, distinct papers do not')
const fused = fusePapers([
  { sourceId: 'openalex', weight: 1, papers: [{ title: 'A paper', doi: '10.1000/a', year: 2020, sources: ['openalex'] }] },
  { sourceId: 'crossref', weight: 1, papers: [{ title: 'A paper', doi: '10.1000/a', year: 2020, sources: ['crossref'] }] },
  { sourceId: 'arxiv', weight: 1, papers: [{ title: 'A different paper', doi: '10.1000/b', year: 2021, sources: ['arxiv'] }] },
])
check(fused.length === 2, 'the same DOI from two sources is one paper', `${fused.length}`)
check(fused[0].sources.sort().join(',') === 'crossref,openalex', 'the surviving entry names both sources')
const nearMisses = fusePapers([
  { sourceId: 'a', papers: [{ title: 'Active Retrieval Augmented Generation', doi: '10.1/a', sources: ['a'] }] },
  { sourceId: 'b', papers: [{ title: 'Corrective Retrieval Augmented Generation', doi: '10.1/b', sources: ['b'] }] },
])
check(nearMisses.length === 2, 'two titles that share a phrase are not merged', `${nearMisses.length}`)
const exactTitle = fusePapers([
  { sourceId: 'a', papers: [{ title: 'Exactly The Same Title Here', doi: '10.1/a', sources: ['a'] }] },
  { sourceId: 'b', papers: [{ title: 'Exactly The Same Title Here', doi: '10.1/b', sources: ['b'] }] },
])
check(exactTitle.length === 1, 'an exact title still merges when the identifiers differ')
check(canonicalKeys({ title: 'A', doi: '10.1000/A', arxiv: '2305.06983' }).includes('doi:10.1000/a'), 'canonical keys are lowercase')
check(titleKey('The  Retrieval‐Augmented Generation!') === 'the retrieval augmented generation', 'title keys drop punctuation')

// --- post-processing -----------------------------------------------------------------------------

console.log('\n[4] the caller’s sort and filters are applied after fusion')
const BASE = [
  { title: 'Older, highly cited', year: 2010, citations: 100, openAccess: true, pdfUrl: 'https://x/1.pdf' },
  { title: 'Newer, less cited', year: 2024, citations: 2, openAccess: false },
  { title: 'Undated', citations: 5 },
]
check(postProcess(BASE, { sort: 'citations' })[0].title === 'Older, highly cited', 'citation sort puts the largest first')
check(postProcess(BASE, { sort: 'date' })[0].title === 'Newer, less cited', 'date sort puts the newest first')
check(postProcess(BASE, { openAccess: true }).length === 1, 'the open-access filter keeps only a copy or a flag')
check(postProcess(BASE, { yearFrom: 2011 }).every((paper) => paper.year === undefined || paper.year >= 2011), 'the lower year bound is applied')
check(postProcess(BASE, { yearTo: 2010 }).every((paper) => paper.year === undefined || paper.year <= 2010), 'the upper year bound is applied')
check(postProcess([{ title: 'Future', year: new Date().getFullYear() + 5 }], {}).length === 0 || postProcess([{ title: 'Future', year: new Date().getFullYear() + 5 }], {})[0].year === undefined, 'a future year is not printed as fact')

// --- the command line ----------------------------------------------------------------------------

console.log('\n[5] the command line refuses the combinations it cannot honour')
const search = parseArgs(['--search', 'retrieval', '--limit', '3', '--sort', 'date', '--open-access', '--mark-library'])
check(search.mode === 'search' && search.limit === 3 && search.markLibrary === true, 'a search parses its flags')
const citations = parseArgs(['--citations', '10.1000/a', '--direction', 'citations', '--limit', '2'])
check(citations.mode === 'citations' && citations.direction === 'citations', 'a citation query parses')
throws('no mode is refused', () => parseArgs([]))
throws('two modes are refused', () => parseArgs(['--search', 'x', '--citations', 'y']))
throws('citations without a direction are refused', () => parseArgs(['--citations', 'y']))
throws('direction on a search is refused', () => parseArgs(['--search', 'x', '--direction', 'citations']))
throws('an unknown source is refused', () => parseArgs(['--search', 'x', '--sources', 'scholar']))
throws('an unknown sort is refused', () => parseArgs(['--search', 'x', '--sort', 'newest']))
throws('a reversed year range is refused', () => parseArgs(['--search', 'x', '--year-from', '2025', '--year-to', '2020']))

// --- failures stay distinguishable ---------------------------------------------------------------

console.log('\n[6] a refusal is not an empty search')
throws('a 429 is rate limiting, not zero results', () => jsonOf({ status: 429, contentType: 'application/json', body: '{}' }, 'Semantic Scholar'), 'rate-limited')
throws('a body that is not JSON is a parse failure', () => jsonOf({ status: 200, contentType: 'text/html', body: '<html>' }, 'DBLP'), 'parse')
await searchSemanticScholar({ query: 'x', limit: 1, sort: 'relevance' }, {}).then(
  () => check(false, 'S2 without a key refuses'),
  (error) => check(error.code === 'no-key', 'S2 without a key is no-key, without a request', error.code),
)
const realFetch = globalThis.fetch
globalThis.fetch = async () => new Response('<!doctype html><title>Making sure you\'re not a bot!</title>', { status: 202 })
await searchDblp({ query: 'x', limit: 1 }).then(
  () => check(false, 'DBLP 202 is not read as empty'),
  (error) => check(error.code === 'blocked', 'DBLP 202 is blocked, not zero results', error.code),
)
globalThis.fetch = realFetch

// --- the rendered block --------------------------------------------------------------------------

console.log('\n[7] a result names its identity and its library status')
const rendered = formatPaper(
  {
    title: 'A title',
    authors: ['Ada Lovelace', 'Alan Turing'],
    year: 2020,
    venue: 'Journal',
    doi: '10.1000/a',
    citations: 5,
    openAccess: true,
    pdfUrl: 'https://example.org/a.pdf',
    sources: ['openalex', 'crossref'],
    abstract: 'An abstract that is long enough to be cut at the snippet budget. '.repeat(10),
  },
  1,
  { abstract: 'snippet', mark: { status: 'in', key: 'ABCD2345', ref: 'zotero://user/0/item/ABCD2345' } },
)
check(rendered.includes('id: 10.1000/a') && rendered.includes('cited 5'), 'the identity and count are printed')
check(rendered.includes('library: ABCD2345'), 'the library mark is printed')
check(rendered.includes('abs:') && rendered.includes('…'), 'a snippet is cut and marked')
check(formatPaper({ title: 'Bare', authors: [], sources: [] }, 2, { abstract: 'none' }).includes('unknown'), 'a paper with no authors says unknown')

// --- key resolution ------------------------------------------------------------------------------

console.log('\n[8] keys come from the environment, never from the command line')
process.env.AUTORESEARCH_S2_KEY = ' secret '
const keys = keysOf({ mailto: 'a@b.c' })
check(keys.s2Key === 'secret' && keys.mailto === 'a@b.c', 'the environment key is trimmed and read')
delete process.env.AUTORESEARCH_S2_KEY

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
