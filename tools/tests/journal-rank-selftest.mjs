// Unit self-test for the journal-rank helper, runnable without the network or a key.
//
// Usage: node tools/tests/journal-rank-selftest.mjs      (or: node tools/journal-rank.mjs --selftest)
//
// Every fixture below is a REAL response captured on 2026-10-21, trimmed only where marked. The four
// that matter most are the ones a plausible implementation gets wrong:
//
//   * the RESS payload, where `select` OMITS `xr`, `xrSmall`, `xrTop` and `sciUpSmall` while `all`
//     carries them - so a reader that prints `select` reports a thinner journal than the provider knows;
//   * the ISSN answer, `{"swjtu":"A"}`, which is why `--journal` refuses an ISSN instead of sending one;
//   * the `all: null` answer, which is what a truncated or singular journal name also returned - a
//     coverage fact that must never read as "not Q1";
//   * the two key codes, both over HTTP 200, which are configuration findings rather than failures.
//
// The key in these fixtures is synthetic. No real key belongs in a committed file.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCrossrefUrl,
  buildRankUrl,
  classifyProvider,
  formatRanks,
  issnsOf,
  journalTitleOf,
  keysFromZoteroProfiles,
  looksLikeIssn,
  maskKey,
  normalizeRanks,
  parseArgs,
  parseSecretKey,
  resolveKey,
} from '../journal-rank.mjs'

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

console.log('journal-rank self-test')

// --- fixtures: captured 2026-10-21, verbatim -------------------------------------------------------

/** `getPublicationRank?publicationName=Reliability Engineering & System Safety` (727 characters). */
const MEASURED_RESS = {
  code: 200,
  msg: 'SUCCESS',
  data: {
    customRank: { rankInfo: [], rank: [] },
    officialRank: {
      all: {
        swufe: 'A2',
        uibe: 'C',
        sdufe: 'A2',
        swjtu: 'A++',
        hhu: 'A类',
        xju: '一区',
        cug: '管理科学T2',
        sciif: '13.7',
        sci: 'Q1',
        sciBase: '工程技术2区',
        sciUp: '工程技术1区',
        sciUpSmall: '工程：工业1区/运筹学与管理科学1区。',
        eii: 'EI',
        ajg: '3',
        scu: '工程技术B',
        sciif5: '11.6',
        fms: 'B',
        jci: '2.19',
        esi: '工程科学',
        sciUpTop: '工程技术TOP',
        xr: '工程技术1区',
        xrSmall: '工程：工业1区; 运筹学与管理科学1区',
        xrTop: '工程技术TOP',
      },
      // The account's display set: four fields SHORT of `all`, which is the trap this fixture proves.
      select: {
        swufe: 'A2',
        uibe: 'C',
        sdufe: 'A2',
        swjtu: 'A++',
        hhu: 'A类',
        xju: '一区',
        cug: '管理科学T2',
        sciif: '13.7',
        sci: 'Q1',
        sciBase: '工程技术2区',
        sciUp: '工程技术1区',
        eii: 'EI',
        ajg: '3',
        scu: '工程技术B',
        sciif5: '11.6',
        fms: 'B',
        jci: '2.19',
        esi: '工程科学',
        sciUpTop: '工程技术TOP',
      },
    },
  },
}

/** What a truncated name (`Reliability Engineering`) and a singular one both answered. */
const MEASURED_NOT_IN_TABLE = {
  code: 200,
  msg: 'SUCCESS',
  data: { customRank: { rankInfo: [], rank: [] }, officialRank: { all: null, select: null } },
}

/** What the provider answered for an ISSN - a non-empty record about something else. */
const MEASURED_ISSN_ANSWER = {
  code: 200,
  msg: 'SUCCESS',
  data: { customRank: { rankInfo: [], rank: [] }, officialRank: { all: { swjtu: 'A' }, select: { swjtu: 'A' } } },
}

const MEASURED_EMPTY_KEY = { code: 40005, msg: '密钥不能为空', data: null }
const MEASURED_BAD_KEY = { code: 40002, msg: 'Key错误', data: null }
/** The 45-character body a burst got back, over HTTP 200 - easy to mistake for an empty table. */
const MEASURED_THROTTLED = { code: 40006, msg: '请求频繁，请稍后再试', data: null }

const SYNTHETIC_KEY = '0123456789abcdef0123456789abcdef'

/** One profile's prefs.js, with the neighbouring plugin lines that a loose regex would trip over. */
const PREFS_TEXT = [
  'user_pref("extensions.webextensions.uuids", "{\\"zoterostyle@polygon.org\\":\\"3819291d\\"}");',
  `user_pref("extensions.zotero.zoterostyle.easyscholar.secretKey", "${SYNTHETIC_KEY}");`,
  'user_pref("extensions.zotero.zoterostyle.publicationTagsColumn.map", "SCIIF=IF, SCI=, SCI升级版=, EI检索=EI");',
].join('\n')

// --- the identifier refusals -----------------------------------------------------------------------

check(looksLikeIssn('0951-8320') === true, 'an ISSN is recognised', '0951-8320')
check(looksLikeIssn('09518320') === true, 'a hyphenless ISSN is recognised', '09518320')
check(looksLikeIssn('ISSN 0951-8320') === true, 'a prefixed ISSN is recognised', 'ISSN 0951-8320')
check(looksLikeIssn('rel.x') === false, 'a short name is a name', 'rel.x')
throws('--journal refuses an ISSN', () => parseArgs(['--journal', '0951-8320']))
throws('--journal refuses a prefixed ISSN', () => parseArgs(['--journal', 'ISSN:0951-8320']))
throws('--journal refuses a two-character title', () => parseArgs(['--journal', 'ab']))
throws('no mode is a usage error', () => parseArgs([]))
throws('two modes are a usage error', () => parseArgs(['--journal', 'A', '--doi', '10.1/x']))
throws('an empty value is a usage error', () => parseArgs(['--journal', '']))

check(parseArgs(['--journal', 'Information Fusion']).target === 'Information Fusion', 'the exact title is kept verbatim')
check(
  parseArgs(['--journal', 'Reliability Engineering &amp; System Safety']).target === 'Reliability Engineering & System Safety',
  'an HTML-escaped title is decoded before it would be sent',
  parseArgs(['--journal', 'Reliability Engineering &amp; System Safety']).target,
)
check(
  parseArgs(['--doi', 'https://doi.org/10.1016/j.ress.2025.112001']).target === '10.1016/j.ress.2025.112001',
  'a resolver url is reduced to a bare DOI',
)
check(parseArgs(['--journal', 'Information Fusion', '--json']).json === true, '--json is read')
check(parseArgs(['--selftest']).selftest === true, '--selftest is read')
check(parseArgs(['--journal', 'Information Fusion']).mode === 'journal', 'the mode is named')

// --- the key: environment first, then the plugin's preference --------------------------------------

check(parseSecretKey(PREFS_TEXT) === SYNTHETIC_KEY, 'the key is read from the exact preference name')
check(parseSecretKey('user_pref("other.key", "x");') === '', 'a neighbouring preference is not the key')
check(parseSecretKey('') === '', 'an empty prefs file yields no key')
check(maskKey(SYNTHETIC_KEY).startsWith('0123'), 'the mask keeps four characters', maskKey(SYNTHETIC_KEY))
check(!maskKey(SYNTHETIC_KEY).includes(SYNTHETIC_KEY.slice(4)), 'the mask holds back the rest of the key')

const fakeIo = (files) => {
  const paths = Object.keys(files)
  const directories = new Set()
  for (const path of paths) {
    let parent = path
    for (;;) {
      const cut = parent.replace(/[\\/][^\\/]+$/, '')
      if (cut === parent) break
      directories.add(cut)
      parent = cut
    }
  }
  return {
    exists: (path) => paths.includes(path) || directories.has(path),
    readFile: (path) => files[path],
    readdir: (path) => {
      const prefix = path.endsWith('\\') ? path : `${path}\\`
      const names = new Set()
      for (const file of paths) {
        if (!file.startsWith(prefix)) continue
        const [name] = file.slice(prefix.length).split('\\')
        if (name) names.add(name)
      }
      return [...names]
    },
  }
}
const profilePath = 'C:\\APPDATA\\Zotero\\Zotero\\Profiles\\0si2pcsr.default\\prefs.js'
check(keysFromZoteroProfiles('C:\\APPDATA', fakeIo({ [profilePath]: PREFS_TEXT })).length === 1, 'one profile offering a key is found')
check(keysFromZoteroProfiles('C:\\APPDATA', fakeIo({})).length === 0, 'a machine without the plugin has no key')

check(
  resolveKey({ EASYSCHOLAR_SECRET_KEY: 'from-env' }, fakeIo({})).source === '$EASYSCHOLAR_SECRET_KEY',
  'the environment wins over the preference',
)
check(
  resolveKey({ APPDATA: 'C:\\APPDATA' }, fakeIo({ [profilePath]: PREFS_TEXT })).key === SYNTHETIC_KEY,
  'the preference is the fallback',
)
check(resolveKey({}, fakeIo({})).key === '', 'no key anywhere reports empty rather than throwing')

// --- the urls --------------------------------------------------------------------------------------

const rankUrl = new URL(buildRankUrl('Reliability Engineering & System Safety', SYNTHETIC_KEY))
check(rankUrl.origin + rankUrl.pathname === 'https://www.easyscholar.cc/open/getPublicationRank', 'the provider path')
check(rankUrl.searchParams.get('publicationName') === 'Reliability Engineering & System Safety', 'the title survives encoding')
check(rankUrl.searchParams.get('secretKey') === SYNTHETIC_KEY, 'the key rides in a parameter')
check(buildRankUrl('  Information Fusion  ', 'k').includes('publicationName=Information+Fusion'), 'the title is trimmed')

check(!buildCrossrefUrl('10.1016/j.ress.2025.112001', '').includes('mailto'), 'no contact address, no parameter')
check(buildCrossrefUrl('10.1016/j.ress.2025.112001', 'a@b.c').includes('mailto=a%40b.c'), 'the contact address is encoded')

const CROSSREF_RECORD = {
  message: {
    'container-title': ['Reliability Engineering &amp; System Safety'],
    ISSN: ['0951-8320'],
    type: 'journal-article',
  },
}
check(journalTitleOf(CROSSREF_RECORD) === 'Reliability Engineering & System Safety', 'the encoded ampersand is decoded', journalTitleOf(CROSSREF_RECORD))
check(journalTitleOf({ message: { 'container-title': 'Information Fusion' } }) === 'Information Fusion', 'a string container-title is read')
check(journalTitleOf({ message: {} }) === '', 'a record with no container names no journal')
check(issnsOf(CROSSREF_RECORD).join() === '0951-8320', 'the ISSN is carried for the identity line')

// --- the kinds of answer ---------------------------------------------------------------------------

check(classifyProvider(MEASURED_RESS).kind === 'answered', 'a record is an answer')
check(classifyProvider(MEASURED_NOT_IN_TABLE).kind === 'not-in-table', 'a null table is a coverage fact, not a failure')
check(classifyProvider({ ...MEASURED_NOT_IN_TABLE, data: { officialRank: { all: {} } } }).kind === 'not-in-table', 'an empty table is the same fact')
check(classifyProvider(MEASURED_EMPTY_KEY).kind === 'no-key', 'code 40005 is a missing key')
check(classifyProvider(MEASURED_BAD_KEY).kind === 'bad-key', 'code 40002 is a rejected key')
check(classifyProvider(MEASURED_THROTTLED).kind === 'throttled', 'code 40006 is a throttle, not a missing journal')
check(classifyProvider(MEASURED_THROTTLED).message.includes('请求频繁'), 'the throttle keeps the provider wording', classifyProvider(MEASURED_THROTTLED).message)
check(classifyProvider({ code: 49999, msg: '频率限制' }).kind === 'refused', 'an unlisted code is a refusal, not a guess')
check(classifyProvider({ code: 200, msg: 'SUCCESS' }).kind === 'not-in-table', 'a 200 with no data is not an answer')

// --- the reading ------------------------------------------------------------------------------------

const ranks = normalizeRanks(MEASURED_RESS.data.officialRank.all)
check(ranks.jcr.quartile === 'Q1', 'the quartile', ranks.jcr.quartile)
check(ranks.jcr.jif === '13.7' && ranks.jcr.jif5 === '11.6', 'both impact factors')
check(ranks.jcr.jci === '2.19', 'the JCI')
check(ranks.cas.base === '工程技术2区', 'the basic CAS partition', ranks.cas.base)
check(ranks.cas.upgraded === '工程技术1区', 'the upgraded CAS partition', ranks.cas.upgraded)
check(ranks.cas.upgradedSmall.includes('工程：工业1区'), 'the CAS minor categories', ranks.cas.upgradedSmall)
check(ranks.cas.top === '工程技术TOP', 'the CAS Top flag')
check(ranks.xinrui.major === '工程技术1区', 'the XinRui partition', ranks.xinrui.major)
check(ranks.xinrui.minor.includes('运筹学与管理科学1区'), 'the XinRui minor categories', ranks.xinrui.minor)
check(ranks.index.esi === '工程科学' && ranks.index.ei === 'EI', 'the index memberships')
check(ranks.institutions.length === 10, 'the institution lists are kept, not dropped', String(ranks.institutions.length))

const block = formatRanks({
  asked: 'Reliability Engineering & System Safety',
  ranks,
  doi: '10.1016/j.ress.2025.112001',
  issns: ['0951-8320'],
  retrieved: '2026-10-21',
  keySource: 'the ZoteroStyle preference (0123… (32 chars))',
})
check(block.includes('NOT a JCR export'), 'the block says what it is not')
check(block.includes('Q1'), 'the quartile is printed')
check(block.includes('工程：工业1区'), 'the per-category detail is printed')
check(block.includes('XinRui'), 'the XinRui reading survives a `select` that omitted it')
check(block.includes('the provider echoes no name'), 'the block admits the match cannot be shown')
check(block.includes('no edition or year'), 'the block refuses to imply an edition')
check(!block.includes(SYNTHETIC_KEY), 'the key never reaches the report')
check(block.includes('retrieved 2026-10-21'), 'the retrieval date is stamped')

const empty = normalizeRanks({})
const emptyBlock = formatRanks({ asked: 'A Journal With No Fields', ranks: empty, doi: '', issns: [], retrieved: '2026-10-21', keySource: '$EASYSCHOLAR_SECRET_KEY' })
check(emptyBlock.includes('(absent from this payload)'), 'a missing quartile reads as missing')
check(emptyBlock.includes('JCR       : (absent from this payload)'), 'and it is the JCR line that says it')

// The ISSN answer would have been classified as a record, which is exactly why the input is refused
// before any request: this is the shape the refusal prevents from ever being printed.
check(
  classifyProvider(MEASURED_ISSN_ANSWER).kind === 'answered' && normalizeRanks(MEASURED_ISSN_ANSWER.data.officialRank.all).jcr.quartile === '',
  'the ISSN answer carries no quartile even though it is "an answer"',
)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)

/** Whether any check failed, for a caller that imported this file rather than ran it. */
export const failedChecks = failures > 0

// Exit only when this file IS the command. `--selftest` imports it instead, and exiting while that
// import is still pending (or while a piped write is in flight) trips Node's own checks.
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) process.exitCode = failures === 0 ? 0 : 1
