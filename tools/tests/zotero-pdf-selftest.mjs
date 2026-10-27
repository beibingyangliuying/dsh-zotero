#!/usr/bin/env node
// Self-test for the attachment-side reading rungs, offline: everything here is a pure function, so
// none of it needs a library, a file, or an engine.
//
// The rungs themselves are measured against a real paper when this ships; what this file pins is the
// part that can be wrong silently - the path behind the library's redirect, which ordinal a heading
// carries, which page a --pages spec names, and the PNG this package encodes itself instead of
// shipping a native encoder.
import { inflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import {
  attachmentOf,
  crc32,
  encodePng,
  filePathFrom,
  headingOrdinal,
  outlineRows,
  parseArgs,
  parsePages,
  pngChunk,
  urlSlug,
} from '../zotero-pdf.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures += 1
}
const same = (actual, expected, label) => check(actual === expected, label, actual === expected ? '' : `got ${JSON.stringify(actual)}`)
const refused = (run, label) => {
  try {
    const value = run()
    check(false, label, `it returned ${JSON.stringify(value)} instead of refusing`)
  } catch (error) {
    check(true, label, String(error.message).slice(0, 90))
  }
}

console.log('zotero-pdf self-test')

console.log('\n[1] the path behind the redirect')
same(filePathFrom('file:///D:/Store/a%20b.pdf'), 'D:\\Store\\a b.pdf', 'a file URL becomes a path, with its escapes decoded')
same(filePathFrom('file:///C:/x/y.pdf'), 'C:\\x\\y.pdf', 'and another drive works too')
same(filePathFrom('https://example.org/x.pdf'), '', 'anything that is not a file URL is refused - negative control')
same(filePathFrom(''), '', 'and so is an empty location')

console.log('\n[2] which attachment a reading uses')
const child = (contentType) => ({ key: contentType, data: { itemType: 'attachment', contentType } })
same(attachmentOf([child('text/html')]).data.contentType, 'text/html', 'HTML is read when it is all there is')
same(attachmentOf([child('text/html'), child('application/pdf')]).data.contentType, 'application/pdf', 'and a PDF outranks it, in the order the disciplines state')
same(attachmentOf([child('application/epub+zip'), child('text/html')]).data.contentType, 'application/epub+zip', 'EPUB outranks HTML')
same(attachmentOf([{ key: 'N', data: { itemType: 'note' } }]), undefined, 'a note is not an attachment - negative control')
same(attachmentOf([]), undefined, 'and neither is nothing')

console.log('\n[3] the ordinal a heading carries')
same(headingOrdinal('3 Introduction'), '3', 'an arabic heading carries its number')
same(headingOrdinal('3.1 Electricity degree centrality'), '3', 'and a subsection carries its TOP-LEVEL number, the unit that is counted')
same(headingOrdinal('3. Robustness evaluation index'), '3', 'a trailing period does not stop it')
same(headingOrdinal('II Measure of Stress'), '2', 'a Roman numeral is read, which the write side refuses to accept as input')
same(headingOrdinal('Appendix A: Passive and Active Loading'), 'A', 'an appendix is recorded as its letter')
same(headingOrdinal('References'), '', 'a heading with no ordinal carries none - negative control')
same(headingOrdinal('Robustness evaluation of complex power grids'), '', 'and neither does a title')

console.log('\n[4] flattening the table of contents')
const rows = outlineRows([
  { title: '1 Introduction' },
  { title: '3 Robustness evaluation index', items: [{ title: '3.1 Local' }, { title: 'References' }] },
])
same(rows.length, 4, 'every entry is one row')
same(rows[2].depth, 1, 'a nested entry keeps its depth')
same(rows[2].ordinal, '3', 'and still maps to its top-level ordinal')
same(rows[3].ordinal, '', 'a nested entry with no ordinal maps to nothing')
same(outlineRows(undefined).length, 0, 'an absent outline is no rows, not a throw')

console.log('\n[5] which pages --render may name')
same(parsePages('3-5', 8).join(' '), '2 3 4', 'a range becomes zero-based indices')
same(parsePages('2,7', 8).join(' '), '1 6', 'a list works too')
same(parsePages('1', 1).join(' '), '0', 'and a single page')
refused(() => parsePages('', 8), 'an empty spec is refused')
refused(() => parsePages('0', 8), 'page 0 is refused')
refused(() => parsePages('9', 8), 'a page past the end is refused: it is a file with 8, not a wish')
refused(() => parsePages('5-3', 8), 'a backwards range is refused')
refused(() => parsePages('a-b', 8), 'and so is a range that is not numbers')

console.log('\n[6] the PNG this package encodes itself')
const chunk = pngChunk('tEXt', Buffer.from('x'))
const declared = chunk.readUInt32BE(0)
const body = chunk.subarray(4, 4 + 4 + declared)
same(declared, 1, 'a chunk declares its own data length')
same(chunk.readUInt32BE(chunk.length - 4), crc32(body), 'and its CRC covers the type and the data')
check(crc32(Buffer.from('x')) !== crc32(Buffer.from('y')), 'the CRC is not a constant - negative control')

const rgba = Buffer.from([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 0, 128,
])
const png = encodePng(rgba, 2, 2)
same([...png.subarray(0, 8)].join(' '), '137 80 78 71 13 10 26 10', 'a PNG opens with its signature')
same(png.subarray(12, 16).toString('ascii'), 'IHDR', 'and the first chunk is the header')
same(png.readUInt32BE(16), 2, 'the header carries the width')
same(png.readUInt32BE(20), 2, 'and the height')
same(png[24], 8, 'at eight bits per channel')
same(png[25], 2, 'in truecolour, because a rendered page has no alpha to keep')
check(png.subarray(png.length - 8).toString('ascii').includes('IEND'), 'and it ends with IEND')

// The scanlines are what a decoder actually reads: one filter byte per row, then RGB triplets. A
// wrong stride or a filter byte in the wrong place produces a file that is structurally valid and
// visually garbage, which is why this is asserted rather than eyeballed.
const idatStart = png.indexOf('IDAT', 0, 'ascii') + 4
const idatLength = png.readUInt32BE(idatStart - 8)
const raw = inflateSync(png.subarray(idatStart, idatStart + idatLength))
same(raw.length, (2 * 3 + 1) * 2, 'the image data inflates to one filter byte plus three bytes per pixel per row')
same(raw[0], 0, 'each row declares the "none" filter')
same([...raw.subarray(1, 4)].join(' '), '255 0 0', 'the first pixel keeps its red')
same([...raw.subarray(4, 7)].join(' '), '0 255 0', 'the second keeps its green')
same([...raw.subarray(8, 11)].join(' '), '0 0 255', 'the second row arrives after its own filter byte, and its colours are its own')
same([...raw.subarray(11, 14)].join(' '), '255 255 0', 'with alpha dropped rather than shifted into the next pixel')
check(raw[7] !== raw[1] || raw[8] !== raw[2], 'and the rows are not copies of each other - negative control')

console.log('\n[7] the file reads its own documentation the way the disciplines will')
const source = readFileSync(new URL('../zotero-pdf.mjs', import.meta.url), 'utf8')
check(source.includes('① the library') && source.includes('(2) the file') && source.includes('(3) the paper') && source.includes('(4) the page'), 'all four rungs are named, so a reader can see where this sits')
check(!/['"]DELETE['"]/.test(source), 'this helper never sends a DELETE: it reads and renders')
check(source.includes("join('.section-notes', options.item, 'pages')"), 'rendered pages default into the study draft directory, not into the checkout')
check(/--render needs --pages/.test(source), 'and rendering refuses to run without naming pages, so one round cannot render a whole library')
check(!/require\(/.test(source), 'the helper is ESM, like the rest of the suite')

console.log('\n[8] an open-access URL is a provenance, not an attachment')
same(urlSlug('https://example.org/papers/abc.pdf'), 'abc.pdf', 'a URL slug comes from its file name')
same(urlSlug('https://example.org/'), 'paper', 'a URL without a file name still gets a directory')
same(urlSlug('not a url'), 'paper', 'and so does a malformed one')
const fromUrl = parseArgs(['--url', 'https://example.org/abc.pdf', '--extract'])
check(fromUrl.url === 'https://example.org/abc.pdf' && fromUrl.item === '', 'a URL is a source')
refused(() => parseArgs(['--url', 'https://example.org/abc.pdf', '--item', 'ABCD2345', '--extract']), 'two sources are refused: they are two provenances')
refused(() => parseArgs(['--extract']), 'no source is refused')
refused(() => parseArgs(['--url', 'file:///C:/x.pdf', '--extract']), 'a non-http source is refused')
refused(() => parseArgs(['--url', 'https://example.org/abc.pdf', '--render']), 'a URL render still names its pages')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
