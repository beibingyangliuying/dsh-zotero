#!/usr/bin/env node
// Edit ONE record's own fields and tags in the reference library: one record, one write.
//
// WHY THIS FILE EXISTS
//
// The reference library reached this preset through an MCP row whose `zotero_update_item` and
// `zotero_batch_update` write whatever they are given, with no preview and no statement of what they
// are about to replace. This tool's DEFAULT is to print the change and stop, and it refuses the change
// outright if the record moved since the plan was built.
//
// WHAT IT WILL NOT CHANGE, AND WHY
//
// `creators` is a structured list of names and creator types, so a one-line value cannot express it;
// rewriting it wrongly is not visible in the library's own list view. `itemType` decides which fields
// exist at all, so changing it leaves the record carrying fields its new type does not have. `key` and
// `version` belong to the library. Attachments, notes, and an item's filing are other tools' jobs.
// The library is the right place to change all of those, with the record in front of you.
//
// Usage:
//   node tools/zotero-edit.mjs --item <itemKey> --set title="A new title"           # dry run
//   node tools/zotero-edit.mjs --item <itemKey> --set DOI=10.xxxx/yyyy --write
//   node tools/zotero-edit.mjs --item <itemKey> --set DOI=                        # clear a field
//   node tools/zotero-edit.mjs --item <itemKey> --add-tag /done --remove-tag /unread --write
//
// Exit codes: 0 applied and read back, or nothing to do | 1 refused, nothing written | 2 usage |
// 3 sent or written but unconfirmed - the record may already carry the change, so read it, do not
// resend it.
import { APP_NAME, createWriteGate, fieldNamesForType, mayHaveLanded, normalizeTags, patchItem, readItem, reportUnconfirmed } from './zotero-local-api.mjs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Refusal, UsageError, reportFailure } from './refusal.mjs'

/** The reader, named in a `fix` line only as an absolute, runnable path. */
const READ_TOOL = fileURLToPath(new URL('./zotero-read.mjs', import.meta.url))

/** Set immediately before the PATCH is sent, so a failure after that point is never called a refusal. */
let writeAttempted = false

/** What one line of `--set field=value` may change. */
export const EDITABLE_FIELDS = [
  'title',
  'DOI',
  'url',
  'date',
  'abstractNote',
  'extra',
  'publicationTitle',
  'volume',
  'issue',
  'pages',
  'language',
]

/** Fields a caller may plausibly try, each with the reason it is not a one-line edit. */
export const REFUSED_FIELDS = {
  creators: 'a creator list is structured (names and creator types); edit it in the application',
  itemType: 'the item type decides which fields exist, so changing it strands the others',
  key: 'the library owns the key',
  version: 'the library owns the version',
  tags: 'use --add-tag / --remove-tag, so the change is stated as a diff',
  collections: 'use tools/zotero-collection.mjs --assign',
  relations: 'relations are a structured list; edit them in the application',
  dateAdded: 'the library owns this',
  dateModified: 'the library owns this',
}

/**
 * The requested fields the item type does not accept.
 *
 * The whitelist in this file is item-type-agnostic; the library's schema is not. Asking the schema
 * turns a 400 into a refusal that names the field, so the plan is corrected before a write is sent.
 *
 * @param {Record<string, string>} fields The fields the plan wants to set.
 * @param {Set<string>|null} valid The type's fields, or null when the build cannot report them.
 * @returns {string[]} The field names that are not valid for this type.
 */
export function invalidFields(fields, valid) {
  if (!valid) return []
  return Object.keys(fields).filter((field) => !valid.has(field))
}

/**
 * Read `--set field=value` arguments.
 *
 * @param {string[]} assignments Raw values, each `field=value`; split on the FIRST `=` so a value may
 *   contain one, and an empty value is kept because clearing a field is a real change.
 * @returns {object} field -> value.
 * @throws {UsageError} For an unknown field, a refused field (with its reason), or a missing `=`.
 */
export function parseSetFlags(assignments) {
  const fields = {}
  for (const assignment of assignments) {
    const split = assignment.indexOf('=')
    if (split === -1) throw new UsageError(`--set takes field=value, got '${assignment}'`)
    const field = assignment.slice(0, split).trim()
    const value = assignment.slice(split + 1)
    if (REFUSED_FIELDS[field]) throw new UsageError(`--set cannot change '${field}': ${REFUSED_FIELDS[field]}`)
    if (!EDITABLE_FIELDS.includes(field)) {
      throw new UsageError(`--set takes one of ${EDITABLE_FIELDS.join(', ')}, got '${field}'`)
    }
    fields[field] = value
  }
  return fields
}

/**
 * The tag list a change produces.
 *
 * The whole list is computed and sent rather than a delta, because whether a patch's `tags` REPLACES
 * the record's tags or merges with them is not something this repository has measured - sending the
 * full list is correct either way.
 *
 * @param {string[]} current The record's tags, normalised.
 * @param {{add?: string[], remove?: string[]}} change Tags to add and to remove.
 * @returns {{next: string[], added: string[], removed: string[], unchanged: boolean}} The next list,
 *   what actually changes, and whether it is a no-op.
 */
export function computeTagChange(current, { add = [], remove = [] } = {}) {
  const next = [...current]
  const added = []
  const removed = []
  for (const tag of add) {
    if (!next.includes(tag)) {
      next.push(tag)
      added.push(tag)
    }
  }
  for (const tag of remove) {
    const at = next.indexOf(tag)
    if (at !== -1) {
      next.splice(at, 1)
      removed.push(tag)
    }
  }
  return { next, added, removed, unchanged: added.length === 0 && removed.length === 0 }
}

/**
 * Whether the record already holds what the patch asks for.
 *
 * `tags` arrives as an array of objects, and `String([{ tag: '/done' }])` is "[object Object]" for
 * every tag - comparing that way made a swap (one tag added, one removed) read as no change, and the
 * write was skipped in silence. An array is therefore compared by its normalized contents; anything
 * else keeps the plain textual comparison the read-back below also relies on.
 *
 * @param {unknown} before The record's current value.
 * @param {unknown} after The value the patch asks for.
 * @returns {boolean} True when the two differ.
 */
function differs(before, after) {
  if (Array.isArray(before) || Array.isArray(after)) {
    return JSON.stringify(normalizeTags(before ?? [])) !== JSON.stringify(normalizeTags(after ?? []))
  }
  return String(before ?? '') !== String(after ?? '')
}

/** The fields whose value would actually change, as `{field, from, to}`. */
export function changedFields(before, patch) {
  return Object.entries(patch)
    .filter(([field, value]) => differs(before[field], value))
    .map(([field, value]) => ({ field, from: String(before[field] ?? ''), to: String(value) }))
}

const USAGE =
  'usage: node tools/zotero-edit.mjs --item <key> [--set field=value ...] [--add-tag T] [--remove-tag T] [--write]\n' +
  `       editable fields: ${EDITABLE_FIELDS.join(', ')}`

function parseArgs(argv) {
  const options = { key: '', sets: [], add: [], remove: [], write: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = argv[index + 1]
    if (flag === '--write') {
      options.write = true
      continue
    }
    if (!['--item', '--set', '--add-tag', '--remove-tag'].includes(flag)) {
      throw new UsageError(`unrecognised argument '${flag}'`)
    }
    if (!next) throw new UsageError(`${flag} needs a value`)
    if (flag === '--item') options.key = next
    if (flag === '--set') options.sets.push(next)
    if (flag === '--add-tag') options.add.push(next)
    if (flag === '--remove-tag') options.remove.push(next)
    index += 1
  }
  if (!options.key) throw new UsageError('pass --item <key>')
  if (options.sets.length === 0 && options.add.length === 0 && options.remove.length === 0) {
    throw new UsageError('pass at least one --set, --add-tag or --remove-tag')
  }
  return options
}

function printConflict(key, result, current) {
  console.error(`\nCONFLICT: item ${key} changed since this plan was read. Nothing was written.`)
  console.error('The library\'s current values, so the plan can be rebuilt:')
  console.error(`  version : ${current.version}`)
  for (const field of Object.keys(result.patch ?? {})) {
    if (field === 'tags') console.error(`  tags    : ${normalizeTags(current.tags).join(' · ') || 'none'}`)
    else console.error(`  ${field.padEnd(7)} : ${JSON.stringify(current[field] ?? '')}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const fields = parseSetFlags(options.sets)
  const gate = createWriteGate({ appName: APP_NAME })
  const info = await gate.open()

  const before = await readItem(options.key)
  const validFields = await fieldNamesForType(before.itemType)
  const invalid = invalidFields(fields, validFields)
  if (invalid.length > 0) {
    throw new Refusal(`${before.itemType} has no field named ${invalid.map((field) => `'${field}'`).join(', ')}`, {
      fix: 'read the fields this item type accepts, then correct the plan',
      command: `node "${READ_TOOL}" --item-fields ${before.itemType}`,
    })
  }
  const currentTags = normalizeTags(before.tags)
  const tagChange = computeTagChange(currentTags, { add: options.add, remove: options.remove })
  const patch = { ...fields }
  if (!tagChange.unchanged) patch.tags = tagChange.next.map((tag) => ({ tag }))
  const changes = changedFields(before, patch)

  console.log(`library : Zotero ${info.version} · server ${info.id}`)
  console.log(`item    : ${options.key}  [${before.itemType}]  "${before.title ?? ''}"`)
  console.log(`version : ${before.version}`)

  if (changes.length === 0) {
    console.log('\nNo change: every value asked for is already what the record says. Nothing to write.')
    return
  }
  for (const change of changes) {
    if (change.field === 'tags') {
      console.log(`tags    : ${currentTags.join(' · ') || 'none'}`)
      console.log(`       -> : ${tagChange.next.join(' · ') || 'none'}`)
      console.log(
        `       +  : ${tagChange.added.join(' · ') || 'none'}   -  : ${tagChange.removed.join(' · ') || 'none'}`,
      )
    } else {
      console.log(`${change.field.padEnd(7)} : ${JSON.stringify(change.from)}`)
      console.log(`     -> : ${JSON.stringify(change.to)}`)
    }
  }
  console.log(`body    : ${JSON.stringify(patch)}`)
  console.log(`write   : PATCH /api/users/0/items/${options.key}  If-Unmodified-Since-Version: ${before.version}`)

  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write; the reference manager will then')
    console.log('ask you to Allow the write, and is asked once.')
    return
  }

  const result = await patchItem({
    gate,
    key: options.key,
    patch,
    apply: true,
    beforeWrite: () => {
      writeAttempted = true
    },
  })
  if (result.conflict) {
    printConflict(options.key, { patch }, result.before)
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    if (mayHaveLanded(result.status)) {
      // The item exists either way, so the honest report names it and says what a re-read shows:
      // a 5xx after a sent PATCH is not a refusal, and "nothing was written" would invite a resend.
      const after = await readItem(options.key).catch(() => null)
      const left = after
        ? fieldsNotReadBack(after, changes, tagChange)
        : ['the re-read failed too, so even this is unproven']
      process.exitCode = reportUnconfirmed({
        key: options.key,
        what: `the ${fieldsOf(changes)} change on ${options.key} answered HTTP ${result.status}${
          result.detail ? ` (${result.detail.slice(0, 200)})` : ''
        }`,
        found: after
          ? left.length === 0
            ? 'A re-read shows every requested value already present: the write landed.'
            : `A re-read does not show ${left.join(', ')}; the library may still have applied it.`
          : 'The re-read that would settle it failed as well.',
      })
      return
    }
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    process.exitCode = 1
    return
  }

  const after = result.after
  const mismatched = fieldsNotReadBack(after, changes, tagChange)
  if (mismatched.length > 0) {
    process.exitCode = reportUnconfirmed({
      key: options.key,
      what: `the library accepted the change to ${mismatched.join(', ')} and the record does not read back as sent (version ${after.version})`,
      found: 'Nothing further was changed. The record holds some other value now - read it before deciding.',
    })
    return
  }
  console.log(`\nOK - ${options.key} now reads back with every requested value (version ${after.version}).`)
}

/** The fields a change list names, in one phrase. */
function fieldsOf(changes) {
  return changes.map((change) => change.field).join(', ')
}

/**
 * The fields that do not read back as they were sent. Pure.
 *
 * A tag list is compared after normalisation, because the library reorders and dedups it; every other
 * field is compared as the string it would have been sent as.
 */
function fieldsNotReadBack(after, changes, tagChange) {
  return changes
    .filter((change) => {
      if (change.field !== 'tags') return String(after[change.field] ?? '') !== change.to
      return JSON.stringify(normalizeTags(after.tags)) !== JSON.stringify(tagChange.next)
    })
    .map((change) => change.field)
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
