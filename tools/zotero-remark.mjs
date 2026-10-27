#!/usr/bin/env node
// Replace ONE line of one record's `extra` field - the `remark:` line - and carry every other line
// over untouched.
//
// WHY THIS FILE EXISTS
//
// The owner keeps a one-line digest of each paper in `extra`: a bracketed verdict, a few phrases naming
// what the paper does, and sometimes a sentence of his own. `zotero-edit.mjs --set extra=...` would
// replace the WHOLE field, so the caller would rebuild the `rate:`, `titleTranslation:` and `ISSN:`
// lines from memory - and one dropped line is a silent loss that nothing in the field would ever show.
//
// WHAT THIS TOOL ASSUMES ABOUT THE LINE: NOTHING
//
// It does not parse phrases, does not decide where an evaluation begins, and does not require the
// owner's usual shape. The caller hands it the whole new value and the exact value it replaces, so any
// line is expressible - including one whose sentence sits in the middle. That was a deliberate trade
// (2026-10-25, docs/decisions.md #96): an accounting form that made the caller name "the part I keep"
// could prove the sentence survived, but it also fixed the line's shape to prefix + phrases + tail.
// The owner chose a tool that assumes no shape over one that enforces a shape.
//
// WHAT IS THEREFORE NOT PROVEN: that the caller kept the words it did not mean to change. Two cheap
// things remain, and both are printed rather than enforced - the exact old value must be quoted back
// (so a line read from an earlier round is refused), and the dry run prints old and new side by side,
// calling out a changed verdict, because the verdict is the owner's and not the agent's.
//
// Usage:
//   node tools/zotero-remark.mjs --item <itemKey>                                    # read the line, split
//   node tools/zotero-remark.mjs --item <key> --new-line "<whole new value>" --expect-current "<exact old value>"
//   node tools/zotero-remark.mjs --item <key> --new-line "<whole new value>" --create --write
//
// Exit codes: 0 applied and read back, or nothing to do | 1 refused, nothing written | 2 usage |
// 3 sent or written but unconfirmed - the record may already carry the change, so read it, do not
// resend it.
import { APP_NAME, createWriteGate, mayHaveLanded, patchItem, readItem, reportUnconfirmed } from './zotero-local-api.mjs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Refusal, UsageError, reportFailure } from './refusal.mjs'

/** Set immediately before the PATCH is sent, so a failure after that point is never called a refusal. */
let writeAttempted = false

/**
 * The line this tool owns, up to and including the space after its label.
 *
 * The space belongs to the label rather than to the value: a record its owner typed as `remark: （…）`
 * must not come back as `remark:（…）`. Case-insensitive and tolerant of the full-width colon, because
 * the field is free text its owner types - and a `remark：` this tool failed to recognise would make
 * `--create` add a SECOND line instead of rewriting the one that is there.
 */
export const REMARK_LINE = /^([ \t]*)remark[ \t]*[:：][ \t]*/i

/** A bracketed verdict at the start of the line: full-width `（一般）` or half-width `(一般)`. */
export const VERDICT_PREFIX = /^[ \t]*[（(][^）)]*[）)]/

/**
 * Split text into lines, keeping the terminator it used.
 *
 * Rejoining with `\n` would rewrite every line of a field that arrived with `\r\n`, and the read-back
 * would then report a change the caller never asked for. Pure.
 *
 * @param {string} text The field's value.
 * @returns {{lines: string[], eol: string}} The lines, and the terminator to join them with.
 */
export function splitLines(text) {
  const value = String(text ?? '')
  const eol = value.includes('\r\n') ? '\r\n' : '\n'
  return { lines: value.split(/\r?\n/), eol }
}

/**
 * The verdict prefix and the rest of a remark line. Read-only display: the write does not use it to
 * decide anything, because deciding is the caller's.
 *
 * @param {string} value The line's value, after the `remark:` label.
 * @returns {{prefix: string, body: string}} The bracketed verdict (empty when there is none) and
 *   everything after it.
 */
export function splitRemarkValue(value) {
  const text = String(value ?? '')
  const match = VERDICT_PREFIX.exec(text)
  if (match === null) return { prefix: '', body: text }
  return { prefix: match[0], body: text.slice(match[0].length) }
}

/**
 * Where two strings stop agreeing, as a one-based character position. Pure.
 *
 * @param {string} left One string.
 * @param {string} right The other.
 * @returns {number} The position of the first difference, or the shorter length + 1.
 */
export function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index + 1
  }
  return limit + 1
}

/**
 * The whole `extra` value after rewriting (or adding) the remark line.
 *
 * No shape is assumed about the line: `nextValue` is whatever the caller wants it to say. What is
 * checked is structural - the value must fit on one line, an existing line must be quoted back exactly
 * before it may be replaced, and a record with more than one candidate is refused because "which one is
 * the digest" is not a decision this tool makes.
 *
 * @param {object} input
 * @param {string} input.extra The record's current `extra` value.
 * @param {string} input.nextValue The line's whole next value, after the `remark:` label.
 * @param {string} [input.expectCurrent] The line's exact current value; required to replace one.
 * @param {boolean} [input.create] Whether a missing remark line may be added.
 * @returns {{extra: string, index: number, created: boolean, previous: string}} The next field value,
 *   what happened, and the value that was replaced (empty when created).
 * @throws {UsageError} When `nextValue` would break the line into more than one.
 * @throws {Refusal} For no line without `--create`, for more than one, or when the quoted value is not
 *   what the record says.
 */
export function planLine({ extra, nextValue, expectCurrent = null, create = false }) {
  if (/\r|\n/.test(nextValue)) {
    throw new UsageError('--new-line must be one line: a line break would split the digest into two lines of extra')
  }
  const { lines, eol } = splitLines(extra)
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    if (REMARK_LINE.test(lines[index])) found.push(index)
  }
  if (found.length > 1) {
    throw new Refusal(`this record carries ${found.length} remark lines; which one is the digest is not a decision this tool makes.`, {
      fix: 'settle it in the reference manager, then run this again - a line this tool cannot tell apart from the digest is not one it may rewrite.',
    })
  }
  if (found.length === 0) {
    if (expectCurrent !== null) {
      throw new Refusal('this record has no remark line, so --expect-current has nothing to be checked against.', {
        fix: 'read the record again: either the line is there under a label this tool does not recognise, or --create is what adds the first one.',
      })
    }
    if (!create) {
      throw new Refusal('this record has no remark line in its extra field, and --create was not given.', {
        fix: 'run again with --create to add the line, or write it in the application first and then let this tool rewrite it.',
      })
    }
    const line = `remark: ${nextValue}`
    const next = lines.length === 1 && lines[0] === '' ? line : `${line}${eol}${lines.join(eol)}`
    return { extra: next, index: 0, created: true, previous: '' }
  }
  const index = found[0]
  const label = REMARK_LINE.exec(lines[index])[0]
  const previous = lines[index].slice(label.length)
  if (expectCurrent === null) {
    throw new Refusal('replacing a line needs --expect-current: quote the value you are replacing, exactly as --item printed it.', {
      fix: 'replacing without reading is how a line from an earlier round overwrites the owner’s current words. Read it, then quote it.',
    })
  }
  if (previous !== expectCurrent) {
    throw new Refusal(
      `--expect-current is not what this line says: the record has ${previous.length} characters, the quoted value has ` +
        `${expectCurrent.length}, and they first differ at character ${firstDifference(previous, expectCurrent)}.`,
      { fix: 'read the line again with --item and quote that answer verbatim; the record is the one that decides.' },
    )
  }
  const next = [...lines]
  next[index] = `${label}${nextValue}`
  return { extra: next.join(eol), index, created: false, previous }
}

/**
 * The verdict of each value, for the one printed notice this tool still owes the owner. Pure.
 *
 * @param {string} before The line's current value.
 * @param {string} after The line's next value.
 * @returns {string} One line naming the change, or an empty string when the verdict did not move.
 */
export function verdictNotice(before, after) {
  const oldPrefix = splitRemarkValue(before).prefix
  const newPrefix = splitRemarkValue(after).prefix
  if (oldPrefix === newPrefix) return ''
  const say = (prefix) => (prefix === '' ? 'none' : prefix)
  return `NOTE: the verdict changed, ${say(oldPrefix)} -> ${say(newPrefix)}. The verdict is the owner's, not the agent's check to change.`
}

const USAGE =
  'usage: node tools/zotero-remark.mjs --item <key>                                     # read the line\n' +
  '       node tools/zotero-remark.mjs --item <key> --new-line "<whole value>" --expect-current "<exact current value>" [--write]\n' +
  '       node tools/zotero-remark.mjs --item <key> --new-line "<whole value>" --create [--write]'

function parseArgs(argv) {
  const options = { key: '', newLine: null, expectCurrent: null, create: false, write: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--write' || flag === '--create') {
      if (flag === '--write') options.write = true
      else options.create = true
      continue
    }
    if (!['--item', '--new-line', '--expect-current'].includes(flag)) {
      throw new UsageError(`unrecognised argument '${flag}'`)
    }
    const next = argv[index + 1]
    if (next === undefined) throw new UsageError(`${flag} needs a value`)
    if (flag === '--item') options.key = next
    if (flag === '--new-line') options.newLine = next
    if (flag === '--expect-current') options.expectCurrent = next
    index += 1
  }
  if (!options.key) throw new UsageError('pass --item <key>')
  if (options.write && options.newLine === null) throw new UsageError('--write needs --new-line: a read is never a write')
  return options
}

/** The labelled read-only view of one record's remark line and the lines this tool leaves alone. */
function printState(data, key) {
  const { lines } = splitLines(data.extra ?? '')
  const remark = lines.find((line) => REMARK_LINE.test(line))
  console.log(`item       : ${key}  [${data.itemType}]  "${data.title ?? ''}"`)
  if (remark === undefined) {
    console.log('remark     : (none - this record has no remark line in its extra field)')
    if ((data.extra ?? '').trim() !== '') {
      console.log('other      : the extra field holds these lines, which a write would leave alone')
      for (const line of lines.filter((entry) => entry.trim() !== '')) console.log(`             ${line}`)
    }
    return
  }
  const label = REMARK_LINE.exec(remark)[0]
  const value = remark.slice(label.length)
  const { prefix, body } = splitRemarkValue(value)
  console.log(`remark     : ${value}`)
  console.log(`prefix     : ${prefix === '' ? '(none)' : prefix}`)
  console.log(`body       : ${body === '' ? '(empty)' : body}`)
  console.log('shape      : nothing is inferred here; --new-line takes the whole value and --expect-current must quote this one')
  const rate = lines.find((line) => /^[ \t]*rate[ \t]*[:：]/i.test(line))
  const others = lines.filter((line) => line !== remark && line !== rate && line.trim() !== '')
  for (const line of others) console.log(`other      : ${line}`)
  if (rate !== undefined) console.log(`rate       : ${rate.replace(/^[ \t]*rate[ \t]*[:：]/i, '').trim()}`)
}

async function runRead(options) {
  const gate = createWriteGate({ appName: APP_NAME })
  const info = await gate.open()
  const data = await readItem(options.key)
  console.log(`library    : Zotero ${info.version} · server ${info.id}`)
  printState(data, options.key)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.newLine === null) {
    await runRead(options)
    return
  }
  const gate = createWriteGate({ appName: APP_NAME })
  const info = await gate.open()
  const before = await readItem(options.key)
  const plan = planLine({
    extra: before.extra ?? '',
    nextValue: options.newLine,
    expectCurrent: options.expectCurrent,
    create: options.create,
  })

  console.log(`library    : Zotero ${info.version} · server ${info.id}`)
  console.log(`item       : ${options.key}  [${before.itemType}]  "${before.title ?? ''}"`)
  console.log(`version    : ${before.version}`)
  if (plan.created) console.log('remark     : (none)  ->  a new line, placed first in extra')
  else console.log(`remark     : ${plan.previous}`)
  console.log(`     ->    : ${options.newLine}`)
  const notice = verdictNotice(plan.previous, options.newLine)
  if (notice !== '') console.log(notice)

  if (plan.extra === (before.extra ?? '')) {
    console.log('\nNo change: the line already reads exactly as asked. Nothing to write.')
    return
  }
  console.log(`body       : ${JSON.stringify({ extra: plan.extra })}`)
  console.log(`write      : PATCH /api/users/0/items/${options.key}  If-Unmodified-Since-Version: ${before.version}`)
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write; the reference manager will then')
    console.log('ask you to Allow the write, and is asked once.')
    return
  }

  const result = await patchItem({
    gate,
    key: options.key,
    patch: { extra: plan.extra },
    apply: true,
    beforeWrite: () => {
      writeAttempted = true
    },
  })
  if (result.conflict) {
    console.error(`\nCONFLICT: item ${options.key} changed since this plan was read. Nothing was written.`)
    console.error(`  version : ${result.before?.version}`)
    console.error(`  extra   : ${JSON.stringify(result.before?.extra ?? '')}`)
    console.error('Read the record again and rebuild the plan from what it says now.')
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    if (mayHaveLanded(result.status)) {
      const after = await readItem(options.key).catch(() => null)
      const found = after === null
        ? 'The re-read that would settle it failed as well.'
        : String(after.extra ?? '') === plan.extra
          ? 'A re-read shows the line already as sent: the write landed.'
          : 'A re-read does not show the line as sent; the library may still have applied it.'
      process.exitCode = reportUnconfirmed({
        key: options.key,
        what: `the remark rewrite on ${options.key} answered HTTP ${result.status}${result.detail ? ` (${result.detail.slice(0, 200)})` : ''}`,
        found,
      })
      return
    }
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    process.exitCode = 1
    return
  }
  const after = result.after
  if (String(after?.extra ?? '') !== plan.extra) {
    process.exitCode = reportUnconfirmed({
      key: options.key,
      what: `the library accepted the remark rewrite and the record does not read back as sent (version ${after?.version})`,
      found: 'Nothing further was changed. Read the extra field before deciding: a line the owner wrote may be what is there.',
    })
    return
  }
  console.log(`\nOK - ${options.key} now reads back with the new line, and every other line of extra is unchanged (version ${after?.version}).`)
}

// NOT `await main()`: this module exports pure functions its self-test imports, and a pending
// top-level await would leave an importable module mid-evaluation.
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  main().catch((error) => {
    const code = reportFailure(error, { usage: USAGE })
    if (code === 1 && writeAttempted && !error.refused) {
      process.exitCode = reportUnconfirmed({
        key: '',
        what: 'the change was sent and then the connection failed: OUTCOME UNKNOWN',
        found: 'The PATCH may have been applied. Read the record before trying again.',
      })
      return
    }
    process.exitCode = code
  })
}
