// Unit self-test for the export helper, runnable without a library running.
//
// Usage: node tools/tests/zotero-export-selftest.mjs
//
// The fixtures are the shapes the local API documents: an item listing whose rows include notes and
// attachments, and a citation batch that may answer in a different order than it was asked.
import {
  buildExportPath,
  orderCitations,
  parseArgs,
  selectExportKeys,
} from '../zotero-export.mjs'
import { PERSONAL_LIBRARY } from '../zotero-local-api.mjs'

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

console.log('reference-library export self-test')

// --- the command line ---------------------------------------------------------------------------

console.log('\n[1] the command line')
const single = parseArgs(['--item', 'ABCD2345', '--format', 'bibtex'])
check(single.items.join(',') === 'ABCD2345' && single.format === 'bibtex', 'one item and one format parse')
check(single.style === 'apa' && single.locale === 'en-US', 'the citation defaults are stated rather than hidden')
const repeated = parseArgs(['--item', 'A', '--item', 'B', '--format', 'citation'])
check(repeated.items.join(',') === 'A,B', 'items keep their request order')
const collection = parseArgs(['--collection', 'ABCD2345', '--format', 'bibliography', '--library', 'group:42'])
check(collection.collection === 'ABCD2345' && collection.library.id === 42, 'a collection export can name a group')
check(collection.limit === 50, 'a collection export defaults to the request cap')
throws('no target is refused', () => parseArgs(['--format', 'bibtex']))
throws('both targets are refused', () => parseArgs(['--item', 'A', '--collection', 'B', '--format', 'bibtex']))
throws('no format is refused', () => parseArgs(['--item', 'A']))
throws('an unknown format is refused', () => parseArgs(['--item', 'A', '--format', 'docx']))
throws('a zero limit is refused', () => parseArgs(['--collection', 'A', '--format', 'bibtex', '--limit', '0']))
throws('a user library other than zero is refused', () => parseArgs(['--item', 'A', '--format', 'bibtex', '--library', 'user:5']))

// --- the request path ---------------------------------------------------------------------------

console.log('\n[2] each format asks for its own pipeline')
const base = { style: 'apa', locale: 'en-US', library: PERSONAL_LIBRARY }
const bibtex = buildExportPath(['A', 'B'], { ...base, format: 'bibtex' })
check(bibtex.startsWith('/api/users/0/items?'), 'the personal library prefix is used', bibtex)
check(bibtex.includes('itemKey=A%2CB'), 'the keys are one comma-joined value')
check(bibtex.includes('format=bibtex'), 'a translator format passes its own name')
const bibliography = buildExportPath(['A'], { ...base, format: 'bibliography' })
check(bibliography.includes('format=bib'), 'a bibliography is the `bib` pipeline')
check(bibliography.includes('style=apa') && bibliography.includes('locale=en-US'), 'and it carries style and locale')
const citation = buildExportPath(['A'], { ...base, format: 'citation' })
check(citation.includes('include=citation'), 'a citation is the `include=citation` pipeline')
const group = buildExportPath(['A'], { ...base, format: 'ris', library: { type: 'group', id: 42 } })
check(group.startsWith('/api/groups/42/items?'), 'a group export uses the group prefix', group)

// --- what may be exported -----------------------------------------------------------------------

console.log('\n[3] only records are exportable')
const ROWS = [
  { key: 'A', data: { itemType: 'journalArticle' } },
  { key: 'B', data: { itemType: 'note' } },
  { key: 'C', data: { itemType: 'attachment' } },
  { key: 'D', data: { itemType: 'conferencePaper' } },
  { key: 'A', data: { itemType: 'journalArticle' } },
]
check(selectExportKeys(ROWS).join(',') === 'A,D', 'notes and attachments are skipped, duplicates are collapsed', selectExportKeys(ROWS).join(','))
check(selectExportKeys([]).length === 0, 'no rows is no keys')

// --- citation order -----------------------------------------------------------------------------

console.log('\n[4] the caller’s order is restored')
const CITED = [
  { key: 'B', citation: '<i>B</i>' },
  { key: 'A', citation: '<i>A</i>' },
]
const ordered = orderCitations(CITED, ['A', 'B'])
check(ordered[0].key === 'A' && ordered[0].citation === '<i>A</i>', 'the first requested key comes first')
check(ordered[1].key === 'B', 'and the second follows')
const missing = orderCitations([{ key: 'A', citation: 'x' }], ['A', 'B'])
check(missing[1].citation === '', 'a citation the library omitted is empty, not invented')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
