// Unit self-test for the open-access reader, runnable without a network.
//
// Usage: node tools/tests/scholarly-read-selftest.mjs
//
// The fixtures are the shapes the routes actually answer: arXiv's LaTeXML HTML (with its "Report GitHub
// Issue" heading), and a JATS body with nested `<sec>` elements and a reference list that must not be
// read as article text.
import {
  extractSections,
  findSection,
  parseArgs,
  parseHtmlToText,
  parseJatsToText,
  textOf,
} from '../scholarly-read.mjs'

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

console.log('open-access reader self-test')

// --- HTML ----------------------------------------------------------------------------------------

console.log('\n[1] arXiv HTML becomes headings and paragraphs, without its chrome')
const HTML = `<!doctype html><html><head><style>.x{color:red}</style></head><body>
<h2>Report GitHub Issue</h2>
<h1>Attention Is All You Need</h1>
<h2>Abstract</h2>
<p>We propose a new network &amp; it works.</p>
<h2>1 Introduction</h2>
<p>Recurrent models &lt;have&gt; limits.</p>
<script>alert('not the paper')</script>
<h3>1.1 A subsection</h3>
<p>More text.</p>
</body></html>`
const htmlText = parseHtmlToText(HTML)
check(!htmlText.includes('Report GitHub Issue'), 'the reader chrome heading is dropped')
check(!htmlText.includes('alert'), 'script text is dropped')
check(htmlText.includes('# Attention Is All You Need'), 'the article title is a level-1 heading')
check(htmlText.includes('## 1 Introduction'), 'a section is a level-2 heading')
check(htmlText.includes('### 1.1 A subsection'), 'a subsection keeps its level')
check(htmlText.includes('& it works') && htmlText.includes('<have>'), 'entities are decoded')
check(!htmlText.includes('.x{color:red}'), 'style text is dropped')
check(textOf('<p>a &amp; b</p>') === 'a & b', 'textOf strips tags and decodes entities')

// --- JATS ----------------------------------------------------------------------------------------

console.log('\n[2] JATS becomes headings by section depth, and skips the reference list')
const JATS = `<?xml version="1.0"?><article><front><title>Not the body</title></front><body>
<sec><title>Results</title><p>First paragraph.</p>
<sec><title>Accuracy</title><p>Second paragraph.</p></sec>
</sec><sec><title>Methods</title><p>Third paragraph.</p></sec>
</body><back><ref-list><title>References</title><ref><mixed-citation>Do not read me.</mixed-citation></ref></ref-list></back></article>`
const jatsText = parseJatsToText(JATS)
check(jatsText.includes('# Results'), 'a top-level section is a level-1 heading')
check(jatsText.includes('## Accuracy'), 'a nested section is a level-2 heading')
check(jatsText.includes('# Methods'), 'a sibling returns to level 1')
check(!jatsText.includes('Do not read me'), 'the reference list is outside <body> and is not read')
check(!jatsText.includes('Not the body'), 'the front matter is not read')
check(jatsText.includes('First paragraph.'), 'body paragraphs are kept')

// --- sections ------------------------------------------------------------------------------------

console.log('\n[3] a heading owns its text and can be found by number or title')
const TEXT = ['# Top', 'intro', '## 3 Methods', 'method text', '### 3.1 Sampling', 'sample text', '## 4 Results', 'result text'].join('\n')
const sections = extractSections(TEXT)
check(sections.length === 4, 'four headings are found', `${sections.length}`)
check(sections[1].title === '3 Methods' && sections[1].start < sections[1].end, 'a section owns a span')
check(TEXT.slice(sections[1].start, sections[1].end).includes('sample text'), 'a top-level section carries its subsection')
check(findSection(sections, '3').title === '3 Methods', 'a number finds its section')
check(findSection(sections, '3.1').title === '3.1 Sampling', 'a dotted number finds the subsection')
check(findSection(sections, 'Methods').title === '3 Methods', 'a title finds its section')
check(findSection(sections, 'results').title === '4 Results', 'matching is case-insensitive')
check(findSection(sections, 'nothing') === undefined, 'an absent title is undefined, not the first section')

// --- the command line ----------------------------------------------------------------------------

console.log('\n[4] the command line bounds what one read may hold')
check(parseArgs(['--id', 'arXiv:1706.03762', '--outline']).outline === true, 'an outline parses')
check(parseArgs(['--id', 'x', '--query', 'attention', '--passages', '2']).passages === 2, 'passages parse')
throws('--id is required', () => parseArgs([]))
throws('--outline with --section is refused', () => parseArgs(['--id', 'x', '--outline', '--section', '3']))
throws('a zero start is allowed but a negative one is not', () => parseArgs(['--id', 'x', '--start', '-1']))
throws('--max-chars has a floor', () => parseArgs(['--id', 'x', '--max-chars', '10']))
throws('--max-chars has a ceiling', () => parseArgs(['--id', 'x', '--max-chars', '999999']))
throws('an unknown flag is refused', () => parseArgs(['--id', 'x', '--frobnicate']))

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
