#!/usr/bin/env node
// Ask the journal-ranking provider the Zotero side already trusts what it holds about one journal, and
// print that as a quotable line - never as a JCR export.
//
// WHY THIS FILE EXISTS
//
// The disciplines can confirm a work's journal (metadata.mjs) and can confirm which works a project
// cites, but they cannot say "this venue is Q1". Measured 2026-10-21, that gap is real rather than an
// oversight:
//
//   * THE ONLY AUTHORITATIVE SOURCE IS LICENSED. Clarivate's Web of Science Journals API answers with
//     `ranks.jif[].quartile` and `rank: "15/64"` per category, which is exactly the claim - and its own
//     documentation says "Access to this API requires a paid license", with a bare request returning
//     HTTP 401 `{"message":"No API key found in request"}`.
//   * THE CAS TABLE IS GONE. 中国科学院文献情报中心 announced on 2026-03-27 that it would stop
//     updating and publishing the journal partition table from 2026, and the platform closed on
//     2026-09-30. The successor is 《新锐期刊分区表》 (XinRui), which the provider below also carries.
//     So "中科院分区" is now ambiguous between a frozen 2025 edition and a system that replaced it, and a
//     tool that prints "1区" without saying which is worse than one that prints nothing.
//   * THE ZOTERO PLUGIN STORES NOTHING. ZoteroStyle renders its 期刊标签 column by calling EasyScholar's
//     open endpoint at display time. Scanned 2026-10-21: 677 records in the owner's library carried
//     `extra` keys `remark` (259), `titleTranslation` (192), `rate` (88), `TLDR` (31), `arXiv` (11),
//     `_eprint` (6), `ISSN` (5) and four one-offs - and zero rank-like tags. Nothing about a quartile is
//     in the item, so a reader cannot recover it from the record; it has to be asked for again.
//
// What survives that measurement is one genuine channel: EasyScholar's `getPublicationRank`, which the
// installed plugin already has a key for. This file is the smallest thing that turns it into a
// repeatable instrument, and its job is mostly to refuse the ways that channel goes wrong.
//
// MEASURED TRAPS THIS FILE EXISTS TO HANDLE (all reproduced 2026-10-21 from this machine)
//
//   * AN ISSN IS NOT A JOURNAL NAME, AND IT DOES NOT FAIL CLOSED. Asked for `0951-8320` the provider
//     answered `{"swjtu":"A"}` - a non-empty record about something that is not the journal. A near-miss
//     NAME fails closed instead: `Reliability Engineering` (truncated) and `IEEE Transactions on Power
//     System` (singular) both answered `officialRank.all: null`. So `--journal` refuses anything that
//     looks like an ISSN, and `--doi` resolves a real title first rather than passing an identifier on.
//   * THE NAME MATCH IS EXACT, WHICH IS THE GOOD NEWS. `Reliability Engineering & System Safety` and
//     `Reliability Engineering and System Safety` answered byte-identical payloads (727 characters both),
//     so `&` and `and` are the provider's own aliasing rather than a coincidence.
//   * `select` IS THE ACCOUNT'S DISPLAY SET, NOT THE RECORD. For that same journal `select` omitted
//     `xr`, `xrSmall`, `xrTop` and `sciUpSmall` while `all` carried them. A reader that prints `select`
//     reports a thinner journal than the provider knows, so this file reads `all` only.
//   * THE PAYLOAD NAMES NO EDITION AND NO YEAR. `sci: "Q1"` is the provider's current JCR quartile,
//     `sciUp` its current CAS upgraded partition and `xr` its current XinRui partition - none stamped
//     with a release. That is why the output says "provider says" and repeats the retrieval date: this
//     is a transcription someone else made once, not an export you can re-derive.
//   * A QUARTILE IS PER CATEGORY, AND `sci` IS ONE VALUE. JCR ranks a journal inside each of its
//     categories; the provider collapses that to a single Q. The per-category detail it does carry sits
//     in `sciUpSmall` / `xrSmall`, so those are printed whenever they exist and the output states that
//     `sci` is the collapsed form.
//   * NOTHING IN THE PAYLOAD SAYS WHICH JOURNAL IT ANSWERED FOR. No name, no ISSN, no id. The only
//     guard is that the question was an exact title, and the output says so on its own line rather than
//     implying a match it cannot show.
//   * A MISSING KEY IS A CONFIGURATION GAP, NOT A FAILED REQUEST. The provider's own codes are 40005
//     (`密钥不能为空`) and 40002 (`Key错误`), both over HTTP 200. Exit code 2 means "this machine cannot
//     ask yet"; 1 means the channel answered with something that is not a record.
//   * A BURST IS THROTTLED, AND THAT REFUSAL ALSO RIDES ON HTTP 200. Fourteen back-to-back calls for one
//     journal answered normally and the next ones returned `{"code":40006,"msg":"请求频繁，请稍后再试",
//     "data":null}` (45 characters, HTTP 200) at roughly 7 requests per second; the same 15-call sweep
//     spaced 150 ms, 400 ms and 1000 ms apart hit it zero times, and a single call a second later
//     succeeded. So this is a short burst guard, not a daily quota - but "请求频繁" is neither a bad key
//     nor a coverage gap, and a reader who saw it flattened into "not in this table" would conclude the
//     opposite of the truth. It gets its own kind for that reason. The file still does not retry: the
//     honest report of a throttle is "ask again in a moment", and a silent retry loop against a metered
//     endpoint is how a working key gets spent on nothing.
//
//   * `--journal` REFUSES AN ISSN, and it also has to UNDO an HTML escape. The library stores that same
//     journal as `Reliability Engineering &amp; System Safety` in `publicationTitle` (measured in the item
//     record ADKNW9UC), and the provider matches that string to NOTHING - so a reader who follows the
//     obvious instruction and pastes the field verbatim gets "not in this table" for a journal that is
//     there. The name is decoded before it is sent.
//
// TRANSPORT. Plain `fetch` with a timeout, like the other channel helpers: a public read-only endpoint
// has no human in the loop. One request per stage, no retry - a refusal is a finding about the channel,
// and a retry loop against a quota-metered API is how a working key gets burned.
//
// THE KEY. `EASYSCHOLAR_SECRET_KEY` first; otherwise the key the installed ZoteroStyle plugin already
// has, read from `<APPDATA>/Zotero/Zotero/Profiles/*/prefs.js`. It is never printed, never logged, and
// never accepted on the command line (a flag would land in shell history and in every pasted report).
//
// Usage:
//   node tools/journal-rank.mjs --journal "Reliability Engineering & System Safety"
//   node tools/journal-rank.mjs --doi 10.1016/j.ress.2025.112001
//   node tools/journal-rank.mjs --doi 10.1016/j.ress.2025.112001 --json
//   node tools/journal-rank.mjs --selftest
//
// Exit codes: 0 answered, including "this journal is not in the table" | 1 the channel answered with
// something that is not a record | 2 usage, or no key on this machine.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeDoi, plainText } from './metadata.mjs'
import { UsageError, reportFailure } from './refusal.mjs'

const PROVIDER_URL = 'https://www.easyscholar.cc/open/getPublicationRank'
const CROSSREF_URL = 'https://api.crossref.org'
const USER_AGENT = 'dsh-autoresearch/1.0 (journal-rank helper)'
const REQUEST_TIMEOUT_MS = 30_000
const KEY_ENV = 'EASYSCHOLAR_SECRET_KEY'
/** The registry key the ZoteroStyle plugin stores its EasyScholar key under. */
const KEY_PREF = 'extensions.zotero.zoterostyle.easyscholar.secretKey'
/** Provider fields this file interprets. Everything else is reported, never dropped silently. */
const INTERPRETED = new Set([
  'sci', 'sciif', 'sciif5', 'jci', 'sciBase', 'sciUp', 'sciUpSmall', 'sciUpTop',
  'xr', 'xrSmall', 'xrTop', 'esi', 'eii',
])
/** Institution-specific lists (`swjtu`, `swufe`, ...) are printed on one bounded line. */
const MAX_INSTITUTION_CHARS = 240

const MODES = ['journal', 'doi']

/**
 * Whether a value is an ISSN rather than a journal name.
 *
 * Exists because the provider does not refuse one: `0951-8320` answered a one-field record about
 * something else (see the header). A journal name is the only input this tool may send.
 *
 * @param {string} value A candidate journal name.
 * @returns {boolean} True when the value is (or is prefixed by) an ISSN.
 */
export function looksLikeIssn(value) {
  const bare = String(value ?? '').trim().replace(/^issn\s*[:#]?\s*/i, '')
  return /^\d{4}-?\d{3}[\dXx]$/.test(bare)
}

/**
 * A key as it may appear in a report: the first four characters, then an ellipsis.
 *
 * @param {string} key A secret key.
 * @returns {string} The mask; '' for an empty key.
 */
export function maskKey(key) {
  const text = String(key ?? '').trim()
  return text === '' ? '' : `${text.slice(0, 4)}… (${text.length} chars)`
}

/**
 * The EasyScholar key inside a Zotero profile's `prefs.js`.
 *
 * The file is a list of `user_pref("name", value);` lines, and other plugin preferences in it carry
 * escaped separators (`zoterostyle\@polygon\.org`), so this reads one exact name rather than scanning
 * for a pattern that could match a neighbouring line.
 *
 * @param {string} text The contents of `prefs.js`.
 * @returns {string} The key, or '' when this profile never configured one.
 */
export function parseSecretKey(text) {
  const escaped = KEY_PREF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`"${escaped}"\\s*,\\s*"([^"]+)"`).exec(String(text ?? ''))
  return match?.[1]?.trim() ?? ''
}

/**
 * Every key the Zotero profiles on this machine would offer.
 *
 * @param {object} io Injected for the self-test: `{ readFile, readdir, exists }`.
 * @param {string} appData The `%APPDATA%` root.
 * @returns {Array<{path: string, key: string}>} Profiles that carry a key; empty when none do.
 */
export function keysFromZoteroProfiles(appData, io) {
  const root = join(appData, 'Zotero', 'Zotero', 'Profiles')
  if (root === '' || !io.exists(root)) return []
  const found = []
  for (const name of io.readdir(root)) {
    const prefs = join(root, name, 'prefs.js')
    if (!io.exists(prefs)) continue
    const key = parseSecretKey(io.readFile(prefs))
    if (key !== '') found.push({ path: prefs, key })
  }
  return found
}

/**
 * Which key this invocation should use, and where it came from.
 *
 * @param {NodeJS.ProcessEnv} env The environment.
 * @param {object} io Injected file access, as {@link keysFromZoteroProfiles} takes.
 * @returns {{key: string, source: string}} The key and a short provenance string.
 * @throws {Error} Never: an absent key is `{key: '', source: ''}`, which the CLI turns into exit code 2.
 */
export function resolveKey(env, io) {
  const fromEnv = String(env[KEY_ENV] ?? '').trim()
  if (fromEnv !== '') return { key: fromEnv, source: `$${KEY_ENV}` }
  const profiles = keysFromZoteroProfiles(String(env.APPDATA ?? ''), io)
  if (profiles.length === 0) return { key: '', source: '' }
  return { key: profiles[0].key, source: 'the ZoteroStyle preference' }
}

/**
 * The one request this stage makes. Pure, so the self-test can read the url without a network call.
 *
 * @param {string} name An exact journal title.
 * @param {string} key The provider key.
 * @returns {string} The absolute url.
 */
export function buildRankUrl(name, key) {
  const url = new URL(PROVIDER_URL)
  url.searchParams.set('secretKey', key)
  url.searchParams.set('publicationName', String(name).trim())
  return url.toString()
}

/**
 * The Crossref url that turns a DOI into a journal title.
 *
 * @param {string} doi A bare DOI.
 * @param {string} contact A contact address, or '' to omit it.
 * @returns {string} The absolute url.
 */
export function buildCrossrefUrl(doi, contact) {
  const url = new URL(`${CROSSREF_URL}/works/${encodeURI(String(doi).trim())}`)
  if (String(contact).trim() !== '') url.searchParams.set('mailto', String(contact).trim())
  return url.toString()
}

/**
 * The journal title a Crossref work record carries.
 *
 * Crossref sends `container-title` as an ARRAY and HTML-encodes the ampersand (`Reliability Engineering
 * &amp; System Safety`, measured), so the value has to be decoded before it becomes a query: an encoded
 * title is not the title the provider matches on.
 *
 * @param {object} payload A `/works/<doi>` message.
 * @returns {string} The title, or '' when the record names no container.
 */
export function journalTitleOf(payload) {
  const container = payload?.message?.['container-title'] ?? payload?.['container-title']
  const first = Array.isArray(container) ? container[0] : container
  return plainText(first ?? '')
}

/**
 * The ISSNs a Crossref work record carries, for the identity line.
 *
 * @param {object} payload A `/works/<doi>` message.
 * @returns {string[]} The ISSNs; empty when the record carries none.
 */
export function issnsOf(payload) {
  const values = payload?.message?.ISSN ?? payload?.ISSN ?? []
  return (Array.isArray(values) ? values : [values]).map((value) => String(value ?? '').trim()).filter(Boolean)
}

/**
 * What kind of answer the provider gave, so the kinds of nothing never print alike.
 *
 * Both the success and the failure envelope arrive over HTTP 200, so the body's own `code` decides.
 *
 * @param {unknown} payload A parsed response.
 * @returns {{kind: 'answered'|'not-in-table'|'throttled'|'no-key'|'bad-key'|'refused', message: string}} The reading.
 */
export function classifyProvider(payload) {
  const code = Number(payload?.code)
  const message = String(payload?.msg ?? '')
  if (code === 200) {
    const all = payload?.data?.officialRank?.all
    if (all === null || typeof all !== 'object' || Object.keys(all).length === 0) return { kind: 'not-in-table', message }
    return { kind: 'answered', message }
  }
  if (code === 40005) return { kind: 'no-key', message: message || '密钥不能为空' }
  if (code === 40002) return { kind: 'bad-key', message: message || 'Key错误' }
  if (code === 40006) return { kind: 'throttled', message: message || '请求频繁' }
  return { kind: 'refused', message: message === '' ? `provider code ${code}` : `${message} (code ${code})` }
}

/**
 * Split the provider's flat field map into the readings a report can quote.
 *
 * Every field is optional: the payload's shape is the provider's to change, and a missing quartile has to
 * read as missing rather than as an empty string in the middle of a sentence.
 *
 * @param {unknown} all The `officialRank.all` map.
 * @returns {{jcr: object, cas: object, xinrui: object, index: object, institutions: object[], uninterpreted: string[]}}
 */
export function normalizeRanks(all) {
  const field = (name) => {
    const value = all?.[name]
    return typeof value === 'string' ? value.trim() : ''
  }
  const institutions = Object.entries(all ?? {})
    .filter(([name, value]) => !INTERPRETED.has(name) && typeof value === 'string' && value.trim() !== '')
    .map(([name, value]) => ({ name, value: String(value).trim() }))
  return {
    jcr: { quartile: field('sci'), jif: field('sciif'), jif5: field('sciif5'), jci: field('jci') },
    cas: { base: field('sciBase'), upgraded: field('sciUp'), upgradedSmall: field('sciUpSmall'), top: field('sciUpTop') },
    xinrui: { major: field('xr'), minor: field('xrSmall'), top: field('xrTop') },
    index: { esi: field('esi'), ei: field('eii') },
    institutions,
    uninterpreted: Object.keys(all ?? {}).filter((name) => !INTERPRETED.has(name)),
  }
}

/**
 * One journal's ranking, as lines a ledger row can be written from.
 *
 * @param {{asked: string, ranks: object, keySource: string, retrieved: string, doi: string, issns: string[]}} context
 * @returns {string} The block.
 */
export function formatRanks(context) {
  const { jcr, cas, xinrui, index, institutions } = context.ranks
  const or = (value) => (value === '' ? '(absent from this payload)' : value)
  const lines = [
    'mode      : provider transcription (EasyScholar getPublicationRank) - NOT a JCR export',
    `asked     : ${context.asked}`,
  ]
  if (context.doi) lines.push(`doi       : ${context.doi}   (title resolved through Crossref)`)
  if (context.issns.length > 0) lines.push(`issn      : ${context.issns.join('  ')}   (Crossref's identity for that record)`)
  lines.push(
    `match     : by exact title - the provider echoes no name, ISSN or id, so nothing here proves which journal it answered for`,
    `provider  : retrieved ${context.retrieved} · key ${context.keySource}`,
    '',
    `JCR       : ${or(jcr.quartile)}   (field "sci")${jcr.jif ? ` · JIF ${jcr.jif}` : ''}${jcr.jif5 ? ` · 5-year ${jcr.jif5}` : ''}${jcr.jci ? ` · JCI ${jcr.jci}` : ''}`,
    `CAS base  : ${or(cas.base)}   (field "sciBase", 基础版)`,
    `CAS up    : ${or(cas.upgraded)}   (field "sciUp", 升级版)${cas.upgradedSmall ? ` · 小类 ${cas.upgradedSmall}` : ''}`,
  )
  if (cas.top) lines.push(`CAS TOP   : ${cas.top}`)
  lines.push(
    `XinRui    : ${or(xinrui.major)}   (field "xr")${xinrui.minor ? ` · 小类 ${xinrui.minor}` : ''}`,
  )
  if (xinrui.top) lines.push(`XinRui TOP: ${xinrui.top}`)
  const indexed = [index.esi ? `ESI ${index.esi}` : '', index.ei].filter(Boolean).join(' · ')
  if (indexed) lines.push(`indexed   : ${indexed}`)
  if (institutions.length > 0) {
    const text = institutions.map((entry) => `${entry.name}=${entry.value}`).join(' ')
    lines.push(
      `per-institution : ${text.length > MAX_INSTITUTION_CHARS ? `${text.slice(0, MAX_INSTITUTION_CHARS)} ...` : text}`,
    )
  }
  const silent = context.ranks.uninterpreted.filter((name) => !institutions.some((entry) => entry.name === name))
  if (silent.length > 0) lines.push(`unread fields : ${silent.join(', ')}   (this helper has no reading for them yet)`)
  lines.push(
    '',
    'caveats   : the payload stamps no edition or year on any number, so "Q1" here is "this provider\'s current',
    '            JCR quartile as of the date above", not "JCR 2024". A quartile is per CATEGORY and "sci"',
    '            collapses the categories to one Q; use the 小类 lines when the category is the point.',
    '            Quote it as "provider says", never as a JCR export.',
  )
  return lines.join('\n')
}

const USAGE =
  'usage: node tools/journal-rank.mjs --journal "<exact journal title>" [--json]\n' +
  '       node tools/journal-rank.mjs --doi <doi> [--json]\n' +
  `       key: $${KEY_ENV}, else the key the installed ZoteroStyle plugin stores\n` +
  '       node tools/journal-rank.mjs --selftest'

/**
 * Read the command line, and refuse the inputs this channel cannot honour.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} The options.
 * @throws {UsageError} On a usage error; the CLI turns that into exit code 2.
 */
export function parseArgs(argv) {
  const options = { mode: '', target: '', json: false, selftest: false }
  const flag = (name) => argv.includes(`--${name}`)
  const value = (name) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? null : (argv[at + 1] ?? null)
  }

  const present = MODES.filter((mode) => flag(mode))
  if (present.length > 1) throw new UsageError(`pass one of --journal / --doi, not ${present.length}`)
  options.mode = present[0] ?? ''
  if (options.mode === '') {
    if (!flag('selftest')) throw new UsageError('pass one of --journal / --doi')
    return { ...options, selftest: true }
  }

  const raw = String(value(options.mode) ?? '').trim()
  if (raw === '') throw new UsageError(`--${options.mode} needs its value`)
  if (options.mode === 'journal' && looksLikeIssn(raw)) {
    throw new UsageError(
      `--journal takes a journal TITLE, not an ISSN: asked for an ISSN, the provider answered a record about something else (measured on 0951-8320, which returned {"swjtu":"A"}). Resolve the title with --doi, or pass the item's publicationTitle verbatim`,
    )
  }
  if (options.mode === 'journal' && raw.length < 3) throw new UsageError(`--journal takes a journal title, got '${raw}'`)
  // Decoded, not verbatim: the library's own `publicationTitle` carries `&amp;` for this very journal, and
  // the provider matches that string to nothing (measured 2026-10-21).
  options.target = options.mode === 'doi' ? normalizeDoi(raw) : plainText(raw)
  options.json = flag('json')
  return options
}

/** One request, no retry. */
async function fetchOnce(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { status: response.status, body: await response.text() }
}

/** Today, as the date a transcription has to carry. */
function today() {
  return new Date().toISOString().slice(0, 10)
}

/** The provider's error envelope, bounded to one readable line. */
function providerFinding(kind, message) {
  if (kind === 'no-key') return `the provider refused an empty key (${message}) - this machine has no EasyScholar key`
  if (kind === 'bad-key') return `the provider rejected the key (${message}) - $${KEY_ENV} or the ZoteroStyle preference holds a stale value`
  if (kind === 'throttled') return `the provider is throttling this machine (${message}) - nothing was retried and no wait was taken; run it again in a moment, and let any script pace its calls`
  return `the provider answered nothing usable: ${message}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.selftest) {
    // The checks live beside this file, mirroring it. They report through `failedChecks` instead of
    // exiting themselves, which would trip Node's unsettled-top-level-await check.
    const { failedChecks } = await import('./tests/journal-rank-selftest.mjs')
    if (failedChecks) process.exitCode = 1
    return
  }

  const key = resolveKey(process.env, {
    readFile: (path) => readFileSync(path, 'utf8'),
    readdir: (path) => readdirSync(path),
    exists: (path) => existsSync(path),
  })
  if (key.key === '') {
    throw new UsageError(
      `no EasyScholar key on this machine: set $${KEY_ENV}, or install/configure ZoteroStyle so that ${KEY_PREF} exists\n${USAGE}`,
    )
  }
  // A key from the environment is named, not masked: the reader put it there and already knows it. One
  // read from Zotero's prefs is masked, because that is a secret this report has no reason to repeat.
  const keySource = key.source === `$${KEY_ENV}` ? key.source : `${key.source} (${maskKey(key.key)})`

  let asked = options.target
  let doi = ''
  let issns = []
  if (options.mode === 'doi') {
    const response = await fetchOnce(buildCrossrefUrl(options.target, process.env.AUTORESEARCH_MAILTO ?? ''))
    if (response.status !== 200) {
      throw new Error(`Crossref answered HTTP ${response.status} for ${options.target}: ${String(response.body).replace(/\s+/g, ' ').slice(0, 200)}`)
    }
    const payload = JSON.parse(response.body)
    asked = journalTitleOf(payload)
    if (asked === '') {
      throw new Error(`Crossref's record for ${options.target} names no container-title, so there is no journal to ask about (type: ${payload?.message?.type ?? 'unknown'})`)
    }
    doi = options.target
    issns = issnsOf(payload)
  }

  const response = await fetchOnce(buildRankUrl(asked, key.key))
  if (response.status !== 200) {
    throw new Error(`the provider answered HTTP ${response.status}: ${String(response.body).replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  let payload = null
  try {
    payload = JSON.parse(response.body)
  } catch {
    throw new Error(`the provider answered HTTP 200 with a body that is not JSON: ${String(response.body).replace(/\s+/g, ' ').slice(0, 200)}`)
  }

  const finding = classifyProvider(payload)
  if (finding.kind === 'no-key' || finding.kind === 'bad-key') {
    console.error(providerFinding(finding.kind, finding.message))
    process.exitCode = 2
    return
  }
  if (finding.kind === 'throttled' || finding.kind === 'refused') {
    console.error(providerFinding(finding.kind, finding.message))
    process.exitCode = 1
    return
  }
  if (finding.kind === 'not-in-table') {
    const lines = [
      'mode      : provider transcription (EasyScholar getPublicationRank) - NOT a JCR export',
      `asked     : ${asked}`,
    ]
    if (doi !== '') lines.push(`doi       : ${doi}   (title resolved through Crossref)`)
    if (issns.length > 0) lines.push(`issn      : ${issns.join('  ')}   (Crossref's identity for that record)`)
    lines.push(
      `provider  : retrieved ${today()} · key ${keySource}`,
      '',
      'NOT IN THIS PROVIDER TABLE - the exact title matched nothing. This is a coverage fact about the',
      'provider, not "the journal is not Q1", and not "the journal is unranked". A near-miss name answers',
      'the same way (measured on a truncated title), so check the spelling before drawing a conclusion.',
    )
    console.log(lines.join('\n'))
    return
  }

  const ranks = normalizeRanks(payload?.data?.officialRank?.all)
  const context = { asked, ranks, doi, issns, retrieved: today(), keySource }
  console.log(options.json ? JSON.stringify({ mode: 'journal-rank', provider: 'easyscholar', ...context }, null, 2) : formatRanks(context))
}

// Only act when this file IS the command: the self-test imports the pure functions above, and an
// import must not make a network request.
const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

// NOT `await main()`: this module is the entry point AND it dynamically imports its own self-test,
// which statically imports this file back. A pending top-level await here would make that cycle wait
// on itself and the self-test body would never run.
if (isEntryPoint) {
  main().catch((error) => {
    // `process.exitCode`, not `process.exit()`: measured on this machine, exiting while a piped stderr
    // write is still pending makes libuv assert (`!(handle->flags & UV_HANDLE_CLOSING)`, async.c:76) and
    // the process dies with 0xC0000409 instead of the code that was asked for. Setting the code lets
    // Node flush and leave on its own.
    process.exitCode = reportFailure(error)  })
}
