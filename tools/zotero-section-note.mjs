#!/usr/bin/env node
// Leave ONE explanation note per top-level method section on a record.
//
// IDENTITY IS A TAG, NOT A COMMENT
//
// This tool used to open every note with an invisible HTML comment naming its section. Measured on
// this library: when the Zotero application rewrites a note's body it keeps the content and drops the
// comment, so 153 of 378 live notes had lost their identity. A TAG is item metadata, outside the
// body: the application's note editor does not touch it, and `/retired` was measured to survive a real
// application rewrite. Identity therefore travels in `/section-<N>`:
//
//   /section-3       this note claims TOP-LEVEL section 3
//   /imported        this claim came from an imported/pasted note, so it may still be rewritten
//   /agent-note      an agent wrote this body from the paper; until /reviewed it is candidate-grade
//   /reviewed        the owner read and accepted an /agent-note body: it is a record again
//   /repaired        the body was corrected in place; a substantive repair drops /reviewed
//   /digest          LEGACY: an earlier version's whole-paper summary; never a section note, never written now
//   /retired         out of service: not coverage, and the only note a delete may target
//   /replaces-<key>  this note replaced a retired note
//
// AUTHORSHIP IS NOT THE OWNER'S. A body an agent drafted from the paper is still the owner's note, but a
// later round must be able to tell it from one the owner wrote: `/agent-note` says who wrote the prose,
// and `/reviewed` says the owner accepted it. An unreviewed agent body is a DRAFT: it may be rewritten
// in place and it supports nothing stronger than a candidate. Reviewing it does not rewrite a byte - it
// is a tag, like every other identity in this tool.
//
// No dotted tag is written or read. A subsection-keyed note from an earlier round is `unknown` here
// and is merged into its top-level section or retired by a later round; nothing is folded silently.
//
// AN AMBIGUOUS NOTE IS RESOLVED BY REMOVING ONE TAG, NEVER BY GUESSING
//
// A note carrying two `/section-N` tags claims nothing: `readSectionTag` reports it as ambiguous and
// every write on that record is refused until one tag is gone. `--unclaim` removes exactly one, one
// tag per command, and refuses a note carrying a single tag - a single claim is not a tag mistake, and
// a reading that disagrees with it stops the round for the owner (protocol Revision 35).
//
// NO PROSE PARSING
//
// A note with no `/section-` tag is UNKNOWN: this tool does not guess from its first paragraph. The
// plan prints every note's first paragraph and names the unknown ones, and the discipline reads those
// before writing. The judgement is the reader's; this tool only refuses what an explicit tag says is
// already claimed. That is why the wide regex and the marker are both gone.
//
// NO AUTOMATIC REPAIR, BUT A REPAIR THE AGENT MAKES
//
// `--tidy` is deleted with its math-delimiter rules. Writing a note is the agent's work, and a tool
// that rewrote a formula because it looked like LaTeX was making a content decision while claiming to
// format one. `--repair` is the agent's own correction, printed before it is sent: it keeps the note's
// key, its claim and its provenance, adds `/repaired`, and refuses `--mechanical` where the change
// carries a digit or falls inside math. A record the owner wrote is repaired mechanically only; a
// changed claim is still a retirement and a replacement, and an import or a draft is rewritten.
//
// Usage:
//   node tools/zotero-section-note.mjs --item <recordKey>                              # coverage plan
//   node tools/zotero-section-note.mjs --item <recordKey> --section 2 --file n2.html    # dry run
//   node tools/zotero-section-note.mjs --item <recordKey> --section 2 --file n2.html --write
//   node tools/zotero-section-note.mjs --claim --note <noteKey> --section 2             # dry run
//   node tools/zotero-section-note.mjs --claim --note <noteKey> --section 2 --write
//   node tools/zotero-section-note.mjs --unclaim --note <noteKey> --section 3             # dry run
//   node tools/zotero-section-note.mjs --unclaim --note <noteKey> --section 3 --write
//   node tools/zotero-section-note.mjs --rewrite --note <noteKey> --file n2.html        # dry run
//   node tools/zotero-section-note.mjs --rewrite --note <noteKey> --file n2.html --write
//   node tools/zotero-section-note.mjs --repair --note <noteKey> --file n2.html --reason "why" --mechanical   # dry run
//   node tools/zotero-section-note.mjs --repair --note <noteKey> --file n2.html --reason "why" --substantive --write
//   node tools/zotero-section-note.mjs --retire --note <noteKey> --reason "<why>"        # dry run
//   node tools/zotero-section-note.mjs --retire --note <noteKey> --undo --write
//   node tools/zotero-section-note.mjs --delete --note <noteKey>                        # dry run
//   node tools/zotero-section-note.mjs --delete --note <noteKey> --write
//
// DELETION IS PERMANENT, AND ONLY A /retired NOTE IS A CANDIDATE
//
// This channel cannot put an item in the trash: a DELETE erases the note, the key answers 404
// afterwards, and the trash count does not move. The plan states that before the act, and `--write`
// is the owner's second answer. The request carries the version the plan was read at (the API answers
// 428 without that precondition), and a version that moved is refused rather than overwritten.
//
// Exit codes: 0 applied and read back, or nothing to do | 1 refused, and nothing was written |
// 2 usage | 3 sent or written but NOT confirmed - the note may exist, so never resend it.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError, reportFailure, reportHelp, wantsHelp } from './refusal.mjs'
import { APP_NAME, childrenOf, createdItemKey, createWriteGate, isWriteAccepted, localRequest, patchItem, readItem, visibleText } from './zotero-local-api.mjs'

/** The tag prefix that records which top-level section a note explains. */
export const SECTION_TAG_PREFIX = '/section-'

/** The tag that marks a claimed note as an import, which may still be rewritten in place. */
export const IMPORTED_TAG = '/imported'

/** The tag an earlier version used for a paper-level summary note. Nothing writes it now. */
export const DIGEST_TAG = '/digest'

/** The tag that takes a note out of service. */
export const RETIRE_TAG = '/retired'

/** The tag that names the retired note a successor replaced. */
export const REPLACES_TAG_PREFIX = '/replaces-'

/** The tag that records a note body an agent wrote from the paper. */
export const AGENT_TAG = '/agent-note'

/** The bare form an earlier round wrote; read as the same mark, never written. */
export const LEGACY_AGENT_TAG = 'agent-note'

/** The tag the owner adds when they accept an agent-written body. */
export const REVIEWED_TAG = '/reviewed'

/** The tag a body corrected in place carries, so a reader can tell it from the one first written. */
export const REPAIRED_TAG = '/repaired'

/**
 * Whether this invocation has sent a write.
 *
 * Exit 1 means "nothing was written"; once a request may have left, that sentence is not available
 * any more. The catch at the bottom of this file reads this flag and answers exit 3 instead, which is
 * the third answer a write CLI needs: the library may hold it.
 */
let writeAttempted = false

const CHINESE_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** A tag as it is compared: trimmed and lower-cased, because a tag is free text a person can edit. */
function lowered(tag) {
  return String(tag ?? '').trim().toLowerCase()
}

/**
 * A section ordinal as a comparable token, so "第三节" and "第3节" cannot both be written for one
 * section.
 *
 * @param {string|number} value The ordinal, in digits or Chinese numerals.
 * @returns {string} The ordinal as digits, or '' when there is no ordinal in the value.
 */
export function normalizeSectionToken(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/^文?章?第/, '')
    .replace(/节$/, '')
    .trim()
  if (/^\d+(\.\d+)*$/.test(text)) return text
  const digits = /^(\d+)$/.exec(text)
  if (digits) return digits[1]
  const chinese = /^([一二三四五六七八九十]+)$/.exec(text)
  if (chinese) {
    const parts = chinese[1].split('')
    if (parts.length === 1) return String(CHINESE_DIGITS[parts[0]] ?? '')
    const tens = parts[0] === '十' ? 1 : (CHINESE_DIGITS[parts[0]] ?? 0)
    const ones = parts[parts.length - 1] === '十' ? 0 : (CHINESE_DIGITS[parts[parts.length - 1]] ?? 0)
    return String(tens * 10 + ones)
  }
  return ''
}

/**
 * A Roman numeral's value.
 *
 * The section-note write path no longer parses prose, but `zotero-pdf.mjs` reads the paper's own
 * table of contents, where `III. PROPOSED ...` is a real heading. This stays exported for that one
 * caller rather than duplicating a numeral parser.
 *
 * @param {string} text A Roman numeral.
 * @returns {number} Its value, or 0 when the text is not a well-formed numeral.
 */
export function romanToNumber(text) {
  const numeral = String(text ?? '').toUpperCase()
  if (numeral === '' || !/^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(numeral)) return 0
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
  let total = 0
  for (let index = 0; index < numeral.length; index += 1) {
    const current = values[numeral[index]]
    const next = values[numeral[index + 1]] ?? 0
    total += current < next ? -current : current
  }
  return total
}

/**
 * The tag that records a top-level section claim.
 *
 * @param {string} token A normalized top-level ordinal.
 * @returns {string} The tag.
 */
export function sectionTag(token) {
  return `${SECTION_TAG_PREFIX}${token}`
}

/**
 * The ordinal a `/section-` tag carries, or '' when the tag is not a top-level claim.
 *
 * @param {string} tag One tag.
 * @returns {string} The ordinal, in digits.
 */
export function sectionTokenFromTag(tag) {
  const text = String(tag ?? '').trim()
  if (!lowered(text).startsWith(SECTION_TAG_PREFIX)) return ''
  const token = text.slice(SECTION_TAG_PREFIX.length)
  return /^\d+$/.test(token) ? token : ''
}

/**
 * What a note's tags claim, with the ambiguity made explicit.
 *
 * Two `/section-` tags on one note are not a claim this tool can count: the plan names the note and
 * the discipline fixes it. A dotted or empty tag is invalid and lands in `invalid`; it never becomes
 * a top-level claim.
 *
 * @param {string[]} tags The note's tags, bare text.
 * @returns {{token: string, ambiguous: boolean, tags: string[], invalid: string[]}} The claim.
 */
export function readSectionTag(tags) {
  const hits = (tags ?? [])
    .map((tag) => String(tag).trim())
    .filter((tag) => lowered(tag).startsWith(SECTION_TAG_PREFIX))
  const tokens = [...new Set(hits.map(sectionTokenFromTag).filter(Boolean))]
  const invalid = hits.filter((tag) => sectionTokenFromTag(tag) === '')
  if (tokens.length > 1) return { token: '', ambiguous: true, tags: hits, invalid }
  return { token: tokens[0] ?? '', ambiguous: false, tags: hits, invalid }
}

/**
 * Whether a note's tags retire it.
 *
 * Compared case-insensitively because a tag is free text a person can also edit by hand, and a
 * retirement that silently stops counting because someone typed `/Retired` is the failure this whole
 * mechanism exists to avoid.
 *
 * @param {string[]} tags The note's tags, bare text.
 * @returns {boolean} True when the note is a tombstone rather than coverage.
 */
export function isRetired(tags) {
  return (tags ?? []).some((tag) => lowered(tag) === RETIRE_TAG)
}

/**
 * Whether a note came from outside and may still be rewritten in place.
 *
 * @param {string[]} tags The note's tags, bare text.
 * @returns {boolean} True when the note carries `/imported`.
 */
export function isImported(tags) {
  return (tags ?? []).some((tag) => lowered(tag) === IMPORTED_TAG)
}

/**
 * Whether a note is a legacy whole-paper summary rather than a section note.
 *
 * An earlier version of this preset wrote one `/digest` note per record. That artifact is gone, but a
 * library may still carry one: recognizing the tag keeps it out of coverage and refuses to claim it,
 * while nothing here writes the tag or refreshes the note.
 *
 * @param {string[]} tags The note's tags, bare text.
 * @returns {boolean} True when the note carries `/digest`.
 */
export function isDigest(tags) {
  return (tags ?? []).some((tag) => lowered(tag) === DIGEST_TAG)
}

/**
 * Whether an agent wrote this note's body from the paper.
 *
 * The bare `agent-note` form is accepted because one round wrote it before this vocabulary existed;
 * accepting it costs nothing and re-tagging the owner's library to satisfy a spelling would not.
 *
 * @param {string[]} tags The note's tags, bare text.
 * @returns {boolean} True when the note carries `/agent-note` (or its legacy bare form).
 */
export function isAgentNote(tags) {
  return (tags ?? []).some((tag) => {
    const text = lowered(tag)
    return text === AGENT_TAG || text === LEGACY_AGENT_TAG
  })
}

/**
 * Whether the owner has accepted this note's agent-written body.
 *
 * @param {string[]} tags The note's tags, bare text.
 * @returns {boolean} True when the note carries `/reviewed`.
 */
export function isReviewed(tags) {
  return (tags ?? []).some((tag) => lowered(tag) === REVIEWED_TAG)
}

/**
 * Who wrote the prose, as one word a plan can print.
 *
 * @param {string[]} tags The note's tags, bare text.
 * @returns {'agent+reviewed'|'agent'|'import'|'owner'} The provenance.
 */
export function provenanceOf(tags) {
  if (isAgentNote(tags)) return isReviewed(tags) ? 'agent+reviewed' : 'agent'
  return isImported(tags) ? 'import' : 'owner'
}

/**
 * What a ruling may treat this note as: a record, or only a candidate.
 *
 * A retired note, a legacy summary, and a note claiming no section carry no authority. An agent body
 * the owner has not reviewed is a draft: it explains the section, and it is not evidence a ledger may
 * rest an adoption on (`adoption-ruling`).
 *
 * @param {string[]} tags The note's tags, bare text.
 * @param {string} token The top-level section it claims, or ''.
 * @returns {'record'|'candidate'|'none'} The authority.
 */
export function authorityOf(tags, token) {
  if (!token || isRetired(tags) || isDigest(tags)) return 'none'
  return isAgentNote(tags) && !isReviewed(tags) ? 'candidate' : 'record'
}

/**
 * The writes this record permits on one note, as words a plan can print.
 *
 * The class a note belongs to is mechanical — four combinations of `/imported`, `/agent-note` and
 * `/reviewed` — and deriving it from tags is the step a reader most easily gets wrong. The plan states
 * it instead, so the discipline keeps only what this tool cannot know: which of these moves the round
 * is authorized to take (a claim round may claim, unclaim or leave; a write needs the owner's answer).
 *
 * @param {{tags: string[], token?: string, retired?: boolean, digest?: boolean, ambiguous?: boolean}} state
 *   The note's tags, and the shape `noteChildren` reports for it.
 * @returns {string[]} Move words, in the order a round would consider them.
 */
export function allowedMoves({ tags, token = '', retired = false, digest = false, ambiguous = false }) {
  if (digest) return ['leave']
  if (retired) return ['unretire', 'delete']
  if (ambiguous) return ['unclaim']
  if (!token) return ['claim', 'retire']
  const provenance = provenanceOf(tags)
  if (provenance === 'owner') return ['repair(mechanical)', 'retire']
  if (provenance === 'agent') return ['rewrite', 'retire', 'review(owner)']
  if (provenance === 'agent+reviewed') return ['repair(mechanical|substantive)', 'retire']
  return ['rewrite', 'retire']
}

/**
 * The tag list a review leaves behind: every existing tag, plus or minus `/reviewed`.
 *
 * Idempotent in both directions, and it never drops a tag it did not put there.
 *
 * @param {string[]} tags The note's current tags.
 * @param {{undo?: boolean}} [options] `undo` removes the mark instead of adding it.
 * @returns {string[]} The tags to send.
 */
export function reviewTags(tags, { undo = false } = {}) {
  const kept = (tags ?? []).filter((tag) => !isReviewed([tag]))
  return undo ? kept : [...kept, REVIEWED_TAG]
}

/**
 * Whether a body was corrected in place.
 *
 * @param {string[]} tags The note's tags, bare text.
 * @returns {boolean} True when the note carries {@link REPAIRED_TAG}.
 */
export function isRepaired(tags) {
  return (tags ?? []).some((tag) => lowered(tag) === REPAIRED_TAG)
}

/**
 * The tag list a repair leaves behind.
 *
 * A repair never adds a provenance mark: the note keeps whatever says who wrote it. It adds
 * {@link REPAIRED_TAG} once, and a substantive repair drops {@link REVIEWED_TAG} because the owner
 * accepted prose that is no longer there.
 *
 * @param {string[]} tags The note's current tags.
 * @param {{substantive?: boolean}} [options] `substantive` clears the owner acceptance.
 * @returns {string[]} The tags to send.
 */
export function repairTags(tags, { substantive = false } = {}) {
  const kept = (tags ?? []).filter((tag) => !(substantive && isReviewed([tag])))
  return isRepaired(kept) ? kept : [...kept, REPAIRED_TAG]
}

/**
 * The smallest span that differs between two bodies.
 *
 * Compared on visible text, because the application rewrites the HTML around a body it has edited
 * and a byte diff would report every note as changed.
 *
 * @param {string} before The body the note carries now.
 * @param {string} after The body the repair would write.
 * @returns {{start: number, before: string, after: string, length: number}} The changed span.
 */
export function changedSpan(before, after) {
  const left = String(before ?? '')
  const right = String(after ?? '')
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1
  let endLeft = left.length
  let endRight = right.length
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1
    endRight -= 1
  }
  return {
    start,
    before: left.slice(start, endLeft),
    after: right.slice(start, endRight),
    length: Math.max(endLeft - start, endRight - start),
  }
}

/** The `[from, to)` ranges a body uses for inline and display math. */
function mathRanges(text) {
  const ranges = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== '$') {
      index += 1
      continue
    }
    const double = text[index + 1] === '$'
    const close = text.indexOf(double ? '$$' : '$', index + (double ? 2 : 1))
    if (close === -1) break
    const end = close + (double ? 2 : 1)
    ranges.push([index, end])
    index = end
  }
  return ranges
}

/**
 * Whether a correction changes a symbol, a number or an equation.
 *
 * This is a floor, not a ceiling: it catches a changed digit, a change inside `$…$`, and a rewrite
 * of more than half the body. A symbol replaced in prose outside math is invisible here, so the
 * caller states the class it intends; this function only refuses `mechanical` where it can prove
 * otherwise.
 *
 * @param {string} before The body the note carries now.
 * @param {string} after The body the repair would write.
 * @returns {{substantive: boolean, why: string}} The class, with the reason a plan can print.
 */
export function changeClass(before, after) {
  const span = changedSpan(before, after)
  const changed = span.before + span.after
  if (/[0-9]/.test(changed)) return { substantive: true, why: 'the changed text carries a digit' }
  const endLeft = span.start + span.before.length
  const endRight = span.start + span.after.length
  const inMath = (text, from, to) => mathRanges(text).some(([start, end]) => start < to && from < end)
  const left = String(before ?? '')
  const right = String(after ?? '')
  if (inMath(left, span.start, endLeft) || inMath(right, span.start, endRight)) {
    return { substantive: true, why: 'the change falls inside a math segment' }
  }
  if (span.length > 400 && span.length * 2 > Math.max(left.length, right.length)) {
    return { substantive: true, why: 'the change rewrites more than half of the body' }
  }
  return { substantive: false, why: 'a local correction outside math, carrying no digit' }
}

/**
 * The tag list a retirement leaves behind: every tag the note already had, plus or minus the mark.
 *
 * Idempotent in both directions, and it never drops a tag it did not put there - the owner's own tags
 * on their own note are not this tool's to tidy.
 *
 * @param {string[]} tags The note's current tags.
 * @param {{undo?: boolean}} [options] `undo` removes the mark instead of adding it.
 * @returns {string[]} The tags to send.
 */
export function retireTags(tags, { undo = false } = {}) {
  const kept = (tags ?? []).filter((tag) => !isRetired([tag]))
  return undo ? kept : [...kept, RETIRE_TAG]
}

/** The tag a note carries when it replaces `noteKey`. */
export function replacesTag(noteKey) {
  return `${REPLACES_TAG_PREFIX}${noteKey}`
}

/**
 * The note key a note's tags say it replaces.
 *
 * @param {string[]} tags A note's tags.
 * @returns {string} The retired note's key, or '' when this note names no predecessor.
 */
export function replacesKey(tags) {
  const hit = (tags ?? []).map((tag) => String(tag).trim()).find((tag) => lowered(tag).startsWith(REPLACES_TAG_PREFIX))
  return hit ? hit.slice(REPLACES_TAG_PREFIX.length) : ''
}

/**
 * The live note that says it replaced `noteKey`.
 *
 * @param {Array<{key: string, tags?: string[]}>} notes The record's child notes.
 * @param {string} noteKey The retired note's key.
 * @returns {string} The successor's key, or '' when nothing names one yet.
 */
export function successorOf(notes, noteKey) {
  return notes.find((note) => replacesKey(note.tags) === noteKey)?.key ?? ''
}

/**
 * The ordinal a NEW write may use, or a refusal.
 *
 * The unit this discipline writes is the TOP-LEVEL section. A dotted ordinal is refused with the
 * top-level one to pass instead; the note that already carries a dotted claim is `unknown` and is
 * merged or retired in a migration, never folded silently.
 *
 * @param {string|number} value The `--section` value.
 * @returns {string} The ordinal to write.
 * @throws {UsageError} When the value carries no ordinal, or carries a subsection's.
 */
export function sectionWriteToken(value) {
  const token = normalizeSectionToken(value)
  if (!token) throw new UsageError(`--section '${value}' carries no ordinal this tool can match`)
  if (token.includes('.')) {
    const parent = token.split('.')[0]
    throw new UsageError(
      `--section '${value}' names a subsection, and the unit this discipline writes is the TOP-LEVEL section: pass --section ${parent}. ` +
        `A note already keyed to §${token} is UNKNOWN to this tool and must be merged into §${parent} or retired.`,
    )
  }
  return token
}

/**
 * The note that already claims the section a write is for, and why.
 *
 * Only an explicit `/section-N` tag counts. A retired note is a tombstone and does not cover its
 * section; a legacy `/digest` summary is not a section note; an unknown note is read by the discipline
 * rather than guessed at here. There is no parent/child folding: dotted keys are not part of this model.
 *
 * @param {Array<{key: string, retired?: boolean, digest?: boolean, claim: {token: string}}>} notes The record's child notes.
 * @param {string} token The top-level section the write is for.
 * @returns {{note: object, why: string}|undefined} The covering note and the reason, if any.
 */
export function coveringNote(notes, token) {
  const covered = notes.filter((note) => note.claim.token && !note.retired && !note.digest)
  const same = covered.find((note) => note.claim.token === token)
  return same ? { note: same, why: `note ${same.key} claims §${token}` } : undefined
}

/**
 * The first block of prose in a note, as a reader sees it.
 *
 * This is DISPLAY, not a claim: the plan prints it so the reader can decide. "First block", not "first
 * N characters": {@link visibleText} collapses whitespace, so the collapsed text has no line to
 * measure a position against, and what makes a paragraph readable is which block it is.
 *
 * @param {string} noteHtml Note body.
 * @returns {string} The visible text of the first paragraph, heading or list item.
 */
export function firstBlockText(noteHtml) {
  const html = String(noteHtml ?? '')
  const block = /<(p|h[1-6]|li)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html)
  return block ? visibleText(block[2]) : visibleText(html).slice(0, 120)
}

/**
 * Whether the APPLICATION has normalized this note already.
 *
 * Measured: a note the application has written carries its own `<div data-schema-version="...">`
 * wrapper. The plan reports it as `app` rather than `API`; it is also why a read-back compares
 * visible text instead of bytes.
 *
 * @param {string} html Note body.
 * @returns {boolean} True when the body opens with the application's own wrapper.
 */
export function isApplicationWrapped(html) {
  return /^\s*<div data-schema-version="\d+">/.test(String(html ?? ''))
}

/** Whether the body is HTML, because the library stores note bodies as HTML and a Markdown guess
 * would silently change what is stored. */
export function looksLikeHtml(body) {
  return /<(p|div|h[1-6]|ul|ol|li|br|strong|em|code|pre|table|blockquote|hr)\b/i.test(String(body ?? ''))
}

/**
 * The note body a section note is created with.
 *
 * No marker is prepended: the claim is the `/section-N` tag now, and a comment in the body would be
 * eaten by the application while implying an identity the tool no longer reads.
 *
 * @param {string} body The explanation, as HTML.
 * @returns {string} The body to send.
 */
export function composeSectionNote(body) {
  return String(body ?? '').trim()
}

/** The write that creating a note is, so a plan can print it without doing it. */
export function createWriteLine(itemKey) {
  return `POST /api/users/0/items  [{itemType: note, parentItem: ${itemKey}, note: ..., tags: [...]}]`
}

/** Every child note of a record, with the claim its tags carry. */
async function noteChildren(itemKey) {
  const children = await childrenOf(itemKey)
  return children
    .filter((child) => child?.data?.itemType === 'note')
    .map((child) => {
      const tags = (child.data.tags ?? []).map((entry) => entry.tag)
      return {
        key: child.key,
        html: child.data.note ?? '',
        tags,
        retired: isRetired(tags),
        imported: isImported(tags),
        digest: isDigest(tags),
        agent: isAgentNote(tags),
        reviewed: isReviewed(tags),
        claim: readSectionTag(tags),
      }
    })
}

/** Whether two tag lists carry the same set, compared case-insensitively. */
function sameTags(left, right) {
  const a = new Set((left ?? []).map(lowered))
  const b = new Set((right ?? []).map(lowered))
  return a.size === b.size && [...a].every((tag) => b.has(tag))
}

/** The live notes whose tags name more than one section, which must be fixed before a write. */
function ambiguousLive(notes) {
  return notes.filter((note) => note.claim.ambiguous && !note.retired)
}

/**
 * The coverage plan as one object.
 *
 * A round that has to hand the owner one list across several records needs the same facts in a shape
 * it can join on, because prose joined by hand is how each round ends up inventing its own list.
 *
 * @param {{record: object, attachment: object|undefined, notes: Array<object>, outline?: object|null}} input
 *   The record's state, and the file's table of contents when one was read.
 * @returns {object} A JSON-serializable plan.
 */
export function planJson({ record, attachment, notes, outline = null }) {
  const live = notes.filter((note) => note.claim.token && !note.retired && !note.digest)
  const retired = notes.filter((note) => note.retired)
  const legacy = notes.filter((note) => note.digest && !note.retired)
  const unknown = notes.filter((note) => !note.retired && !note.digest && !note.claim.token && !note.claim.ambiguous)
  const ambiguous = notes.filter((note) => note.claim.ambiguous && !note.retired)
  const covered = new Map()
  for (const note of live) {
    const keys = covered.get(note.claim.token) ?? []
    keys.push(note.key)
    covered.set(note.claim.token, keys)
  }
  return {
    record: { key: record.key, itemType: record.itemType, title: record.title ?? '' },
    file: attachment ? { key: attachment.key, contentType: attachment.data?.contentType ?? '' } : null,
    // The file's own table of contents, when it was read: the plan's coverage line names sections by
    // number, and a number alone is not checkable without the title it belongs to. A file whose
    // bookmarks could not be read keeps the reason, so a round does not mistake silence for "none".
    // A file with no bookmarks carries `candidates` instead - heading-shaped lines from its text,
    // named as candidates so nothing downstream reads them as the file's own structure.
    outline: outline
      ? outline.unavailable
        ? { unavailable: outline.unavailable }
        : {
            pageCount: outline.pageCount,
            entries: outline.entries,
            ...(outline.candidates ? { candidates: outline.candidates } : {}),
            ...(outline.candidatesUnavailable ? { candidatesUnavailable: outline.candidatesUnavailable } : {}),
          }
      : null,
    notes: notes.map((note) => ({
      key: note.key,
      chars: note.html.length,
      origin: isApplicationWrapped(note.html) ? 'app' : 'API',
      tags: note.tags,
      retired: note.retired,
      imported: note.imported,
      legacy: note.digest,
      agent: isAgentNote(note.tags),
      reviewed: isReviewed(note.tags),
      provenance: provenanceOf(note.tags),
      authority: authorityOf(note.tags, note.claim.token),
      moves: allowedMoves({
        tags: note.tags,
        token: note.claim.token,
        retired: note.retired,
        digest: note.digest,
        ambiguous: note.claim.ambiguous,
      }),
      section: note.claim.token,
      sectionTags: note.claim.tags,
      invalidSectionTags: note.claim.invalid,
      ambiguous: note.claim.ambiguous,
      replaces: replacesKey(note.tags),
    })),
    coverage: {
      live: [...covered.entries()].map(([section, keys]) => ({ section, notes: keys })),
      retired: retired.map((note) => ({ section: note.claim.token, note: note.key, successor: successorOf(notes, note.key) })),
      legacy: legacy.map((note) => ({ note: note.key })),
      unknown: unknown.map((note) => note.key),
      ambiguous: ambiguous.map((note) => note.key),
      drafts: notes
        .filter((note) => isAgentNote(note.tags) && !isReviewed(note.tags) && !note.retired)
        .map((note) => ({ section: note.claim.token, note: note.key })),
    },
    counts: {
      notes: notes.length,
      live: live.length,
      retired: retired.length,
      legacy: legacy.length,
      unknown: unknown.length,
      ambiguous: ambiguous.length,
      agent: notes.filter((note) => isAgentNote(note.tags)).length,
      reviewed: notes.filter((note) => isAgentNote(note.tags) && isReviewed(note.tags)).length,
      drafts: notes.filter((note) => isAgentNote(note.tags) && !isReviewed(note.tags) && !note.retired).length,
    },
  }
}

/**
 * The file's own table of contents, with the sections this record already explains marked.
 *
 * The plan states coverage as section numbers. A number is only checkable next to the title it names,
 * and asking for a second command to get the title is how a round ends up trusting the number instead.
 *
 * @param {Array<{ordinal: string, title: string, depth: number}>} rows The file's bookmarks.
 * @param {Iterable<string>} claimed Section tokens the live notes claim.
 * @returns {Array<{ordinal: string, title: string, depth: number, covered: boolean}>} The marked rows.
 */
export function markOutlineRows(rows, claimed) {
  const tokens = new Set([...claimed].map((token) => String(token)))
  return rows.map((row) => ({ ...row, covered: String(row.ordinal ?? '') !== '' && tokens.has(String(row.ordinal)) }))
}

/**
 * Read the file's bookmarks, or the reason there are none to print.
 *
 * The PDF rungs live in the other program, which imports `romanToNumber` from this one; a static import
 * back would make the two programs import each other. Loading it on use keeps the static graph a DAG,
 * and a plan that cannot read bookmarks is still a plan: the coverage it prints does not depend on them.
 *
 * @param {object} attachment The attachment child item.
 * @returns {Promise<{pageCount: number, entries: object[]}|{unavailable: string}>} What was found.
 */
async function outlineOf(attachment) {
  try {
    const { attachmentFile, pdfOutline, extractPdfText, headingCandidates } = await import('./zotero-pdf.mjs')
    const { bytes } = await attachmentFile(attachment.key)
    const { rows, pageCount } = await pdfOutline(bytes)
    if (rows.length || (attachment.data?.contentType ?? '') !== 'application/pdf') return { pageCount, rows }
    try {
      return { pageCount, rows, candidates: headingCandidates((await extractPdfText(bytes)).text) }
    } catch (error) {
      return { pageCount, rows, candidatesUnavailable: String(error?.message ?? error).split('\n')[0] }
    }
  } catch (error) {
    return { unavailable: String(error?.message ?? error).split('\n')[0] }
  }
}

/** What the plan says about the file's headings: its own entries, or the candidates its text shows. */
function planOutline(outline, claimed) {
  if (!outline) return null
  if (outline.unavailable) return { unavailable: outline.unavailable }
  if (outline.rows.length === 0) {
    return {
      pageCount: outline.pageCount,
      entries: [],
      ...(outline.candidates?.length ? { candidates: outline.candidates } : {}),
      ...(outline.candidatesUnavailable ? { candidatesUnavailable: outline.candidatesUnavailable } : {}),
    }
  }
  return { pageCount: outline.pageCount, entries: markOutlineRows(outline.rows, claimed) }
}

/** The plan half of `--item …, no --section`: what this record covers, and what to go read. */
async function runPlan(itemKey, { json = false } = {}) {
  const record = await readItem(itemKey)
  if (record.itemType === 'note') throw new UsageError(`${itemKey} is itself a note; pass the record the note is about`)
  const children = await childrenOf(itemKey)
  const notes = await noteChildren(itemKey)
  const attachment = children.find(
    (child) =>
      child.data?.itemType === 'attachment' &&
      ['application/pdf', 'application/epub+zip', 'text/html'].includes(child.data?.contentType ?? ''),
  )
  if (json) {
    const claimed = new Set(notes.filter((note) => note.claim.token && !note.retired && !note.digest).map((note) => note.claim.token))
    const outline = attachment ? planOutline(await outlineOf(attachment), claimed) : null
    console.log(JSON.stringify(planJson({ record, attachment, notes, outline }), null, 2))
    return
  }
  console.log(`record : ${itemKey}  [${record.itemType}]  "${record.title ?? ''}"`)
  console.log(
    `file   : ${attachment ? `${attachment.key}  ${attachment.data.contentType}` : 'NO PDF/EPUB/HTML ATTACHMENT - nothing here can be read as text'}`,
  )
  const claimedTokens = new Set(
    notes.filter((note) => note.claim.token && !note.retired && !note.digest).map((note) => note.claim.token),
  )
  if (attachment) {
    const outline = await outlineOf(attachment)
    if (outline.unavailable) {
      console.log(`outline : unavailable - ${outline.unavailable}`)
    } else if (outline.rows.length === 0) {
      console.log('outline : none - this file carries no bookmarks, so the section titles are only in its text')
      if (outline.candidates?.length) {
        const count = outline.candidates.length
        console.log(
          `candidates : ${count} heading-shaped line${count === 1 ? '' : 's'} from the text, not from the file's table of contents`,
        )
        for (const row of outline.candidates) {
          console.log(`  ${'  '.repeat(row.depth ?? 0)}§${String(row.ordinal).padEnd(3)} ${row.title}`)
        }
        console.log('note    : these are shapes the text shows, not entries the file declares, so none is marked covered')
      } else if (outline.candidatesUnavailable) {
        console.log(`candidates : unavailable - ${outline.candidatesUnavailable}`)
      }
    } else {
      const marked = markOutlineRows(outline.rows, claimedTokens)
      console.log(`outline : ${marked.length} entr${marked.length === 1 ? 'y' : 'ies'} in the file's own table of contents`)
      for (const row of marked) {
        const ordinal = row.ordinal ? `§${String(row.ordinal).padEnd(3)}` : '     '
        console.log(`  ${'  '.repeat(row.depth ?? 0)}${ordinal} ${row.title}${row.covered ? '  <- covered' : ''}`)
      }
      const untitled = [...claimedTokens].filter((token) => !marked.some((row) => String(row.ordinal) === String(token)))
      if (untitled.length) {
        console.log(
          `claimed : ${untitled.map((token) => `§${token}`).join(' · ')} ${untitled.length === 1 ? 'has' : 'have'} no outline entry - check that the number is the one this file uses (a preprint and its issue can differ)`,
        )
      }
    }
  }
  console.log(`notes  : ${notes.length} child note(s)`)

  for (const note of notes) {
    const label = note.digest
      ? 'legacy digest'
      : note.claim.token
        ? `§${note.claim.token}`
        : note.claim.ambiguous
          ? 'ambiguous'
          : 'unknown'
    const marks = [
      note.agent ? (note.reviewed ? 'AGENT+REVIEWED' : 'AGENT') : '',
      note.imported ? 'IMPORTED' : '',
      note.retired ? 'RETIRED' : '',
    ]
      .filter(Boolean)
      .join(' ')
    console.log(
      `\n  ${note.key}  ${String(note.html.length).padStart(6)}c  ${isApplicationWrapped(note.html) ? 'app' : 'API'}  ${label}${marks ? `  ${marks}` : ''}`,
    )
    console.log(`      ${firstBlockText(note.html).slice(0, 96)}`)
    if (note.tags.length) console.log(`      tags: ${note.tags.join(' · ')}`)
    console.log(
      `      class: ${provenanceOf(note.tags)}   moves: ${allowedMoves({
        tags: note.tags,
        token: note.claim.token,
        retired: note.retired,
        digest: note.digest,
        ambiguous: note.claim.ambiguous,
      }).join(' · ')}`,
    )
  }

  const live = notes.filter((note) => note.claim.token && !note.retired && !note.digest)
  const retired = notes.filter((note) => note.retired)
  const legacy = notes.filter((note) => note.digest && !note.retired)
  const unknown = notes.filter((note) => !note.retired && !note.digest && !note.claim.token && !note.claim.ambiguous)
  const ambiguous = notes.filter((note) => note.claim.ambiguous && !note.retired)
  const sections = [...new Set(live.map((note) => note.claim.token))]
  console.log(`\ncovered     : ${sections.length ? sections.map((token) => `§${token}`).join(' · ') : 'none'}`)
  console.log(
    `retired     : ${
      retired.length
        ? retired
            .map((note) => {
              const where = note.claim.token ? `§${note.claim.token}` : '(none)'
              const successor = successorOf(notes, note.key)
              return `${where} (${note.key}${successor ? ` -> superseded by ${successor}` : ' -> nothing names a replacement yet'})`
            })
            .join(' · ')
        : 'none'
    }`,
  )
  console.log(`legacy      : ${legacy.length ? legacy.map((note) => note.key).join(' · ') : 'none'}`)
  console.log(`unknown     : ${unknown.length ? unknown.map((note) => note.key).join(' · ') : 'none'}`)
  console.log(
    `ambiguous   : ${
      ambiguous.length ? ambiguous.map((note) => `${note.key} (${note.claim.tags.join(' · ')})`).join(' · ') : 'none'
    }`,
  )
  const drafts = notes.filter((note) => isAgentNote(note.tags) && !isReviewed(note.tags) && !note.retired)
  console.log(
    `provenance  : ${AGENT_TAG} ${notes.filter((note) => isAgentNote(note.tags)).length} (` +
      `reviewed ${notes.filter((note) => isAgentNote(note.tags) && isReviewed(note.tags)).length}) · ` +
      `${IMPORTED_TAG} ${notes.filter((note) => note.imported).length} · ` +
      `neither ${notes.filter((note) => !isAgentNote(note.tags) && !note.imported).length}` +
      '   (marks, not a partition: a rewritten import carries both)',
  )
  console.log(
    `drafts      : ${
      drafts.length
        ? `${drafts.map((note) => `${note.claim.token ? `§${note.claim.token} ` : ''}(${note.key})`).join(' · ')} - agent-written and not reviewed: candidate-grade`
        : 'none'
    }`,
  )
  console.log("\nNOTE: `covered` is what explicit /section-N tags claim, per TOP-LEVEL section. `unknown`")
  console.log("means no claim: read the first paragraph above, and the whole note with zotero-read.mjs")
  console.log("--item <noteKey> when that is not enough. Each note prints `class:` and the `moves:` the")
  console.log("record permits; which of them this round may take is the discipline's call, and a write")
  console.log("still needs the owner's answer.")
}

/**
 * The note a create may have left behind even though the CLI reports a failure.
 *
 * A create is the one write whose failure can duplicate: the POST lands, the response is lost or the
 * read-back disagrees, and a caller that reads "failure" as "nothing was written" sends it again. The
 * only evidence that separates the two is the record itself, so this re-reads it and matches on the
 * body plus every tag the write intended.
 *
 * @param {string} itemKey The record the note was written on.
 * @param {string} composed The body that was sent.
 * @param {string[]} tags The tags the write intended.
 * @param {Set<string>} before The note keys that existed before the write.
 * @returns {Promise<object|undefined>} The note that landed, if one matches.
 */
async function createdDespiteFailure(itemKey, composed, tags, before) {
  const after = await noteChildren(itemKey)
  return after.find(
    (note) =>
      !before.has(note.key) &&
      visibleText(note.html) === visibleText(composed) &&
      tags.every((tag) => note.tags.some((entry) => lowered(entry) === lowered(tag))),
  )
}

/**
 * Report a write whose outcome is not confirmed, and never as a refusal.
 *
 * Exit 3 is the third answer this CLI needs: exit 1 says nothing was written, exit 0 says it was and
 * reads back, and 3 says the library may hold it. Retrying on 3 is how the same note becomes two.
 *
 * @param {string} noteKey The note that was found, or '' when none was.
 * @param {string} message What happened, in the tool's own words.
 */
function reportUnconfirmed(noteKey, detail) {
  console.error(`\n${noteKey ? 'WRITTEN BUT UNCONFIRMED' : 'SENT BUT UNCONFIRMED'} - ${detail}`)
  if (noteKey) console.error(`The note EXISTS: ${noteKey}.`)
  console.error('Do NOT retry this write. Re-run the plan (--item <recordKey>) and read the record first:')
  console.error('a note that exists and is written again becomes a duplicate, and tags cannot merge them.')
  process.exitCode = 3
}

const BATCH_KEYS = new Set(['item', 'section', 'text', 'file', 'replaces', 'acknowledgeUnknown'])

/**
 * Read a batch manifest into the entries one run can plan and one `--write` can apply.
 *
 * The manifest names what each note is about, one object per note. No file name is parsed: a name is
 * a convention, and a tool that reads a convention as a protocol cannot express an exception - the
 * manifest is where an entry says "§4 of this record is in that file" without a rename.
 *
 * @param {string} json The manifest file's text.
 * @param {{baseDir?: string}} [where] What relative `file` paths resolve against.
 * @returns {object[]} One options-shaped object per entry, in manifest order.
 */
export function parseBatchManifest(json, { baseDir = '.' } = {}) {
  let data
  try {
    data = JSON.parse(json)
  } catch (error) {
    throw new UsageError(`the manifest is not JSON: ${error.message}`)
  }
  if (!Array.isArray(data)) {
    throw new UsageError('the manifest is one JSON array of entries: [{ "item": "<recordKey>", "section": "<ordinal>", "file": "<path>" }]')
  }
  if (data.length === 0) throw new UsageError('the manifest has no entries')
  const seen = new Set()
  return data.map((raw, index) => {
    const where = `entry ${index + 1}`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError(`${where} is not an object`)
    const unknown = Object.keys(raw).filter((key) => !BATCH_KEYS.has(key))
    if (unknown.length) {
      throw new UsageError(`${where} carries ${unknown.join(', ')}, which an entry does not have (it takes ${[...BATCH_KEYS].join(', ')})`)
    }
    const item = String(raw.item ?? '').trim()
    const section = String(raw.section ?? '').trim()
    if (!item) throw new UsageError(`${where} has no "item"`)
    if (!section) throw new UsageError(`${where} has no "section"`)
    const text = typeof raw.text === 'string' && raw.text.trim() !== '' ? raw.text : ''
    const file = typeof raw.file === 'string' && raw.file.trim() !== '' ? resolve(baseDir, raw.file.trim()) : ''
    if ((text === '') === (file === '')) throw new UsageError(`${where} needs exactly one of "text" and "file"`)
    const name = `${item} §${section}`
    if (seen.has(name)) {
      throw new UsageError(`${where} repeats ${name}: writing one section twice is a mistake, not an instruction`)
    }
    seen.add(name)
    return {
      item,
      section,
      text,
      file,
      replaces: String(raw.replaces ?? '').trim(),
      acknowledgeUnknown: String(raw.acknowledgeUnknown ?? '').trim(),
    }
  })
}

/** Create one section note, refusing when the section is already claimed. */
async function runCreate(options) {
  const body = options.file ? readFileSync(options.file, 'utf8') : options.text
  const composed = composeSectionNote(body)
  if (composed === '') throw new UsageError('the note body is empty')
  if (!looksLikeHtml(composed)) {
    throw new UsageError('the note body is not HTML; the library stores note bodies as HTML and a Markdown guess would silently change what is stored')
  }
  const token = sectionWriteToken(options.section)

  const record = await readItem(options.item)
  if (record.itemType === 'note') throw new UsageError(`${options.item} is itself a note; pass the record the note is about`)
  const notes = await noteChildren(options.item)
  const ambiguous = ambiguousLive(notes)
  if (ambiguous.length) {
    console.error(`\nREFUSED: ${ambiguous.map((note) => note.key).join(' · ')} carry more than one /section- tag.`)
    console.error('An ambiguous note is not coverage. Read it, then remove the stale tag:')
    console.error('  --unclaim --note <noteKey> --section <ordinal> --write   (one tag per command)')
    process.exitCode = 1
    return
  }

  // A create on a record whose notes were never read is how a duplicate happens: the round reads
  // `covered: none`, writes, and a note that was there all along turns out to explain the same
  // section. The refusal is narrow - it fires only while an unclaimed note exists - and the owner's
  // sentence is what carries the judgement.
  const unknown = notes.filter((note) => !note.retired && !note.digest && !note.claim.token && !note.claim.ambiguous)
  const acknowledged = String(options.acknowledgeUnknown ?? '').trim()
  if (unknown.length && !acknowledged) {
    console.error(`\nREFUSED: ${unknown.length} note(s) on this record carry no /section- tag: ${unknown.map((note) => note.key).join(' · ')}.`)
    console.error('Read them first (zotero-read.mjs --item <noteKey>): a section is not uncovered until they')
    console.error('have been read. If none of them explains this section, say what you read and why:')
    console.error(`  --acknowledge-unknown "<what you read, and why none covers §${token}>"`)
    process.exitCode = 1
    return
  }

  const replacedKey = String(options.replaces ?? '').trim()
  if (replacedKey) {
    const old = await readItem(replacedKey)
    if (old.itemType !== 'note') throw new UsageError(`--replaces ${replacedKey} is a ${old.itemType}, not a note`)
    const oldTags = (old.tags ?? []).map((entry) => entry.tag)
    if (!isRetired(oldTags)) {
      throw new UsageError(`--replaces ${replacedKey} is not retired, so it still covers its section. Retire it first: --retire --note ${replacedKey} --reason "<why>" --write`)
    }
    if (isDigest(oldTags)) throw new UsageError(`--replaces ${replacedKey} is a legacy /digest summary, not a section note`)
    const oldClaim = readSectionTag(oldTags)
    if (oldClaim.ambiguous) throw new UsageError(`--replaces ${replacedKey} carries more than one /section- tag; resolve it first: --unclaim --note ${replacedKey} --section <ordinal> --write`)
    if (oldClaim.token && oldClaim.token !== token) {
      throw new UsageError(`--replaces ${replacedKey} explains §${oldClaim.token}, not §${token}: retiring one section's note does not free another's`)
    }
  }

  const covering = coveringNote(notes, token)
  const tags = [sectionTag(token), AGENT_TAG, ...(replacedKey ? [replacesTag(replacedKey)] : [])]

  console.log(`record  : ${options.item}  [${record.itemType}]  "${record.title ?? ''}"`)
  console.log(`section : §${token}`)
  console.log(`notes   : ${notes.length} child note(s); claimed: ${[...new Set(notes.filter((note) => note.claim.token).map((note) => `§${note.claim.token}`))].join(' · ') || 'none'}`)
  console.log(`body    : ${composed.length} characters; tags: ${tags.join(' · ')}`)
  console.log(`author  : agent (${AGENT_TAG}); it stays a candidate-grade draft until the owner adds ${REVIEWED_TAG}`)
  if (unknown.length) console.log(`unknown : ${unknown.length} note(s) acknowledged: ${acknowledged}`)
  if (replacedKey) console.log(`replaces: ${replacedKey} (tag ${replacesTag(replacedKey)}) - it is retired, so §${token} is free`)
  console.log(`write   : ${createWriteLine(options.item)}`)

  if (covering) {
    console.error(`\nREFUSED: §${token} is already covered - ${covering.why}.`)
    console.error('Nothing was written. Read that note: if it is NOT about this section, report both readings')
    console.error('and stop. Do not work around this refusal.')
    process.exitCode = 1
    return
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write.')
    return
  }

  const before = new Set(notes.map((note) => note.key))
  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  const payload = { itemType: 'note', parentItem: options.item, note: composed, tags: tags.map((tag) => ({ tag })) }
  writeAttempted = true
  let res
  let sendError
  try {
    res = await gate.write('POST', '/api/users/0/items', [payload])
  } catch (error) {
    sendError = error
  }
  if (sendError) {
    let landed
    try {
      landed = await createdDespiteFailure(options.item, composed, tags, before)
    } catch {
      landed = undefined
    }
    reportUnconfirmed(
      landed?.key ?? '',
      landed
        ? `the request failed (${sendError.message}), yet a note matching this body is on the record.`
        : `the request failed (${sendError.message}) and no matching note was found on a re-read.`,
    )
    return
  }
  if (!isWriteAccepted(res.status)) {
    let landed
    try {
      landed = await createdDespiteFailure(options.item, composed, tags, before)
    } catch {
      landed = undefined
    }
    if (landed) {
      reportUnconfirmed(landed.key, `the library answered HTTP ${res.status}, yet a note matching this body is on the record.`)
      return
    }
    console.error(`\nThe library refused the write (HTTP ${res.status}): ${res.text.slice(0, 300)}`)
    console.error('No note matching this body was found on a re-read, so nothing was written.')
    process.exitCode = 1
    return
  }
  const saved = JSON.parse(res.text)
  const noteKey = createdItemKey(saved)
  if (!noteKey) {
    let landed
    try {
      landed = await createdDespiteFailure(options.item, composed, tags, before)
    } catch {
      landed = undefined
    }
    reportUnconfirmed(landed?.key ?? '', `the library accepted the write (HTTP ${res.status}) but named no note key.`)
    return
  }
  const back = await readItem(noteKey)
  const backTags = (back.tags ?? []).map((entry) => entry.tag)
  if (!visibleText(back.note ?? '').includes(visibleText(composed))) {
    reportUnconfirmed(noteKey, `READ-BACK MISMATCH: note ${noteKey} exists but does not read back with the text that was sent.`)
    return
  }
  if (readSectionTag(backTags).token !== token) {
    reportUnconfirmed(noteKey, `READ-BACK MISMATCH: note ${noteKey} does not read back carrying ${sectionTag(token)}.`)
    return
  }
  if (!isAgentNote(backTags)) {
    reportUnconfirmed(noteKey, `READ-BACK MISMATCH: note ${noteKey} does not read back carrying ${AGENT_TAG}.`)
    return
  }
  if (replacedKey && replacesKey(backTags) !== replacedKey) {
    reportUnconfirmed(noteKey, `READ-BACK MISMATCH: note ${noteKey} does not read back carrying ${replacesTag(replacedKey)}.`)
    return
  }
  console.log(`\nOK - note ${noteKey} carries §${token} and ${AGENT_TAG} on ${options.item} (now ${back.note.length} characters, version ${back.version}).` + (replacedKey ? ` It replaces ${replacedKey}.` : ''))
  console.log(`It is a DRAFT: ${REVIEWED_TAG} is the owner's act (--review --note ${noteKey}), and until then an`)
  console.log('adoption may treat it as a candidate only.')
}

/**
 * Create the notes a manifest lists, one entry at a time.
 *
 * Each entry goes through the same read, refusal and read-back as a single `--section`, so a batch is
 * not a faster channel - it is the same channel with the process started once. The run stops at the
 * first entry that does not read back, because a batch that keeps writing past an unconfirmed write
 * produces a record whose state no summary can describe.
 */
async function runBatch(options) {
  let source
  try {
    source = readFileSync(options.batch, 'utf8')
  } catch (error) {
    throw new UsageError(`the manifest ${options.batch} could not be read: ${error.code ?? error.message}`)
  }
  const entries = parseBatchManifest(source, { baseDir: dirname(resolve(options.batch)) })
  console.log(`batch   : ${entries.length} entries from ${options.batch}`)
  console.log(`write   : ${options.write ? 'each entry in turn, stopping at the first one that is not confirmed' : 'none - this is a dry run'}`)
  const done = []
  for (const [index, entry] of entries.entries()) {
    console.log(`\n--- ${index + 1}/${entries.length}  ${entry.item}  §${entry.section}`)
    process.exitCode = 0
    await runCreate({ ...entry, write: options.write, plan: false, json: false })
    const code = process.exitCode ?? 0
    if (code !== 0) {
      console.log(`\nbatch   : stopped at entry ${index + 1} of ${entries.length} (exit ${code}).`)
      console.log(`done    : ${done.length ? done.map((row) => `${row.item} §${row.section}`).join(' · ') : 'none'}`)
      const left = entries.slice(index + 1)
      if (left.length) console.log(`skipped : ${left.map((row) => `${row.item} §${row.section}`).join(' · ')} - not attempted`)
      return
    }
    done.push(entry)
  }
  console.log(`\nbatch   : ${done.length} of ${entries.length} ${options.write ? 'written and read back' : 'planned and clean'}.`)
}

/**
 * Claim an existing note for a top-level section.
 *
 * The body is never touched. A note with no `/section-` tag receives `/imported` as well, because it
 * came from outside this tool and remains an import that may be rewritten. An `/agent-note` does not
 * receive it: its author is already recorded, and calling an agent's own body an import would say the
 * wrong thing about where it came from.
 */
async function runClaim(options) {
  const note = await readItem(options.note)
  if (note.itemType !== 'note') throw new UsageError(`${options.note} is a ${note.itemType}, not a note`)
  const token = sectionWriteToken(options.section)
  const tags = (note.tags ?? []).map((entry) => entry.tag)
  if (isRetired(tags)) throw new UsageError(`${options.note} is retired; run --retire --note ${options.note} --undo --write first`)
  if (isDigest(tags)) throw new UsageError(`${options.note} is a legacy /digest whole-paper summary, not a section note; it is not claimed for a section`)
  if (!note.parentItem) throw new UsageError(`${options.note} has no parent item; a section note is a child of the record it explains`)
  const claim = readSectionTag(tags)
  if (claim.ambiguous) {
    console.error(`\nREFUSED: ${options.note} carries more than one /section- tag (${claim.tags.join(' · ')}).`)
    console.error('An ambiguous note is not coverage. Remove the stale tag first:')
    console.error(`  --unclaim --note ${options.note} --section <ordinal> --write   (one tag per command)`)
    process.exitCode = 1
    return
  }

  const notes = await noteChildren(note.parentItem)
  const ambiguous = ambiguousLive(notes.filter((entry) => entry.key !== options.note))
  if (ambiguous.length) {
    console.error(`\nREFUSED: ${ambiguous.map((entry) => entry.key).join(' · ')} carry more than one /section- tag.`)
    console.error('An ambiguous note is not coverage. Read it, then remove the stale tag:')
    console.error('  --unclaim --note <noteKey> --section <ordinal> --write   (one tag per command)')
    process.exitCode = 1
    return
  }
  const covering = coveringNote(notes.filter((entry) => entry.key !== options.note), token)
  if (covering) {
    console.error(`\nREFUSED: §${token} is already claimed - ${covering.why}.`)
    console.error('Nothing was written. Read both notes: if the existing claim is wrong, retire it first;')
    console.error('if this note is about another section, claim that section instead.')
    process.exitCode = 1
    return
  }

  const addImported = claim.token === '' && !isImported(tags) && !isAgentNote(tags)
  const kept = tags.filter((tag) => !lowered(tag).startsWith(SECTION_TAG_PREFIX))
  const after = [...kept, sectionTag(token), ...(addImported || isImported(tags) ? [IMPORTED_TAG] : [])]
    .filter((tag, index, list) => list.findIndex((entry) => lowered(entry) === lowered(tag)) === index)
  const unchanged = claim.token === token && !addImported

  console.log(`note    : ${options.note}  parent ${note.parentItem}  version ${note.version}`)
  console.log(`claim   : ${claim.token ? `§${claim.token}` : 'none'}${claim.tags.length ? ` (tags ${claim.tags.join(' · ')})` : ''}  ->  §${token}`)
  console.log(`author  : ${provenanceOf(tags)}${authorityOf(after, token) === 'candidate' ? ' (a draft: candidate-grade until /reviewed)' : ''}`)
  console.log(`tags    : ${tags.length ? tags.join(' · ') : '(none)'}  ->  ${after.join(' · ')}`)
  console.log(`change  : ${unchanged ? 'nothing (already claimed)' : addImported ? 'claim + /imported' : 'claim'}   (the body is NOT touched)`)
  console.log(`write   : PATCH /api/users/0/items/${options.note}  [{tags: [...]}]`)

  if (unchanged) {
    console.log('\nnothing to do - the note already claims this section, and this tool writes no no-op.')
    return
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write.')
    return
  }

  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  writeAttempted = true
  const result = await patchItem({ gate, key: options.note, patch: { tags: after.map((tag) => ({ tag })) }, apply: true })
  if (result.conflict) {
    console.error(`\nCONFLICT: note ${options.note} changed since this plan was read. Nothing was written.`)
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    process.exitCode = 1
    return
  }
  const backTags = (result.after.tags ?? []).map((entry) => entry.tag)
  if (readSectionTag(backTags).token !== token) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back carrying ${sectionTag(token)}.`)
    return
  }
  if (addImported && !isImported(backTags)) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back carrying ${IMPORTED_TAG}.`)
    return
  }
  console.log(`\nOK - note ${options.note} claims §${token}${addImported ? ' and is marked /imported' : ''} (version ${result.after.version}).`)
  if (authorityOf(backTags, token) === 'candidate') {
    console.log(`It is an agent draft: ${REVIEWED_TAG} is the owner's act (--review --note ${options.note}).`)
  }
}

/**
 * Remove ONE stale `/section-N` tag from a note that carries more than one.
 *
 * The only state this mode may resolve is ambiguity: a note carrying two section tags is not coverage
 * at all (`readSectionTag` refuses to guess), and every write path on this record is blocked until one
 * of the two tags is gone. Retiring the note would work too, but it takes a note out of service over a
 * tag mistake, and it loses the claim the surviving tag still makes.
 *
 * It is deliberately narrow. A note carrying ONE tag is a claim, and protocol §6 says a reading that
 * disagrees with a claim stops the round for the owner to settle - so this mode refuses that case and
 * names the refusal rather than offering a way around it. One tag per invocation, `--write` to apply,
 * the body untouched, and the version read at is what the plan was formed on.
 */
async function runUnclaim(options) {
  const note = await readItem(options.note)
  if (note.itemType !== 'note') throw new UsageError(`${options.note} is a ${note.itemType}, not a note`)
  const tags = (note.tags ?? []).map((entry) => entry.tag)
  if (isRetired(tags)) {
    throw new UsageError(
      `${options.note} is retired; a tombstone is not rewritten. Put its claim back first: --retire --note ${options.note} --undo --write`,
    )
  }
  if (isDigest(tags)) throw new UsageError(`${options.note} is a legacy /digest whole-paper summary; it carries no section claim to remove`)
  const claim = readSectionTag(tags)
  if (!claim.ambiguous) {
    console.error(`\nREFUSED: ${options.note} carries ${claim.tags.length === 1 ? `one tag (${claim.tags[0]})` : 'no /section- tag'}.`)
    console.error('--unclaim removes one tag from a note carrying MORE THAN ONE: it resolves ambiguity and')
    console.error('nothing else. A single claim is not removed here - a reading that disagrees with it')
    console.error('stops the round for the owner to settle (protocol §6).')
    process.exitCode = 1
    return
  }

  const token = sectionWriteToken(options.section)
  if (!claim.tags.some((tag) => sectionTokenFromTag(tag) === token)) {
    throw new UsageError(`${options.note} carries no §${token} tag; it carries ${claim.tags.join(' · ')}`)
  }
  const after = tags.filter((tag) => lowered(tag) !== lowered(sectionTag(token)))
  const remaining = readSectionTag(after)

  console.log(`note    : ${options.note}  parent ${note.parentItem ?? '(none)'}  version ${note.version}`)
  console.log(`claim   : ambiguous (${claim.tags.join(' · ')})  ->  ${remaining.token ? `§${remaining.token}` : 'none'}`)
  console.log(`tags    : ${tags.join(' · ')}  ->  ${after.join(' · ') || '(none)'}`)
  console.log(`change  : remove ${sectionTag(token)}   (the body is NOT touched)`)
  console.log(`write   : PATCH /api/users/0/items/${options.note}  [{tags: [...]}]`)
  console.log(
    remaining.token
      ? `effect  : the note claims §${remaining.token} again, and this record is no longer ambiguous.`
      : 'effect  : the note carries no claim again - it is UNKNOWN until it is read and claimed.',
  )

  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write.')
    return
  }

  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  writeAttempted = true
  const result = await patchItem({ gate, key: options.note, patch: { tags: after.map((tag) => ({ tag })) }, apply: true })
  if (result.conflict) {
    console.error(`\nCONFLICT: note ${options.note} changed since this plan was read. Nothing was written.`)
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    process.exitCode = 1
    return
  }
  const back = (result.after.tags ?? []).map((entry) => entry.tag)
  if (readSectionTag(back).tags.some((tag) => sectionTokenFromTag(tag) === token)) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} still carries ${sectionTag(token)}.`)
    return
  }
  console.log(`\nOK - note ${options.note} no longer carries ${sectionTag(token)} (version ${result.after.version}).`)
  if (remaining.token) console.log(`It claims §${remaining.token} again; nothing else on the note changed.`)
  else console.log('It carries no claim again: read it and claim it before anything is written for its section.')
}

/** Retire one note, or put its claim back. One note, one write, and the body is never touched. */
async function runRetire(options) {
  const note = await readItem(options.note)
  if (note.itemType !== 'note') throw new UsageError(`${options.note} is a ${note.itemType}, not a note`)
  const tags = (note.tags ?? []).map((entry) => entry.tag)
  const claim = readSectionTag(tags)
  const undo = options.undo === true
  const want = !undo
  const already = isRetired(tags)
  const after = retireTags(tags, { undo })

  console.log(`note    : ${options.note}  parent ${note.parentItem ?? '(none)'}  version ${note.version}`)
  console.log(`claim   : ${claim.token ? `§${claim.token}` : claim.ambiguous ? 'ambiguous tags' : 'none (not a section note)'}`)
  console.log(`tags    : ${tags.length ? tags.join(' · ') : '(none)'}  ->  ${after.join(' · ') || '(none)'}`)
  console.log(`change  : ${already ? 'retired' : 'live'} -> ${want ? 'retired' : 'live'}   (the body is NOT touched)`)
  if (options.reason) {
    console.log(`reason  : ${options.reason}`)
    console.log('          a tag cannot hold prose, so this reason is not stored on the note: write it into')
    console.log("          the note that replaces this one, and into the round's report.")
  }
  console.log(`write   : PATCH /api/users/0/items/${options.note}  [{tags: [...]}]`)

  if (already === want) {
    console.log(`\nnothing to do - the note is already ${already ? 'retired' : 'live'}, and this tool writes no no-op.`)
    return
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write.')
    return
  }

  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  writeAttempted = true
  const result = await patchItem({ gate, key: options.note, patch: { tags: after.map((tag) => ({ tag })) }, apply: true })
  if (result.conflict) {
    console.error(`\nCONFLICT: note ${options.note} changed since this plan was read. Nothing was written.`)
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    process.exitCode = 1
    return
  }
  const back = (result.after.tags ?? []).map((entry) => entry.tag)
  if (isRetired(back) !== want) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back ${want ? 'retired' : 'live'} - the mark did not survive the write.`)
    return
  }
  console.log(`\nOK - note ${options.note} is ${want ? 'retired' : 'live again'} (version ${result.after.version}).`)
  if (want && claim.token) console.log(`§${claim.token} is writable again; the note itself is untouched and --undo puts the claim back.`)
  else if (want) console.log('It covered no section; it is now a tombstone and may be deleted.')
  else if (claim.token) console.log(`§${claim.token} is covered by it again; the note itself was never changed.`)
  else console.log('It is live again and covers no section.')
}

/**
 * Rewrite a note's body in place.
 *
 * Three classes may be rewritten: an import (no `/section-` tag, or `/section-N` + `/imported`), and
 * an agent DRAFT (`/agent-note` without `/reviewed`). A `/section-N` note without `/imported` or
 * `/agent-note` is the owner's record, and a reviewed agent note is a record too: their prose is not
 * rewritten in place, and changing one is a retirement and a new note. No backup is written: a section
 * note is a transcription of the paper, the paper remains the source, and the plan prints the old
 * first block before anything is sent. The version guard is what is kept: a note the application
 * edited while this ran is refused rather than overwritten.
 */
async function runRewrite(options) {
  const body = options.file ? readFileSync(options.file, 'utf8') : options.text
  const composed = composeSectionNote(body)
  if (composed === '') throw new UsageError('the note body is empty')
  if (!looksLikeHtml(composed)) {
    throw new UsageError('the note body is not HTML; the library stores note bodies as HTML and a Markdown guess would silently change what is stored')
  }
  const note = await readItem(options.note)
  if (note.itemType !== 'note') throw new UsageError(`${options.note} is a ${note.itemType}, not a note`)
  const tags = (note.tags ?? []).map((entry) => entry.tag)
  const claim = readSectionTag(tags)
  if (isRetired(tags)) throw new UsageError(`${options.note} is retired; a tombstone is not rewritten`)
  if (claim.ambiguous) throw new UsageError(`${options.note} carries more than one /section- tag; resolve it before rewriting: --unclaim --note ${options.note} --section <ordinal> --write`)
  if (isReviewed(tags)) {
    throw new UsageError(
      `${options.note} carries ${REVIEWED_TAG}: the owner accepted that body, so it is a record. Retire it and write the replacement, or --review --note ${options.note} --undo --write first.`,
    )
  }
  if (claim.token && !isImported(tags) && !isAgentNote(tags)) {
    throw new UsageError(
      `${options.note} is a §${claim.token} record without ${IMPORTED_TAG}: a record's prose is not rewritten in place. Retire it and write the replacement, or claim an import.`,
    )
  }

  const token = options.section ? sectionWriteToken(options.section) : ''
  let after = tags
  let addImported = false
  if (token) {
    if (!note.parentItem) throw new UsageError(`${options.note} has no parent item; a section note is a child of the record it explains`)
    const notes = await noteChildren(note.parentItem)
    const covering = coveringNote(notes.filter((entry) => entry.key !== options.note), token)
    if (covering) {
      console.error(`\nREFUSED: §${token} is already claimed - ${covering.why}.`)
      process.exitCode = 1
      return
    }
    addImported = claim.token === ''
    after = [...tags.filter((tag) => !lowered(tag).startsWith(SECTION_TAG_PREFIX)), sectionTag(token)]
    if (addImported || isImported(tags)) after.push(IMPORTED_TAG)
    after = after.filter((tag, index, list) => list.findIndex((entry) => lowered(entry) === lowered(tag)) === index)
  }
  if (!isAgentNote(after)) after = [...after, AGENT_TAG]

  console.log(`note    : ${options.note}  parent ${note.parentItem ?? '(none)'}  version ${note.version}`)
  console.log(`claim   : ${claim.token ? `§${claim.token}` : 'none'}  author: ${provenanceOf(tags)}`)
  console.log(`size    : ${String(note.note ?? '').length} -> ${composed.length} characters`)
  console.log(`old     : ${firstBlockText(note.note ?? '').slice(0, 96)}`)
  console.log(`new     : ${firstBlockText(composed).slice(0, 96)}`)
  console.log(`tags    : ${tags.length ? tags.join(' · ') : '(none)'}  ->  ${after.join(' · ')}`)
  console.log(`effect  : the body is replaced by an agent draft - ${AGENT_TAG} is added, ${REVIEWED_TAG} is not`)
  console.log(`write   : PATCH /api/users/0/items/${options.note}  [{note: ..., tags: [...]}]`)

  if (sameTags(after, tags) && visibleText(note.note ?? '') === visibleText(composed)) {
    console.log('\nnothing to do - the body already reads the same and the tags would not change.')
    return
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write.')
    return
  }

  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  const patch = { note: composed, tags: after.map((tag) => ({ tag })) }
  writeAttempted = true
  const result = await patchItem({ gate, key: options.note, patch, apply: true })
  if (result.conflict) {
    console.error(`\nCONFLICT: note ${options.note} changed since this plan was read. Nothing was written.`)
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    process.exitCode = 1
    return
  }
  const afterText = visibleText(result.after.note ?? '')
  if (afterText !== visibleText(composed)) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back with the text that was sent.`)
    return
  }
  const backTags = (result.after.tags ?? []).map((entry) => entry.tag)
  if (token && readSectionTag(backTags).token !== token) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back carrying ${sectionTag(token)}.`)
    return
  }
  if (addImported && !isImported(backTags)) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back carrying ${IMPORTED_TAG}.`)
    return
  }
  if (!isAgentNote(backTags)) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back carrying ${AGENT_TAG}.`)
    return
  }
  console.log(`\nOK - note ${options.note} rewritten (now ${result.after.note.length} characters, version ${result.after.version}).`)
  console.log(`It is an agent draft: ${REVIEWED_TAG} is the owner's act (--review --note ${options.note}).`)
}

/**
 * Correct a record's body in place, keeping its key, its claim and its provenance.
 *
 * A repair changes how the note states something and never what it claims: the section tag is not
 * touched, no `/replaces-` pointer is written, and no second note is created. Every repair adds
 * {@link REPAIRED_TAG}; a substantive one (a symbol, a number, an equation) drops {@link REVIEWED_TAG}
 * so the body reads as a draft until the owner accepts it again. A body the owner wrote is repaired
 * mechanically only, because no tag can record an owner's re-acceptance of a changed statement: its
 * substantive correction is a retirement and a replacement.
 *
 * The class is the caller's to state, and this tool refuses `mechanical` where it can prove the
 * change is substantive ({@link changeClass}). The plan prints the old and new first blocks, the
 * changed span and the reason, and the version guard is what keeps a note the application edited
 * meanwhile from being overwritten. No workspace backup is written: the paper remains the source.
 *
 * @param {{note: string, text: string, file: string, reason: string, mechanical?: boolean, substantive?: boolean, write?: boolean}} options Parsed command line.
 */
async function runRepair(options) {
  const body = options.file ? readFileSync(options.file, 'utf8') : options.text
  const composed = composeSectionNote(body)
  if (composed === '') throw new UsageError('the note body is empty')
  if (!looksLikeHtml(composed)) {
    throw new UsageError('the note body is not HTML; the library stores note bodies as HTML and a Markdown guess would silently change what is stored')
  }
  const note = await readItem(options.note)
  if (note.itemType !== 'note') throw new UsageError(`${options.note} is a ${note.itemType}, not a note`)
  const tags = (note.tags ?? []).map((entry) => entry.tag)
  const claim = readSectionTag(tags)
  if (isRetired(tags)) {
    throw new UsageError(`${options.note} is retired; a tombstone is repaired by writing its successor, not by editing it`)
  }
  if (isDigest(tags)) {
    throw new UsageError(`${options.note} carries ${DIGEST_TAG}: a legacy whole-paper summary is not a section note and is never repaired`)
  }
  if (claim.ambiguous) {
    throw new UsageError(`${options.note} carries more than one /section- tag; resolve it before repairing: --unclaim --note ${options.note} --section <ordinal> --write`)
  }
  if (!claim.token) {
    throw new UsageError(`${options.note} claims no section; an unclaimed note is rewritten, not repaired: --rewrite --note ${options.note} --file <draft>`)
  }
  if (isImported(tags)) {
    throw new UsageError(`${options.note} is an import; an import is rewritten in place, not repaired: --rewrite --note ${options.note} --file <draft>`)
  }
  if (authorityOf(tags, claim.token) !== 'record') {
    throw new UsageError(`${options.note} is an agent draft; a draft is rewritten, not repaired: --rewrite --note ${options.note} --file <draft>`)
  }

  const provenance = provenanceOf(tags)
  const substantive = options.substantive === true
  const change = changeClass(visibleText(note.note ?? ''), visibleText(composed))
  if (!substantive && change.substantive) {
    throw new UsageError(
      `--mechanical is refused: ${change.why}. Re-run with --substantive (the body becomes a draft again), or retire the note and write its replacement.`,
    )
  }
  if (provenance === 'owner' && substantive) {
    throw new UsageError(
      `${options.note} is the owner's own record: it is repaired mechanically only. A correction to a symbol, a number or an equation is a retirement and a replacement, or the owner's own edit in the application.`,
    )
  }

  const after = repairTags(tags, { substantive })
  const span = changedSpan(visibleText(note.note ?? ''), visibleText(composed))
  const clearsReview = substantive && isReviewed(tags)

  console.log(`note    : ${options.note}  parent ${note.parentItem ?? '(none)'}  version ${note.version}`)
  console.log(`claim   : §${claim.token}  author: ${provenance}`)
  console.log(`size    : ${String(note.note ?? '').length} -> ${composed.length} characters`)
  console.log(`old     : ${firstBlockText(note.note ?? '').slice(0, 96)}`)
  console.log(`new     : ${firstBlockText(composed).slice(0, 96)}`)
  console.log(`changed : ${JSON.stringify(span.before).slice(0, 120)} -> ${JSON.stringify(span.after).slice(0, 120)}`)
  console.log(`class   : ${substantive ? 'substantive' : 'mechanical'} - ${substantive ? 'stated' : change.why}`)
  console.log(`reason  : ${options.reason}`)
  console.log(`tags    : ${tags.join(' · ') || '(none)'}  ->  ${after.join(' · ')}`)
  console.log(`effect  : the body is corrected in place; the key, §${claim.token} and ${provenance} provenance stay`)
  console.log(`          ${clearsReview ? `${REVIEWED_TAG} is CLEARED: the body is a draft again` : `${REVIEWED_TAG} is kept`}`)
  console.log(`write   : PATCH /api/users/0/items/${options.note}  [{note: ..., tags: [...]}]`)

  if (sameTags(after, tags) && visibleText(note.note ?? '') === visibleText(composed)) {
    console.log('\nnothing to do - the body already reads the same and the tags would not change.')
    return
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write.')
    return
  }

  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  const patch = { note: composed, tags: after.map((tag) => ({ tag })) }
  writeAttempted = true
  const result = await patchItem({ gate, key: options.note, patch, apply: true })
  if (result.conflict) {
    console.error(`\nCONFLICT: note ${options.note} changed since this plan was read. Nothing was written.`)
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    process.exitCode = 1
    return
  }
  if (visibleText(result.after.note ?? '') !== visibleText(composed)) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back with the text that was sent.`)
    return
  }
  const backTags = (result.after.tags ?? []).map((entry) => entry.tag)
  if (readSectionTag(backTags).token !== claim.token) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back carrying /section-${claim.token}.`)
    return
  }
  if (!isRepaired(backTags)) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back carrying ${REPAIRED_TAG}.`)
    return
  }
  if (clearsReview && isReviewed(backTags)) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} still carries ${REVIEWED_TAG} after a substantive repair.`)
    return
  }
  console.log(`\nOK - note ${options.note} repaired in place (now ${result.after.note.length} characters, version ${result.after.version}).`)
  console.log(`It keeps §${claim.token} and ${provenance} provenance, and carries ${REPAIRED_TAG}.`)
  if (clearsReview) {
    console.log(`${REVIEWED_TAG} is cleared: the body is a draft until the owner accepts it (--review --note ${options.note}).`)
    console.log('An adoption item resting on this note is a candidate again until then (INV-ADOPT-5).')
  }
}

/**
 * Record the owner's acceptance of an agent-written body, or take it back.
 *
 * This is a tag and never a body edit: the owner's judgement is that the prose is right, and the prose
 * is what they judged. The note stays the owner's either way; `/reviewed` says a later round may treat
 * it as a record rather than as a draft. `--undo` puts it back into the draft state, which is the one
 * reversal that does not touch a word.
 */
async function runReview(options) {
  const note = await readItem(options.note)
  if (note.itemType !== 'note') throw new UsageError(`${options.note} is a ${note.itemType}, not a note`)
  const tags = (note.tags ?? []).map((entry) => entry.tag)
  const claim = readSectionTag(tags)
  const undo = options.undo === true
  const want = !undo
  const already = isReviewed(tags)
  if (isRetired(tags)) throw new UsageError(`${options.note} is retired; a tombstone is not reviewed`)
  if (!isAgentNote(tags)) {
    throw new UsageError(`${options.note} carries no ${AGENT_TAG}: only a body an agent wrote has a review state. An owner's note is a record already.`)
  }
  const after = reviewTags(tags, { undo })

  console.log(`note    : ${options.note}  parent ${note.parentItem ?? '(none)'}  version ${note.version}`)
  console.log(`claim   : ${claim.token ? `§${claim.token}` : 'none (not a section note)'}`)
  console.log(`body    : ${String(note.note ?? '').length} characters`)
  console.log(`first   : ${firstBlockText(note.note ?? '').slice(0, 96)}`)
  console.log(`tags    : ${tags.length ? tags.join(' · ') : '(none)'}  ->  ${after.join(' · ')}`)
  console.log(`change  : ${already === want ? 'nothing' : want ? 'draft -> record' : 'record -> draft'}   (the body is NOT touched)`)
  if (want) console.log(`effect  : an adoption may rest on it as a record; it is no longer rewritten in place`)
  else console.log('effect  : it is an agent draft again and may be rewritten in place')

  if (already === want) {
    console.log(`\nnothing to do - the note is already ${want ? 'reviewed' : 'an unreviewed draft'}, and this tool writes no no-op.`)
    return
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write.')
    return
  }

  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  writeAttempted = true
  const result = await patchItem({ gate, key: options.note, patch: { tags: after.map((tag) => ({ tag })) }, apply: true })
  if (result.conflict) {
    console.error(`\nCONFLICT: note ${options.note} changed since this plan was read. Nothing was written.`)
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    process.exitCode = 1
    return
  }
  const back = (result.after.tags ?? []).map((entry) => entry.tag)
  if (isReviewed(back) !== want) {
    reportUnconfirmed(options.note, `READ-BACK MISMATCH: note ${options.note} does not read back ${want ? 'reviewed' : 'as a draft'}.`)
    return
  }
  console.log(`\nOK - note ${options.note} is ${want ? `reviewed by the owner (${REVIEWED_TAG})` : 'an unreviewed draft again'} (version ${result.after.version}).`)
}

/**
 * Delete a retired note.
 *
 * This is the one irreversible write in the preset, and it is allowed only on a note that already
 * carries `/retired`. The API cannot put an item in the trash: the note is erased, the key answers
 * 404 afterwards, and the trash count does not move. The plan is printed first, `--write` is the
 * owner's second answer, and the request carries the version the plan was read at, because this API
 * answers 428 without that precondition. The delete is proved by a read-back 404, not by the 204.
 */
async function runDelete(options) {
  const note = await readItem(options.note)
  if (note.itemType !== 'note') throw new UsageError(`${options.note} is a ${note.itemType}, not a note`)
  const tags = (note.tags ?? []).map((entry) => entry.tag)
  const claim = readSectionTag(tags)
  if (!isRetired(tags)) {
    console.error(`\nREFUSED: ${options.note} does not carry ${RETIRE_TAG}. Only a retired note may be deleted.`)
    console.error(`Retire it first: --retire --note ${options.note} --reason "<why>" --write`)
    process.exitCode = 1
    return
  }
  const notes = note.parentItem ? await noteChildren(note.parentItem) : []
  const successor = successorOf(notes, options.note)

  console.log(`note    : ${options.note}  parent ${note.parentItem ?? '(none)'}  version ${note.version}`)
  console.log(`claim   : ${claim.token ? `§${claim.token}` : 'none (not a section note)'}`)
  console.log(`tags    : ${tags.length ? tags.join(' · ') : '(none)'}`)
  console.log(`size    : ${String(note.note ?? '').length} characters`)
  console.log(`body    : ${firstBlockText(note.note ?? '').slice(0, 96)}`)
  console.log(`successor: ${successor ? `${successor} names itself this note's replacement` : 'nothing names a replacement yet'}`)
  if (!successor) console.log('WARNING : nothing names a replacement; deleting removes the last record of what this note said.')
  console.log(`write   : DELETE /api/users/0/items/${options.note}  If-Unmodified-Since-Version: ${note.version}`)
  console.log('\nThis channel cannot put an item in the trash: DELETE is permanent, the record answers 404')
  console.log('afterwards, and the trash neither grows nor keeps the key. The body cannot be recovered.')

  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write to erase the note.')
    return
  }

  const fresh = await readItem(options.note)
  if (!isRetired((fresh.tags ?? []).map((entry) => entry.tag))) {
    console.error(`\nREFUSED: ${options.note} is no longer retired; nothing was deleted.`)
    process.exitCode = 1
    return
  }
  if (fresh.version !== note.version) {
    console.error(`\nCONFLICT: note ${options.note} changed since this plan was read (version ${note.version} -> ${fresh.version}). Nothing was deleted.`)
    process.exitCode = 1
    return
  }

  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  writeAttempted = true
  const result = await gate.write('DELETE', `/api/users/0/items/${options.note}`, undefined, {
    'If-Unmodified-Since-Version': String(fresh.version),
  })
  if (result.status === 412) {
    console.error(`\nCONFLICT: note ${options.note} changed between the read and the delete. Nothing was deleted.`)
    process.exitCode = 1
    return
  }
  if (!isWriteAccepted(result.status)) {
    console.error(`\nThe library refused the delete (HTTP ${result.status}): ${result.text.slice(0, 300)}`)
    process.exitCode = 1
    return
  }
  const gone = await localRequest('GET', `/api/users/0/items/${options.note}`)
  if (gone.status !== 404) {
    console.error(`\nREAD-BACK MISMATCH: the library accepted the delete but ${options.note} still answers ${gone.status}.`)
    process.exitCode = 1
    return
  }
  console.log(`\nOK - note ${options.note} is erased. It answers 404, and the trash does not hold it.`)
  if (claim.token) console.log(`§${claim.token} is free again; a later note may claim it.`)
}

const USAGE =
  'usage: node tools/zotero-section-note.mjs --item <recordKey> [--plan] [--json]\n' +
  '       node tools/zotero-section-note.mjs --item <recordKey> --section <ordinal> (--text "<html>" | --file <path>)\n' +
  '                                       [--replaces <retiredNoteKey>] [--acknowledge-unknown "<what you read>"] [--write]\n' +
  '       node tools/zotero-section-note.mjs --claim --note <noteKey> --section <ordinal> [--write]\n' +
  '       node tools/zotero-section-note.mjs --unclaim --note <noteKey> --section <ordinal> [--write]\n' +
  '       node tools/zotero-section-note.mjs --rewrite --note <noteKey> (--text "<html>" | --file <path>) [--section <ordinal>] [--write]\n' +
  '       node tools/zotero-section-note.mjs --repair --note <noteKey> (--text "<html>" | --file <path>) --reason "<why>"\n' +
  '                                       --mechanical|--substantive [--write]\n' +
  '       node tools/zotero-section-note.mjs --retire --note <noteKey> --reason "<why>" [--write]\n' +
  '       node tools/zotero-section-note.mjs --retire --note <noteKey> --undo [--write]\n' +
  '       node tools/zotero-section-note.mjs --review --note <noteKey> [--undo] [--write]\n' +
  '       node tools/zotero-section-note.mjs --delete --note <noteKey> [--write]\n' +
  '       node tools/zotero-section-note.mjs --batch <manifest.json> [--write]\n' +
  '       Identity is a tag: /section-N claims a top-level section, /imported marks an import that may\n' +
  '       still be rewritten, /agent-note marks a body an agent wrote from the paper, /reviewed marks the\n' +
  '       owner accepting that body, /repaired marks a body corrected in place, /digest is a LEGACY\n' +
  '       whole-paper summary from an earlier version, /retired takes a note out of service. No invisible\n' +
  '       marker is written or read, and no prose is parsed: a note with no /section- tag is UNKNOWN and\n' +
  '       is read before anything is written.\n' +
  '       --repair corrects a record in place and keeps its key, claim and provenance; a changed claim is\n' +
  '       a retirement and a replacement. --mechanical keeps /reviewed, --substantive clears it.\n' +
  '       --tidy does not exist; a damaged body is repaired by the agent or retired and written again.\n' +
  '       --unclaim removes ONE /section- tag and only from a note carrying more than one: it resolves\n' +
  '       ambiguity, never a disagreement with a single claim.\n' +
  '       --delete erases only a /retired note, permanently: this API has no trash, and the plan states\n' +
  '       that before --write is accepted.\n' +
  '       --batch takes one JSON array of entries, each {"item", "section", "text" or "file",\n' +
  '       "replaces"?, "acknowledgeUnknown"?}; relative "file" paths resolve against the manifest\'s\n' +
  '       directory, and no file name is read as a protocol. Every entry is planned, refused and read\n' +
  '       back exactly as a single --section is, and the run stops at the first entry it cannot confirm,\n' +
  '       printing what was done and what was not attempted.\n' +
  '       Exit 0 = written and read back | 1 = refused, nothing written | 2 = usage |\n' +
  '       3 = sent or written but NOT confirmed - read the record before retrying, never resend.'

function parseArgs(argv) {
  const options = {
    item: '', note: '', section: '', text: '', file: '', reason: '', replaces: '', acknowledgeUnknown: '', batch: '',
    claim: false, unclaim: false, rewrite: false, repair: false, delete: false, retire: false, review: false,
    mechanical: false, substantive: false, undo: false,
    plan: false, json: false, write: false,
  }
  const valued = new Set(['--item', '--note', '--section', '--text', '--file', '--reason', '--replaces', '--acknowledge-unknown', '--batch'])
  const switches = new Set(['--claim', '--unclaim', '--rewrite', '--repair', '--delete', '--retire', '--review', '--mechanical', '--substantive', '--undo', '--plan', '--json', '--write'])
  const keyOf = (flag) => flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (switches.has(flag)) {
      options[keyOf(flag)] = true
      continue
    }
    if (!valued.has(flag)) throw new UsageError(`unrecognised argument '${flag}'`)
    const next = argv[index + 1]
    if (next === undefined) throw new UsageError(`${flag} needs a value`)
    options[keyOf(flag)] = next
    index += 1
  }

  const modes = ['claim', 'unclaim', 'rewrite', 'repair', 'delete', 'retire', 'review'].filter((mode) => options[mode])
  if (modes.length > 1) throw new UsageError('pass at most one of --claim, --unclaim, --rewrite, --repair, --delete, --retire, --review')
  if (options.undo && !options.retire && !options.review) throw new UsageError('--undo belongs to --retire or --review')
  if (options.reason && !options.retire && !options.repair) throw new UsageError('--reason belongs to --retire or --repair')
  if ((options.mechanical || options.substantive) && !options.repair) throw new UsageError('--mechanical and --substantive belong to --repair')
  if (options.replaces && !options.section) throw new UsageError('--replaces goes with the --section it replaces')
  if (options.acknowledgeUnknown && !options.section) throw new UsageError('--acknowledge-unknown belongs to a --section create')
  if (options.json && (modes.length || options.section || options.text || options.file || options.replaces || options.note)) {
    throw new UsageError('--json prints the coverage plan; it goes with --item and nothing else')
  }

  if (options.batch) {
    const extra = [
      options.item && '--item', options.note && '--note', options.section && '--section',
      options.text && '--text', options.file && '--file', options.reason && '--reason',
      options.replaces && '--replaces', options.acknowledgeUnknown && '--acknowledge-unknown',
      options.plan && '--plan', options.json && '--json', options.undo && '--undo',
      options.mechanical && '--mechanical', options.substantive && '--substantive',
      ...modes.map((mode) => `--${mode}`),
    ].filter(Boolean)
    if (extra.length) {
      throw new UsageError(`--batch carries its own item, section and body for every entry; drop ${extra.join(', ')}`)
    }
    return options
  }

  if (options.claim) {
    if (!options.note) throw new UsageError('--claim takes --note <noteKey>')
    if (!options.section) throw new UsageError('--claim takes --section <ordinal>')
    if (options.item || options.text || options.file || options.reason || options.replaces || options.plan || options.acknowledgeUnknown) {
      throw new UsageError('--claim changes one note and nothing else; drop the other arguments')
    }
    return options
  }
  if (options.unclaim) {
    if (!options.note) throw new UsageError('--unclaim takes --note <noteKey>')
    if (!options.section) throw new UsageError('--unclaim takes --section <ordinal>: the tag to remove')
    if (options.item || options.text || options.file || options.reason || options.replaces || options.plan || options.acknowledgeUnknown) {
      throw new UsageError('--unclaim changes one note and nothing else; drop the other arguments')
    }
    return options
  }
  if (options.repair) {
    if (!options.note) throw new UsageError('--repair takes --note <noteKey>')
    if (Boolean(options.text) === Boolean(options.file)) throw new UsageError('pass --text or --file, not both')
    if (String(options.reason).trim() === '') {
      throw new UsageError('--repair needs --reason "<why>": the reason is the record of the correction, and this tool stores no prose on the note')
    }
    if (options.mechanical === options.substantive) {
      throw new UsageError('--repair takes exactly one of --mechanical (keeps the owner acceptance) or --substantive (clears it)')
    }
    if (options.item || options.section || options.replaces || options.plan || options.acknowledgeUnknown || options.undo) {
      throw new UsageError('--repair corrects one note and nothing else; drop the other arguments (a changed claim is a retirement and a replacement)')
    }
    return options
  }
  if (options.rewrite) {
    if (!options.note) throw new UsageError('--rewrite takes --note <noteKey>')
    if (Boolean(options.text) === Boolean(options.file)) throw new UsageError('pass --text or --file, not both')
    if (options.item || options.reason || options.replaces || options.plan || options.acknowledgeUnknown) {
      throw new UsageError('--rewrite changes one note and nothing else; drop the other arguments')
    }
    return options
  }
  if (options.review) {
    if (!options.note) throw new UsageError('--review takes --note <noteKey>')
    if (options.item || options.section || options.text || options.file || options.reason || options.replaces || options.plan || options.acknowledgeUnknown) {
      throw new UsageError('--review changes one note and nothing else; drop the other arguments')
    }
    return options
  }
  if (options.delete) {
    if (!options.note) throw new UsageError('--delete takes --note <noteKey>')
    if (options.item || options.section || options.text || options.file || options.reason || options.replaces || options.plan || options.acknowledgeUnknown) {
      throw new UsageError('--delete takes one note and nothing else; drop the other arguments')
    }
    return options
  }
  if (options.retire) {
    if (!options.note) throw new UsageError('--retire takes --note <noteKey>')
    if (!options.undo && String(options.reason).trim() === '') {
      throw new UsageError('--retire needs --reason "<why>": the reason is the record of the change, and this tool stores no prose on the note')
    }
    if (options.item || options.section || options.text || options.file || options.replaces || options.plan || options.acknowledgeUnknown) {
      throw new UsageError('--retire changes one note and nothing else; drop the other arguments')
    }
    return options
  }
  if (options.plan) {
    if (!options.item) throw new UsageError('--plan takes --item <recordKey>')
    if (options.section || options.text || options.file || options.replaces || options.note || options.write || options.acknowledgeUnknown) {
      throw new UsageError('--plan prints a record; it does not take a body or a write')
    }
    return options
  }
  if (options.section) {
    if (!options.item) throw new UsageError('a --section write takes --item <recordKey>')
    if (Boolean(options.text) === Boolean(options.file)) throw new UsageError('pass --text or --file, not both')
    return options
  }
  if (options.acknowledgeUnknown) throw new UsageError('--acknowledge-unknown belongs to a --section create')
  if (options.note) throw new UsageError('--note belongs to --claim, --unclaim, --rewrite, --repair, --review, --delete or --retire')
  if (!options.item) throw new UsageError('pass --item <recordKey>, or one of --claim/--unclaim/--rewrite/--repair/--review/--delete/--retire')
  if (options.write) throw new UsageError('--write belongs to --section or one of the note modes')
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.batch) {
    await runBatch(options)
    return
  }
  if (options.claim) {
    await runClaim(options)
    return
  }
  if (options.unclaim) {
    await runUnclaim(options)
    return
  }
  if (options.rewrite) {
    await runRewrite(options)
    return
  }
  if (options.repair) {
    await runRepair(options)
    return
  }
  if (options.review) {
    await runReview(options)
    return
  }
  if (options.delete) {
    await runDelete(options)
    return
  }
  if (options.retire) {
    await runRetire(options)
    return
  }
  if (options.plan || options.json || !options.section) {
    await runPlan(options.item, { json: options.json })
    return
  }
  await runCreate(options)
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint && wantsHelp(process.argv.slice(2))) {
  process.exitCode = reportHelp(USAGE)
} else if (isEntryPoint) {
  main().catch((error) => {
    const code = reportFailure(error, { usage: USAGE })
    if (code === 1 && writeAttempted && !error.refused) {
      console.error('OUTCOME UNKNOWN: a write had been sent before this error, so exit 1 would claim')
      console.error('nothing was written. Do not resend it: re-run the plan (--item <recordKey>) and read')
      console.error('the record. This is exit 3, the answer for a write that may exist.')
      process.exitCode = 3
      return
    }
    process.exitCode = code
  })
}
