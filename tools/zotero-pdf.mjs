#!/usr/bin/env node
// Read the attachment ITSELF, for the three rungs the library's index cannot serve.
//
// WHY THIS FILE EXISTS
//
// `zotero-read.mjs --fulltext` answers from the reference manager's index, which is cheap and is the
// first rung of the ladder §6 and `INV-CTX-1` state. It fails in two ways that look identical in a
// transcript and are not the same thing at all:
//
//   * the attachment was never indexed, or its index is stale, and the empty text is a statement about
//     the index rather than about the paper;
//   * the paper's mathematics never became text - a scanned page, or a text layer whose font encoding
//     is broken (`>=` arriving as `P`, `1/4` as a glyph) - and the text is confidently wrong.
//
// This helper adds the rungs that answer those. It reads the file on disk, which the library's own API
// hands over as a `file://` redirect (`GET /items/<key>/file`), and it states which rung answered:
//
//   ① the library's indexed text      zotero-read.mjs --fulltext
//   ② the file's own text layer       --extract     (same encoding table, so it fixes 1, never 2)
//   ③ the paper's own table of contents  --outline  (the paper's own section list, whole or absent)
//   ④ the page as an image            --render      (the rung that answers mathematics)
//
// NO NATIVE DEPENDENCY, AND NO SECOND RUNTIME
//
// The engine is PDFium compiled to WebAssembly (`@hyzyla/pdfium`, whose only binary is `pdfium.wasm`),
// plus pdf.js for the one thing that build does not export: the document's own bookmarks. PDFium hands
// back a raw bitmap and expects the caller to encode it; the caller here is `encodePng`, thirty lines
// over `node:zlib`, so that reading a page as an image costs this package no native module and no
// Python environment.
//
// Usage:
//   node tools/zotero-pdf.mjs --item <recordKey> --outline
//   node tools/zotero-pdf.mjs --item <recordKey> --extract [--offset N] [--limit N] [--grep TERM]
//   node tools/zotero-pdf.mjs --item <recordKey> --render --pages 3-5 [--scale 1.5] [--out DIR]
// Exit codes: 0 answered | 1 this rung has nothing to give | 2 usage.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFiumLibrary } from '@hyzyla/pdfium'
import { childrenOf, filePathFrom, localRequest } from './zotero-local-api.mjs'
import { findPassages, readItemOrRefuse, sliceText } from './zotero-read.mjs'
import { romanToNumber } from './zotero-section-note.mjs'
import { Refusal, UsageError, reportFailure } from './refusal.mjs'

export { filePathFrom }

const READABLE = ['application/pdf', 'application/epub+zip', 'text/html']
const DEFAULT_LIMIT = 12000

/** The attachment a reading should use, in the order the disciplines state: PDF, then EPUB, then HTML. */
export function attachmentOf(children) {
  for (const type of READABLE) {
    const hit = children.find((child) => child.data?.itemType === 'attachment' && child.data?.contentType === type)
    if (hit) return hit
  }
  return undefined
}

/**
 * A heading's own ordinal, as the paper writes it, or '' when the heading carries none.
 *
 * The table of contents is the paper's own numbering, so it is where `I Introduction` and
 * `Appendix A` come from - the two forms the write side of a section note deliberately refuses to
 * accept. Mapping them here is what lets a round key a note on the ordinal a person would use.
 *
 * @param {string} title A table-of-contents entry.
 * @returns {string} A top-level ordinal ('3', 'A'), or ''.
 */
export function headingOrdinal(title) {
  const text = String(title ?? '').trim()
  const appendix = /^appendix\s+([A-Z])\b/i.exec(text)
  if (appendix) return appendix[1].toUpperCase()
  const arabic = /^(\d+(?:\.\d+)*)[.)]?\s+\S/.exec(text)
  if (arabic) return arabic[1].split('.')[0]
  const roman = /^([IVXLC]+)[.)]?\s+\S/.exec(text)
  if (roman) {
    const value = romanToNumber(roman[1])
    return value ? String(value) : ''
  }
  return ''
}

/** Flatten pdf.js's outline tree into one row per entry, in document order. */
export function outlineRows(items, depth = 0) {
  const rows = []
  for (const item of items ?? []) {
    rows.push({ depth, title: String(item.title ?? '').trim(), ordinal: headingOrdinal(item.title) })
    rows.push(...outlineRows(item.items, depth + 1))
  }
  return rows
}

// --- PNG, encoded here so that nothing native has to ship -----------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** The CRC-32 a PNG chunk carries. */
export function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One `type + data + crc` PNG chunk. */
export function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * RGBA bytes to PNG bytes, dropping alpha.
 *
 * @param {Uint8Array} rgba Four bytes per pixel, row-major.
 * @param {number} width Pixels per row.
 * @param {number} height Rows.
 * @returns {Buffer} A PNG whose only filter is "none" on every scanline.
 */
export function encodePng(rgba, width, height) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4
      const to = y * (stride + 1) + 1 + x * 3
      raw[to] = rgba[from]
      raw[to + 1] = rgba[from + 1]
      raw[to + 2] = rgba[from + 2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** `3-5` or `3` or `2,7-8` as zero-based indices. */
export function parsePages(spec, pageCount) {
  const indices = []
  for (const part of String(spec ?? '').split(',')) {
    const piece = part.trim()
    if (piece === '') continue
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(piece)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from < 1 || to < from) throw new UsageError(`--pages '${piece}' is not a page range`)
      for (let page = from; page <= to; page += 1) indices.push(page - 1)
      continue
    }
    if (!/^\d+$/.test(piece)) throw new UsageError(`--pages '${piece}' is neither a page nor a range`)
    indices.push(Number(piece) - 1)
  }
  if (indices.length === 0) throw new UsageError('--pages needs at least one page, e.g. --pages 3-5')
  const beyond = indices.filter((index) => index < 0 || index >= pageCount)
  if (beyond.length) throw new UsageError(`--pages asks for page ${beyond[0] + 1}, and this file has ${pageCount}`)
  return indices
}

// --- the rungs -------------------------------------------------------------------------------------

const RUNG = {
  extract: [
    'rung    : (2) the file\'s own text layer. It reads the same encoding table the library index does,',
    '          so it answers an attachment the library never indexed - and it reads mathematics just as',
    '          wrongly when the encoding is broken. The page image (--render) is the rung for that.',
  ],
  outline: [
    'rung    : (3) the paper\'s own table of contents. It is what the PAPER says its sections are, and it',
    '          is absent from many papers - so a heading written into a note is still the heading found',
    '          in the text, and the ordinal below is this table\'s reading of it.',
  ],
  render: [
    'rung    : (4) the page as an image. This is the rung that answers mathematics no text layer holds;',
    '          its output is read as an image and is never quoted as though it were text.',
  ],
}

async function openFile(itemKey) {
  const record = await readItemOrRefuse(itemKey)
  if (record.itemType === 'note') throw new UsageError(`${itemKey} is a note; pass the record the attachment belongs to`)
  const children = await childrenOf(itemKey)
  const attachment = attachmentOf(children)
  if (!attachment) {
    // Exit 1, not 2: the command line was right, the record simply carries nothing to read. Saying
    // "usage" here sent a reader back to re-type a command that had already been typed correctly.
    throw new Refusal(`${itemKey} carries no PDF, EPUB or HTML attachment, so there is no file to read`, {
      fix: 'attach the file to the record in the library; a record without one has no text for any rung',
    })
  }
  const redirect = await localRequest('GET', `/api/users/0/items/${attachment.key}/file`)
  if (redirect.status !== 302) {
    throw new Error(`the library did not hand over a path for ${attachment.key} (HTTP ${redirect.status})`)
  }
  const path = filePathFrom(redirect.headers.location)
  if (!path) throw new Error(`${attachment.key} answered a location that is not a file: ${redirect.headers.location}`)
  return { record, attachment, path, bytes: readFileSync(path) }
}

/**
 * A stable directory name for a URL's rendered pages.
 *
 * @param {string} url The PDF URL.
 * @returns {string} A filesystem-safe slug.
 */
export function urlSlug(url) {
  try {
    const base = new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'paper'
    const slug = base.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    return slug || 'paper'
  } catch {
    return 'paper'
  }
}

/**
 * The bytes one invocation reads: a library attachment, or an open-access URL.
 *
 * A URL is a different provenance, so it is reported as one: the page image and the text layer come
 * from that file, not from the library, and nothing here pretends otherwise.
 */
async function openSource(options) {
  if (!options.url) return openFile(options.item)
  const response = await fetch(options.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
    headers: { 'user-agent': 'dsh-autoresearch/1.0 (pdf reader)' },
  })
  if (!response.ok) {
    throw new Refusal(`the URL answered HTTP ${response.status}`, {
      fix: 'check the address; an open-access listing is a lead, and a dead or wrong-version link is a failed lead',
    })
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0) throw new Refusal('the URL answered an empty body', { fix: 'try the landing page and find the PDF link again' })
  if (bytes.length > 80 * 1024 * 1024) {
    throw new Refusal(`the file is ${Math.round(bytes.length / 1024 / 1024)} MB, above the 80 MB guard`, {
      fix: 'download it yourself and read the page you need; this helper will not hold a whole book in memory',
    })
  }
  const head = Buffer.from(bytes.subarray(0, 5)).toString('latin1')
  const contentType = String(response.headers.get('content-type') ?? '')
  if (head !== '%PDF-' && !/pdf/i.test(contentType)) {
    throw new Refusal('the URL did not answer a PDF', {
      fix: 'an open-access landing page is not the file; follow it to the PDF link and pass that URL',
    })
  }
  return {
    record: null,
    attachment: { key: 'url', data: { contentType: contentType || 'application/pdf' } },
    path: options.url,
    bytes,
  }
}

/**
 * The text layer of one PDF, page by page.
 *
 * Shared with the scholarly reader, which fetches an open-access PDF and needs the same extraction
 * without going through a library record.
 *
 * @param {Uint8Array|Buffer} bytes The file.
 * @returns {Promise<{text: string, pageCount: number}>} The text and the page count.
 */
export async function extractPdfText(bytes) {
  const library = await PDFiumLibrary.init()
  const document = await library.loadDocument(new Uint8Array(bytes))
  const pages = []
  for (const page of document.pages()) {
    pages.push(page.getText())
    page.close()
  }
  const pageCount = document.getPageCount()
  const text = pages.join('\n\n')
  document.destroy()
  library.destroy()
  return { text, pageCount }
}

/**
 * A PDF's own table of contents.
 *
 * @param {Uint8Array|Buffer} bytes The file.
 * @returns {Promise<{rows: object[], pageCount: number}>} The outline rows and the page count.
 */
export async function pdfOutline(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, disableFontFace: true })
  const document = await task.promise
  const rows = outlineRows(await document.getOutline())
  const pageCount = document.numPages
  await task.destroy()
  return { rows, pageCount }
}

async function runExtract(input, options) {
  const { attachment, path, bytes } = input
  const { text, pageCount } = await extractPdfText(bytes)

  console.log(`source  : ${input.record ? 'the attachment' : 'the open-access URL'}, text layer read from ${path}`)
  console.log(`file    : ${attachment.key}  ${attachment.data.contentType}  ${pageCount} pages  ${text.length} characters`)
  console.log(RUNG.extract.join('\n'))

  if (options.grep) {
    const hits = findPassages(text, options.grep)
    console.log(`\ngrep    : "${options.grep}"  ${hits.length} hit(s)`)
    for (const hit of hits) console.log(`  @${hit.index}  ${hit.excerpt}`)
    return hits.length ? 0 : 1
  }
  const slice = sliceText(text, { offset: options.offset ?? 0, limit: options.limit ?? DEFAULT_LIMIT })
  console.log(`\nslice   : ${slice.from}-${slice.to} of ${slice.total}${slice.nextOffset === null ? ' (end)' : `  next --offset ${slice.nextOffset}`}`)
  console.log(`\n${slice.text}`)
  return 0
}

async function runOutline(input) {
  const { path, bytes } = input
  const { rows, pageCount } = await pdfOutline(bytes)

  console.log(`source  : the paper's own table of contents, embedded in ${path}`)
  console.log(`file    : ${path}  ${pageCount} pages  ${rows.length} entries`)
  console.log(RUNG.outline.join('\n'))
  if (rows.length === 0) {
    console.error('\nThis file carries no table of contents, so rung (3) has nothing to give: read the')
    console.error('boundaries from the text (rung (1) or (2)) and write down the headings you find.')
    return 1
  }
  console.log('')
  for (const row of rows) {
    const ordinal = row.ordinal ? `§${row.ordinal}`.padEnd(5) : '     '
    console.log(`${'  '.repeat(row.depth)}${ordinal} ${row.title}`)
  }
  return 0
}

async function runRender(input, options) {
  const { attachment, path, bytes } = input
  const library = await PDFiumLibrary.init()
  const document = await library.loadDocument(new Uint8Array(bytes))
  const indices = parsePages(options.pages, document.getPageCount())
  const base = options.item || urlSlug(options.url)
  const outDir = resolve(options.out || (options.item ? join('.section-notes', options.item, 'pages') : join('.pdf-pages', base)))
  mkdirSync(outDir, { recursive: true })

  console.log(`source  : ${input.record ? 'the attachment' : 'the open-access URL'}, rendered to an image`)
  console.log(`file    : ${path}  ${attachment.data.contentType}  ${document.getPageCount()} pages`)
  console.log(`out     : ${outDir}`)
  console.log(`scale   : ${options.scale ?? 1.5} (72 dpi is 1)`)
  console.log(RUNG.render.join('\n'))
  console.log('')
  const started = process.hrtime.bigint()
  for (const index of indices) {
    const page = document.getPage(index)
    const rendered = await page.render({ scale: options.scale ?? 1.5, render: 'bitmap' })
    const png = encodePng(rendered.data, rendered.width, rendered.height)
    const file = join(outDir, `page-${String(index + 1).padStart(3, '0')}.png`)
    writeFileSync(file, png)
    console.log(`page ${String(index + 1).padStart(3)}  ${rendered.width}x${rendered.height}  ${(png.length / 1024).toFixed(0)} KB  ${file}`)
    page.close()
  }
  document.destroy()
  library.destroy()
  console.log(`\n${indices.length} page(s) in ${(Number(process.hrtime.bigint() - started) / 1e6).toFixed(0)} ms. Read them as images; none of this is text.`)
  return 0
}

const USAGE =
  'usage: node tools/zotero-pdf.mjs --item <recordKey> --outline\n' +
  '       node tools/zotero-pdf.mjs --item <recordKey> --extract [--offset N] [--limit N] [--grep TERM]\n' +
  '       node tools/zotero-pdf.mjs --item <recordKey> --render --pages 3-5 [--scale 1.5] [--out DIR]\n' +
  '       node tools/zotero-pdf.mjs --url <https-pdf> --outline|--extract|--render   # an open-access copy\n' +
  '       One rung per invocation. Rung (2) reads the file\'s text layer, (3) the paper\'s own table of\n' +
  '       contents, (4) the page as an image; the library\'s indexed text is zotero-read.mjs --fulltext.'

export function parseArgs(argv) {
  const options = { item: '', url: '', outline: false, extract: false, render: false, offset: 0, limit: 0, grep: '', pages: '', scale: 0, out: '' }
  const valued = ['--item', '--url', '--offset', '--limit', '--grep', '--pages', '--scale', '--out']
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = argv[index + 1]
    if (flag === '--outline' || flag === '--extract' || flag === '--render') {
      options[flag.slice(2)] = true
      continue
    }
    if (!valued.includes(flag)) throw new UsageError(`unrecognised argument '${flag}'`)
    if (!next) throw new UsageError(`${flag} needs a value`)
    if (flag === '--offset' || flag === '--limit') options[flag.slice(2)] = Number(next)
    else if (flag === '--scale') options.scale = Number(next)
    else options[flag.slice(2)] = next
    index += 1
  }
  const rungs = [options.outline, options.extract, options.render].filter(Boolean).length
  if (rungs === 0) throw new UsageError('pass one of --outline, --extract or --render')
  if (rungs > 1) throw new UsageError('one rung per invocation: --outline, --extract and --render are three different reads')
  if (!options.item && !options.url) throw new UsageError('pass --item <recordKey> or --url <https-pdf>')
  if (options.item && options.url) throw new UsageError('pass --item or --url, not both: they are two provenances')
  if (options.url && !/^https?:\/\//i.test(options.url)) throw new UsageError('--url takes an http(s) URL')
  if (options.render && !options.pages) throw new UsageError('--render needs --pages, so a round renders the page it needs rather than the whole file')
  if (!options.render && options.pages) throw new UsageError('--pages belongs to --render')
  if (options.offset < 0 || options.limit < 0) throw new UsageError('--offset and --limit count characters and cannot be negative')
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const input = await openSource(options)
  if (options.outline) process.exitCode = await runOutline(input)
  else if (options.extract) process.exitCode = await runExtract(input, options)
  else process.exitCode = await runRender(input, options)
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  main().catch((error) => {
    process.exitCode = reportFailure(error, { usage: USAGE })
  })
}
