// Unit self-test for the arXiv channel helper, runnable without the network.
//
// Usage: node tools/tests/arxiv-selftest.mjs      (or: node tools/arxiv.mjs --selftest)
//
// Every fixture below is a REAL response captured on 2026-10-15, not a hand-written one: the normal
// feed is trimmed to a single <entry> and is otherwise verbatim, and the two failure feeds are
// byte-for-byte what the API answered. That matters because the property this file exists to pin is
// a measured shape, not a belief about one:
//
//   * an upstream failure arrives with `totalResults` 1 and exactly ONE <entry>, whose id is the
//     sentinel https://arxiv.org/api/errors. A rule keyed on "does the feed carry entries" reports
//     a failure as a paper, so the fixtures must contain the real thing. The fixture below is the
//     HTTP 500 case (oversized page); the same shape was confirmed live at HTTP 400 as well (an
//     invalid query), which is why the rule keys on the shape rather than on the status code.
//   * an unknown id arrives as HTTP 200, `totalResults` 0 and NO <entry>: answered-and-empty, which
//     must not be reported as a failure.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  arxivFailure,
  buildQueryUrl,
  decodeXml,
  describeSort,
  formatEntries,
  parseArgs,
  parseFeed,
  truncateAbstract,
} from '../arxiv.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  -> ${detail}` : ''}`)
  if (!condition) failures += 1
}
const throws = (label, run) => {
  try {
    run()
    check(false, label, 'nothing was thrown')
  } catch {
    check(true, label)
  }
}

console.log('arxiv channel self-test')

// --- fixtures: captured verbatim on 2026-10-15 ---------------------------------------------------

const MEASURED_HEAD = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/BrGDkjP5utSCGoJGTsyn5IDrXrE</id>
  <title>arXiv Query: search_query=cat:cs.CL AND abs:"retrieval augmented"&amp;id_list=&amp;start=0&amp;max_results=2</title>
  <updated>2026-10-15T01:40:37Z</updated>
  <link href="https://arxiv.org/api/query?search_query=cat:cs.CL+AND+abs:%22retrieval+augmented%22&amp;start=0&amp;max_results=2&amp;id_list=" type="application/atom+xml"/>
  <opensearch:itemsPerPage>2</opensearch:itemsPerPage>
  <opensearch:totalResults>3779</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  `

const MEASURED_ENTRY = `  <entry>
    <id>http://arxiv.org/abs/2610.19549v1</id>
    <title>GraphRAG-LTM: A Layered Threat Modeling Framework for Attacks on Graph Retrieval-Augmented Generation</title>
    <updated>2026-10-14T04:04:34Z</updated>
    <link href="https://arxiv.org/abs/2610.19549v1" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2610.19549v1" rel="related" type="application/pdf" title="pdf"/>
    <summary>Graph retrieval-augmented generation (GraphRAG) uses document-derived knowledge graphs to assemble evidence for large language model (LLM) answers. Its security depends on both the seed chunks retrieved for a query and the graph evidence assembled from them, yet attacks on this evidence path remain underexplored. We introduce GraphRAG-LTM, a Layered Threat Modeling framework that tests three nested levels of attacker access. BB Query uses ranking feedback to make query edits under a semantic-similarity constraint and demote relevant seed chunks. WB Query uses retriever gradients for the same objective. Graph-aware WB keeps the white-box adversarial query and deletes bridge triplets from the query-specific evidence graph, disrupting multi-hop evidence propagation through localized graph edits. Across datasets, retrievers, and LLM backbones, rank feedback alone reduces answer quality, gradient access strengthens query attacks, and bridge-triplet deletion further impairs supporting-fact retrieval. Further analyses show how seed retrieval and graph evidence jointly contribute to these failures.</summary>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <published>2026-10-14T04:04:34Z</published>
    <arxiv:comment>14 pages, 7 figures</arxiv:comment>
    <arxiv:primary_category term="cs.CL"/>
    <author>
      <name>Yining Tang</name>
    </author>
    <author>
      <name>Junyu Zhang</name>
    </author>
    <author>
      <name>Haomiao Qiu</name>
    </author>
    <author>
      <name>Yongchao Liu</name>
    </author>
    <author>
      <name>Jiajun Zheng</name>
    </author>
    <author>
      <name>Zhao Wang</name>
    </author>
    <author>
      <name>Ziyue Qiao</name>
    </author>
    <author>
      <name>Chao Wu</name>
    </author>
  </entry>
`

const GOOD_FEED = `${MEASURED_HEAD}${MEASURED_ENTRY}</feed>\n`
// The same measured entry twice, purely to exercise the response-wide abstract budget.
const REPEATED_FEED = `${MEASURED_HEAD}${MEASURED_ENTRY}${MEASURED_ENTRY}</feed>\n`

// Captured with max_results=40000. The manual claims HTTP 400 here; the API answered HTTP 500.
const ERROR_FEED = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/</id>
  <title>arXiv Search Results</title>
  <updated>2026-10-15T01:44:12Z</updated>
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>https://arxiv.org/api/errors</id>
    <title>Error</title>
    <updated>2026-10-15T01:44:12Z</updated>
    <link href="https://arxiv.org/api/errors" rel="alternate" type="text/html"/>
    <summary>The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application.</summary>
    <author>
      <name>arXiv api core</name>
    </author>
  </entry>
</feed>
`

// Captured with id_list=9999.99999: a well-formed answer that matched nothing.
const EMPTY_FEED = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/1lIon7zuEVy1/SVAukuOybHhGM8</id>
  <title>arXiv Query: search_query=&amp;id_list=9999.99999&amp;start=0&amp;max_results=10</title>
  <updated>2026-10-15T01:44:13Z</updated>
  <link href="https://arxiv.org/api/query?search_query=&amp;start=0&amp;max_results=10&amp;id_list=9999.99999" type="application/atom+xml"/>
  <opensearch:itemsPerPage>10</opensearch:itemsPerPage>
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
</feed>
`

// --- the url ------------------------------------------------------------------------------------

console.log('\n[1] the request url')

const searchUrl = buildQueryUrl({ search: 'au:hinton' })
check(searchUrl.startsWith('https://export.arxiv.org/api/query?'), 'the https endpoint is used, not the 301 http one', searchUrl)
check(searchUrl.includes('search_query=au%3Ahinton'), 'a search query is carried')
check(searchUrl.includes('start=0') && searchUrl.includes('max_results=10'), 'start and max_results are always explicit')
check(!searchUrl.includes('id_list=') && !searchUrl.includes('sortBy='), 'an unset parameter is not sent at all')

const idsUrl = buildQueryUrl({ ids: ['1706.03762', '2610.19549'] })
check(idsUrl.includes('id_list=1706.03762%2C2610.19549'), 'several ids ride one request, comma-delimited', idsUrl)
const sortedUrl = buildQueryUrl({ search: 'all:electron', sort: 'submittedDate', order: 'descending' })
check(sortedUrl.includes('sortBy=submittedDate') && sortedUrl.includes('sortOrder=descending'), 'sort order is carried when asked for')

// --- entity decoding ----------------------------------------------------------------------------

console.log('\n[2] entity decoding')

check(decodeXml('a &amp; b') === 'a & b', '&amp; is decoded')
check(decodeXml('it&#39;s') === "it's", 'a numeric reference is decoded')
check(decodeXml('it&#x2019;s') === 'it\u2019s', 'a hex reference is decoded')
check(decodeXml('&nosuchentity;') === '&nosuchentity;', 'an unknown reference is left alone rather than dropped')

// --- a normal answer ----------------------------------------------------------------------------

console.log('\n[3] a normal answer')

const good = parseFeed(GOOD_FEED)
check(good.totalResults === 3779, 'the total comes from opensearch, not from the entries returned', String(good.totalResults))
check(good.startIndex === 0 && good.itemsPerPage === 2, 'the paging fields are read')
check(good.error === '', 'a normal feed reports no error')
check(good.query.includes('arXiv Query:') && good.query.includes('&'), 'the canonical query is echoed with its entities decoded', good.query)
check(good.entries.length === 1, 'the entry is parsed', String(good.entries.length))

const first = good.entries[0]
check(first.bare === '2610.19549v1' && first.base === '2610.19549' && first.version === 'v1', 'the id is split into bare, base and version', first.bare)
check(first.authors.length === 8, 'every creator is kept, because a read-back verifies the count', String(first.authors.length))
check(first.primaryCategory === 'cs.CL' && first.categories.includes('cs.CL'), 'the primary category and the category list are read')
check(first.comment === '14 pages, 7 figures', 'the arXiv comment is read')
check(first.absUrl === 'https://arxiv.org/abs/2610.19549v1', 'the abstract link comes from rel="alternate"', first.absUrl)
check(first.pdfUrl === 'https://arxiv.org/pdf/2610.19549v1', 'the pdf link comes from title="pdf", not rel="alternate"', first.pdfUrl)
check(first.doi === '' && first.journalRef === '', 'a record that carries no DOI or journal ref invents neither')

// --- an upstream failure ------------------------------------------------------------------------

console.log('\n[4] an upstream failure is not a record')

const failed = parseFeed(ERROR_FEED)
check(failed.error.includes('internal error'), 'the error summary is surfaced', failed.error.slice(0, 60))
check(failed.entries.length === 0, 'the sentinel entry is NOT returned as a record')
check(failed.totalResults === 1, 'the count alone would have said "one result" - hence the shape rule')
check(!formatEntries(failed.entries).includes('arXiv api core'), 'nothing from the error entry reaches the rendered output')
check(formatEntries(failed.entries) === '', 'an error renders as no records at all')

// --- an answer that matched nothing -------------------------------------------------------------

console.log('\n[5] answered and empty is not a failure')

const empty = parseFeed(EMPTY_FEED)
check(empty.error === '', 'an empty answer is not an error')
check(empty.totalResults === 0 && empty.entries.length === 0, 'zero results is reported as zero')

check(
  (() => {
    try {
      parseFeed('<html><body>gateway timeout</body></html>')
      return false
    } catch {
      return true
    }
  })(),
  'a body that is not an Atom feed is refused, not parsed',
)

// --- truncation ---------------------------------------------------------------------------------

console.log('\n[6] abstracts are cut with their size reported')

const long = 'x'.repeat(1000)
check(truncateAbstract(long, 400).shown === 400 && truncateAbstract(long, 400).total === 1000, 'a cut abstract knows what it lost')
check(truncateAbstract(long, 400).truncated === true, 'the cut is flagged')
check(truncateAbstract(long, 1000).truncated === false, 'an abstract at the limit is not flagged')
check(truncateAbstract(long, 0).text === '' && truncateAbstract(long, 0).truncated === true, 'a zero limit keeps none of it')
check(truncateAbstract('', 400).truncated === false, 'an empty abstract is not a truncation')

const rendered = formatEntries(good.entries)
check(rendered.includes('1. 2610.19549v1  2026-10-14  [cs.CL]'), 'the header line carries id, date and category')
check(rendered.includes('authors : 8  (Yining Tang; Junyu Zhang; Haomiao Qiu; et al.)'), 'creators are summarised with their count')
check(rendered.includes('[truncated 400 of'), 'the rendered abstract says it was truncated')
check(rendered.includes('--id 2610.19549v1 --full'), 'the truncation notice says how to get the rest')

const full = formatEntries(good.entries, { abstractChars: Number.POSITIVE_INFINITY })
check(!full.includes('[truncated'), '--full renders the whole abstract')

const budgeted = parseFeed(REPEATED_FEED).entries
const tight = formatEntries(budgeted, { abstractChars: 400, abstractBudget: 400 })
check((tight.match(/\[truncated 400 of/g) ?? []).length === 1, 'the first abstract spends the budget')
check(tight.includes('budget is spent'), 'the second says the budget is gone instead of quietly printing nothing')
check(
  (tight.match(/^[12]\. 2610\.19549v1/gm) ?? []).length === 2,
  'both records still render, only the abstract is withheld',
)

// --- the command line ---------------------------------------------------------------------------

console.log('\n[7] the command line')

throws('--search together with --id is refused', () => parseArgs(['--search', 'all:x', '--id', '1706.03762']))
throws('neither --search nor --id is refused', () => parseArgs([]))
throws('--max above the helper cap is refused', () => parseArgs(['--id', '1706.03762', '--max', '101']))
throws('an unknown sort is refused rather than silently ignored', () =>
  parseArgs(['--id', '1706.03762', '--sort', 'newest']),
)
throws('an unrecognised flag is refused', () => parseArgs(['--id', '1706.03762', '--frobnicate']))

const parsed = parseArgs(['--id', '1706.03762', '--id', '2610.19549', '--max', '100', '--json'])
check(parsed.ids.length === 2, '--id repeats', String(parsed.ids.length))
check(parsed.max === 100, 'the cap itself is allowed')
check(parsed.json === true && parsed.full === false, 'flags are read')
check(parseArgs(['--search', 'all:x', '--full']).abstractChars === Number.POSITIVE_INFINITY, '--full removes the abstract limit')

// --- what the output claims about the request ---------------------------------------------------

console.log('\n[8] the scope line names only what was actually sent')

check(
  describeSort({}) === 'relevance (API default; not the web interface order)',
  'no --sort and no --order is reported as the API default, not as a value we sent',
)
check(describeSort({ sort: 'submittedDate', order: 'descending' }) === 'submittedDate/descending', 'both are named when both were sent')
check(
  describeSort({ order: 'ascending' }) === 'relevance (API default)/ascending',
  'an order alone still says which sort it applies to',
)

// --- what a refusal means, and what follows it ---------------------------------------------------

console.log('\n[9] a refusal says which of the three nothings this was')

// The three cases look identical from outside ("not 200") and need opposite advice: fixing the query,
// lowering the page size, or waiting. Telling a reader to wait for a malformed id wastes the minute;
// telling them to fix the query for a 429 is what walks them into the loop that caused it.
const badQuery = arxivFailure({ status: 400, feedError: 'incorrect id format for 2401' })
check(badQuery.message.includes('refused this query') && badQuery.fix.includes('objects to the query itself'), 'a 400 with a sentinel entry is about the query, not the rate')
const tooBig = arxivFailure({ status: 500, feedError: 'start + max_results > 30000' })
check(tooBig.fix.includes('lower --max'), 'a 500 with a sentinel entry is about the page size')
const throttled = arxivFailure({ status: 429 })
check(throttled.message.includes('throttling') && throttled.fix.startsWith('wait a minute'), '429 is the rate limiter, and the advice is to wait')
const down = arxivFailure({ status: 503 })
check(down.message.includes('throttling') && down.fix.startsWith('wait a minute'), '503 is read the same way')
const broken = arxivFailure({ status: 500 })
check(!broken.message.includes('throttling') && broken.fix.includes('its own side'), 'a 500 with no sentinel is arXiv failing on its side, and is not read as "no such paper" - negative control')
check(arxivFailure({ status: 429 }).command === '', 'no command is offered: it would be the one that just failed')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)

/** Whether any check failed, for a caller that imported this file rather than ran it. */
export const failedChecks = failures > 0

// Exit only when this file IS the command. `--selftest` imports it instead, and calling
// process.exit() while that import is still pending trips Node's unsettled-top-level-await check,
// which replaces the real result with exit code 13.
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) process.exit(failures === 0 ? 0 : 1)
