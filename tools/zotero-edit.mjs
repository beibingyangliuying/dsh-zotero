#!/usr/bin/env node
// Edit a record's own fields and tags in the reference library, and keep the library's trash in order:
// one plan, one write per record.
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
// A creator list cannot be stated as one `field=value` line: it is names AND creator types, and a
// silently mangled name is invisible in the library's own list view. It is therefore stated as the
// WHOLE list with `--set-creators`, so the change reads as old list -> new list before it is sent,
// and read back against that list afterwards - the one edit here that cannot be expressed as a field.
// `itemType` decides which fields exist at all, so changing it leaves the record carrying fields its
// new type does not have. `key` and `version` belong to the library. Attachments, notes, and an
// item's filing are other tools' jobs. The library is the right place to change those.
//
// Usage:
//   node tools/zotero-edit.mjs --item <itemKey> --set title="A new title"           # dry run
//   node tools/zotero-edit.mjs --item <itemKey> --set DOI=10.xxxx/yyyy --write
//   node tools/zotero-edit.mjs --item <itemKey> --set DOI=                        # clear a field
//   node tools/zotero-edit.mjs --item <itemKey> --set-creators "author:Last, First; editor:Last, First"
//   node tools/zotero-edit.mjs --item <itemKey> --add-tag /done --remove-tag /unread --write
//   node tools/zotero-edit.mjs --item <k1,k2> --add-tag /reviewed --write   # one patch, every record
//   node tools/zotero-edit.mjs --note <noteKey> --text '<p>new body</p>' --write
//   node tools/zotero-edit.mjs --restore <itemKey> --write                  # whole Trash subtree
//   node tools/zotero-edit.mjs --purge-tag /stale --write                   # library-wide tag delete
//
// Exit codes: 0 applied and read back, or nothing to do | 1 refused, nothing written | 2 usage |
// 3 sent or written but unconfirmed - the record may already carry the change, so read it, do not
// resend it.
import {
  APP_NAME,
  childrenOf,
  createWriteGate,
  creatorTypesForType,
  fieldNamesForType,
  getJson,
  isWriteAccepted,
  libraryVersion,
  mayHaveLanded,
  normalizeTags,
  patchItem,
  readItem,
  reportUnconfirmed,
} from './zotero-local-api.mjs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Refusal, UsageError, reportFailure, reportHelp, wantsHelp } from './refusal.mjs'

/** The reader, named in a `fix` line only as an absolute, runnable path. */
const READ_TOOL = fileURLToPath(new URL('./zotero-read.mjs', import.meta.url))

/** An item key as the library writes it. */
const KEY_SHAPE = /^[A-Z0-9]{8}$/

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
  'publisher',
  'place',
  'edition',
  'series',
  'seriesNumber',
  'numberOfVolumes',
  'institution',
  'organization',
  'conferenceName',
  'proceedingsTitle',
  'number',
  'reportType',
  'shortTitle',
  'ISBN',
  'ISSN',
  'rights',
  'archive',
  'archiveLocation',
  'libraryCatalog',
  'callNumber',
]

/** Fields a caller may plausibly try, each with the reason it is not a one-line edit. */
export const REFUSED_FIELDS = {
  creators: 'a creator list is structured (names and creator types); state the whole list with --set-creators',
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
 * One creator as a single line: `type: name`.
 *
 * A two-field creator is written `Last, First`; a single-field one (`name`) is written as it stands,
 * with no comma. The same function reads back the library's answer, so the comparison after a write is
 * made in exactly the form the user typed.
 *
 * @param {object} creator A Zotero creator: `{creatorType, lastName, firstName}` or `{creatorType, name}`.
 * @returns {string} `type: Last, First`, or `type: name` for a single-field creator.
 */
export function formatCreator(creator) {
  const type = creator?.creatorType || 'author'
  const name = creator?.name || [creator?.lastName, creator?.firstName].filter(Boolean).join(', ')
  return `${type}: ${name}`
}

/**
 * Read one `--set-creators` value into a creator list.
 *
 * The form is the one a reader writes on paper: `author:Last, First; editor:Last, First`. A comma
 * marks the end of the family name - which is exactly the marker that was missing when a fifth author
 * was stored as `Carlos de la Llera, Juan` instead of `de la Llera, Juan Carlos`. A line with no comma
 * is a SINGLE-FIELD name (`{name}`), not a guess at where the family name ends: splitting
 * `World Health Organization` into a family name would be the same mistake in the other direction.
 *
 * @param {string} text The flag value; `''` is an empty list, which clears every creator.
 * @returns {object[]} Creators for the item's `creators` field, in order.
 * @throws {UsageError} When a line states a type and no name.
 */
export function parseCreatorList(text) {
  return String(text ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const split = part.indexOf(':')
      const creatorType = split === -1 ? 'author' : part.slice(0, split).trim().toLowerCase()
      const name = split === -1 ? part : part.slice(split + 1).trim()
      if (name === '') throw new UsageError(`--set-creators takes 'type: Last, First', got '${part}'`)
      const comma = name.indexOf(',')
      return comma === -1
        ? { creatorType, name }
        : { creatorType, lastName: name.slice(0, comma).trim(), firstName: name.slice(comma + 1).trim() }
    })
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
 * Read `--item`/`--restore` values into one ordered key list.
 *
 * @param {string[]} raws Raw flag values, each comma-separated; repeated flags are allowed.
 * @returns {string[]} Distinct keys in first-seen order.
 * @throws {UsageError} For a value that is not an 8-character item key.
 */
export function parseItemKeys(raws) {
  const keys = []
  for (const raw of raws) {
    for (const part of String(raw ?? '').split(',')) {
      const key = part.trim()
      if (!KEY_SHAPE.test(key)) {
        throw new UsageError(`not an item key: '${key}' (eight uppercase letters or digits)`)
      }
      if (!keys.includes(key)) keys.push(key)
    }
  }
  return keys
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

/**
 * Whether the library marks a record as trashed.
 *
 * The local API answers `true` for a boolean field and `1` for the numeric form; both mean trashed,
 * and the string `'1'` appears in some builds' `format=json` rows.
 *
 * @param {unknown} value The `deleted` field of one record.
 * @returns {boolean} True when the record sits in the trash.
 */
export function isDeleted(value) {
  return value === true || value === 1 || value === '1'
}

/**
 * Read one record and everything filed under it, remembering which nodes sit in the trash.
 *
 * The graph is what the library holds, not what this file wants it to hold: a parent may be live while
 * a child is trashed, and a restore has to put every trashed node back, children first.
 *
 * @param {string} key An 8-character item key, live or trashed.
 * @returns {Promise<object>} `{key, version, itemType, title, deleted, children}`.
 */
export async function readTrashGraph(key) {
  const record = await readItem(key)
  const children = await childrenOf(key)
  const graph = {
    key: record.key ?? key,
    version: record.version,
    itemType: record.itemType,
    title: record.title ?? '',
    deleted: isDeleted(record.deleted),
    children: [],
  }
  for (const child of children) graph.children.push(await readTrashGraph(child.key))
  return graph
}

/**
 * Every node of a trash graph, children before their parent.
 *
 * Restoring a parent before its children leaves the children filed under a record that is still
 * trashed, so the write order is the order this returns.
 *
 * @param {object} graph A graph from {@link readTrashGraph}.
 * @returns {object[]} The nodes without their `children` lists, deepest first.
 */
export function flattenTrashGraph(graph) {
  return [...graph.children.flatMap(flattenTrashGraph), { ...graph, children: undefined }]
}

/**
 * Which single maintenance action the flags ask for.
 *
 * @param {object} options Parsed flags.
 * @returns {'edit'|'restore'|'note'|'purge'} The action.
 * @throws {UsageError} When none or more than one action is asked for, or a flag does not belong to it.
 */
export function resolveAction(options) {
  const chosen = [
    options.sets.length + options.add.length + options.remove.length > 0 || (options.creators ?? null) !== null
      ? 'edit'
      : '',
    options.restore.length > 0 ? 'restore' : '',
    options.note ? 'note' : '',
    options.purgeTags.length > 0 ? 'purge' : '',
  ].filter(Boolean)
  if (chosen.length === 0) {
    throw new UsageError(
      'pass one action: --set/--set-creators/--add-tag/--remove-tag, --restore, --note with --text, or --purge-tag',
    )
  }
  if (chosen.length > 1) throw new UsageError(`pass ONE action, not ${chosen.join(' + ')}`)
  const [action] = chosen
  if (action === 'edit' && options.items.length === 0) throw new UsageError('pass --item <key>')
  if (action !== 'edit' && options.items.length > 0) throw new UsageError(`--item does not apply to --${action}`)
  if (action === 'note' && options.text === null) throw new UsageError('pass --text <html> with --note <key>')
  if (action !== 'note' && options.text !== null) throw new UsageError('--text only applies to --note')
  return action
}

const USAGE =
  'usage: node tools/zotero-edit.mjs --item <key[,key...]> [--set field=value ...] [--add-tag T] [--remove-tag T] [--write]\n' +
  '       node tools/zotero-edit.mjs --item <itemKey> --set-creators "<type>: Last, First; ..." [--write]\n' +
  '       node tools/zotero-edit.mjs --restore <key[,key...]> [--write]\n' +
  '       node tools/zotero-edit.mjs --note <key> --text <html> [--write]\n' +
  '       node tools/zotero-edit.mjs --purge-tag <tag> [--write]\n' +
  `       editable fields: ${EDITABLE_FIELDS.join(', ')}\n` +
  '       --set-creators states the WHOLE creator list, in order: a comma ends the family name, a\n' +
  '       line with no comma is a single-field name, a leading type defaults to author, and "" clears\n' +
  '       the list. It applies to one record, because a list replaced per record is not one change.'

function parseArgs(argv) {
  const options = {
    items: [],
    sets: [],
    creatorsRaw: [],
    add: [],
    remove: [],
    write: false,
    restore: [],
    note: '',
    text: null,
    purgeTags: [],
  }
  const valued = [
    '--item',
    '--set',
    '--set-creators',
    '--add-tag',
    '--remove-tag',
    '--restore',
    '--note',
    '--text',
    '--purge-tag',
  ]
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--write') {
      options.write = true
      continue
    }
    if (!valued.includes(flag)) throw new UsageError(`unrecognised argument '${flag}'`)
    const next = argv[index + 1]
    if (next === undefined) throw new UsageError(`${flag} needs a value`)
    if (flag === '--item') options.items.push(next)
    if (flag === '--set') options.sets.push(next)
    if (flag === '--set-creators') options.creatorsRaw.push(next)
    if (flag === '--add-tag') options.add.push(next)
    if (flag === '--remove-tag') options.remove.push(next)
    if (flag === '--restore') options.restore.push(next)
    if (flag === '--note') options.note = next
    if (flag === '--text') options.text = next
    if (flag === '--purge-tag') options.purgeTags.push(next)
    index += 1
  }
  if (options.creatorsRaw.length > 1) throw new UsageError('pass --set-creators once: it states one whole list')
  return {
    ...options,
    creators: options.creatorsRaw.length === 0 ? null : parseCreatorList(options.creatorsRaw[0]),
    items: parseItemKeys(options.items),
    restore: parseItemKeys(options.restore),
  }
}

/** Order two exit codes by what the caller should act on: unconfirmed outranks refused. */
function worseExit(current, next) {
  const rank = (code) => (code === 3 ? 3 : code === 1 ? 2 : 0)
  return rank(next) > rank(current) ? next : current
}

function printConflict(key, result, current) {
  console.error(`\nCONFLICT: item ${key} changed since this plan was read. Nothing was written.`)
  console.error('The library\'s current values, so the plan can be rebuilt:')
  console.error(`  version : ${current.version}`)
  for (const field of Object.keys(result.patch ?? {})) {
    if (field === 'tags') console.error(`  tags    : ${normalizeTags(current.tags).join(' · ') || 'none'}`)
    else if (field === 'creators') {
      console.error(`  creators: ${(current.creators ?? []).map(formatCreator).join(' · ') || 'none'}`)
    } else console.error(`  ${field.padEnd(7)} : ${JSON.stringify(current[field] ?? '')}`)
  }
}

/**
 * Plan and, with `write`, apply one field/tag patch to one record.
 *
 * @returns {Promise<number>} 0 planned or applied, 1 refused, 3 unconfirmed.
 */
async function editOne({ gate, key, fields, creators = null, add, remove, write, single }) {
  let before
  try {
    before = await readItem(key)
  } catch (error) {
    console.error(`item ${key}: ${error.message}`)
    return 1
  }
  const validFields = await fieldNamesForType(before.itemType)
  const invalid = invalidFields(fields, validFields)
  if (invalid.length > 0) {
    if (single) {
      throw new Refusal(`${before.itemType} has no field named ${invalid.map((field) => `'${field}'`).join(', ')}`, {
        fix: 'read the fields this item type accepts, then correct the plan',
        command: `node "${READ_TOOL}" --item-fields ${before.itemType}`,
      })
    }
    console.error(`item ${key}: ${before.itemType} has no field named ${invalid.join(', ')}; skipped`)
    return 1
  }
  const currentTags = normalizeTags(before.tags)
  const tagChange = computeTagChange(currentTags, { add, remove })
  const currentCreators = (before.creators ?? []).map(formatCreator)
  const wantedCreators = creators === null ? null : creators.map(formatCreator)
  if (creators !== null) {
    const allowed = await creatorTypesForType(before.itemType)
    const unsupported =
      allowed === null
        ? []
        : [...new Set(creators.map((creator) => creator.creatorType))].filter((type) => !allowed.includes(type))
    if (unsupported.length > 0) {
      const refusal = new Refusal(
        `${before.itemType} does not accept the creator type ${unsupported.map((type) => `'${type}'`).join(', ')}`,
        { fix: `this item type accepts ${allowed.join(', ')}` },
      )
      if (single) throw refusal
      console.error(`item ${key}: ${refusal.message}; skipped`)
      return 1
    }
  }
  const creatorsChange =
    wantedCreators !== null && JSON.stringify(wantedCreators) !== JSON.stringify(currentCreators)
  // `creators` is compared by {@link formatCreator}, not by `changedFields`: the latter stringifies an
  // array, which would print the patch as `[object Object],...` and call any list a change.
  const fieldPatch = { ...fields }
  if (!tagChange.unchanged) fieldPatch.tags = tagChange.next.map((tag) => ({ tag }))
  const patch = creators === null ? fieldPatch : { ...fieldPatch, creators }
  const changes = changedFields(before, fieldPatch)

  console.log(`\nitem    : ${key}  [${before.itemType}]  "${before.title ?? ''}"`)
  console.log(`version : ${before.version}`)

  if (changes.length === 0 && !creatorsChange) {
    console.log('No change: every value asked for is already what the record says.')
    return 0
  }
  for (const change of changes) {
    if (change.field === 'tags') {
      console.log(`tags    : ${currentTags.join(' · ') || 'none'}`)
      console.log(`       -> : ${tagChange.next.join(' · ') || 'none'}`)
      console.log(`       +  : ${tagChange.added.join(' · ') || 'none'}   -  : ${tagChange.removed.join(' · ') || 'none'}`)
    } else {
      console.log(`${change.field.padEnd(7)} : ${JSON.stringify(change.from)}`)
      console.log(`     -> : ${JSON.stringify(change.to)}`)
    }
  }
  if (creatorsChange) {
    console.log(`creators: ${currentCreators.length} now -> ${wantedCreators.length} after, in this order`)
    wantedCreators.forEach((line, index) => {
      const was = currentCreators[index]
      if (was === line) {
        console.log(`       = : ${line}`)
        return
      }
      if (was !== undefined) console.log(`       - : ${was}`)
      console.log(`       + : ${line}`)
    })
    for (let index = wantedCreators.length; index < currentCreators.length; index += 1) {
      console.log(`       - : ${currentCreators[index]}`)
    }
  }
  console.log(`body    : ${JSON.stringify(patch)}`)
  console.log(`write   : PATCH /api/users/0/items/${key}  If-Unmodified-Since-Version: ${before.version}`)

  // The re-read is compared in the same form the plan was printed in: a creator list is compared
  // line by line (the library returns objects), every other field as the string the record holds.
  const notReadBack = (record) => {
    const left = fieldsNotReadBack(record, changes, tagChange)
    if (
      creatorsChange &&
      JSON.stringify((record.creators ?? []).map(formatCreator)) !== JSON.stringify(wantedCreators)
    ) {
      left.push('creators')
    }
    return left
  }
  const changedNames = [...changes.map((change) => change.field), ...(creatorsChange ? ['creators'] : [])]

  if (!write) return 0

  const result = await patchItem({
    gate,
    key,
    patch,
    apply: true,
    beforeWrite: () => {
      writeAttempted = true
    },
  })
  if (result.conflict) {
    printConflict(key, { patch }, result.before)
    return 1
  }
  if (!result.applied) {
    if (mayHaveLanded(result.status)) {
      // The item exists either way, so the honest report names it and says what a re-read shows:
      // a 5xx after a sent PATCH is not a refusal, and "nothing was written" would invite a resend.
      const after = await readItem(key).catch(() => null)
      const left = after
        ? notReadBack(after)
        : ['the re-read failed too, so even this is unproven']
      return reportUnconfirmed({
        key,
        what: `the ${changedNames.join(', ')} change on ${key} answered HTTP ${result.status}${
          result.detail ? ` (${result.detail.slice(0, 200)})` : ''
        }`,
        found: after
          ? left.length === 0
            ? 'A re-read shows every requested value already present: the write landed.'
            : `A re-read does not show ${left.join(', ')}; the library may still have applied it.`
          : 'The re-read that would settle it failed as well.',
      })
    }
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    return 1
  }

  const after = result.after
  const mismatched = notReadBack(after)
  if (mismatched.length > 0) {
    return reportUnconfirmed({
      key,
      what: `the library accepted the change to ${mismatched.join(', ')} and the record does not read back as sent (version ${after.version})`,
      found: 'Nothing further was changed. The record holds some other value now - read it before deciding.',
    })
  }
  console.log(`OK - ${key} now reads back with every requested value (version ${after.version}).`)
  return 0
}

async function runEdit(options, gate) {
  const creators = options.creators ?? null
  if (creators !== null && options.items.length > 1) {
    throw new UsageError("--set-creators states one record's whole list; pass ONE --item")
  }
  const fields = parseSetFlags(options.sets)
  let code = 0
  for (const key of options.items) {
    code = worseExit(
      code,
      await editOne({
        gate,
        key,
        fields,
        creators,
        add: options.add,
        remove: options.remove,
        write: options.write,
        single: options.items.length === 1,
      }),
    )
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write; the reference manager will then')
    console.log('ask you to Allow the write, and is asked once per record that actually changes.')
  }
  process.exitCode = code
}

/**
 * Plan and, with `write`, restore one trashed record and every trashed node filed under it.
 *
 * @returns {Promise<number>} 0 restored or already live, 1 refused, 3 unconfirmed.
 */
async function restoreOne({ gate, key, write }) {
  let graph
  try {
    graph = await readTrashGraph(key)
  } catch (error) {
    console.error(`item ${key}: ${error.message}`)
    return 1
  }
  const nodes = flattenTrashGraph(graph)
  const trashed = nodes.filter((node) => node.deleted)
  console.log(`\nitem    : ${key}  [${graph.itemType}]  "${graph.title}"`)
  console.log(`graph   : ${nodes.length} node(s), ${trashed.length} in the trash`)
  for (const node of nodes) {
    console.log(`  ${node.deleted ? 'trash' : 'live '} ${node.key}  ${node.itemType}  v${node.version}`)
  }
  if (trashed.length === 0) {
    console.log('Nothing to restore: every node in this graph is already live.')
    return 0
  }
  for (const node of trashed) {
    console.log(`restore : PATCH /api/users/0/items/${node.key} {deleted:0}  If-Unmodified-Since-Version: ${node.version}`)
  }
  if (!write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write to put these nodes back, children first.')
    return 0
  }
  for (const node of trashed) {
    const result = await patchItem({
      gate,
      key: node.key,
      patch: { deleted: 0 },
      apply: true,
      beforeWrite: () => {
        writeAttempted = true
      },
    })
    if (result.conflict) {
      printConflict(node.key, { patch: { deleted: 0 } }, result.before)
      return 1
    }
    if (!result.applied) {
      if (mayHaveLanded(result.status)) {
        return reportUnconfirmed({
          key: node.key,
          what: `restoring ${node.key} answered HTTP ${result.status}`,
          found: 'Some nodes may already be back. Read the graph before deciding, and do not resend the whole plan.',
        })
      }
      console.error(`\nThe library refused to restore ${node.key} (HTTP ${result.status}): ${result.detail}`)
      return 1
    }
  }
  const after = flattenTrashGraph(await readTrashGraph(key))
  const stillTrashed = after.filter((node) => node.deleted).map((node) => node.key)
  const beforeKeys = nodes.map((node) => node.key).sort()
  const afterKeys = after.map((node) => node.key).sort()
  if (stillTrashed.length > 0 || JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
    return reportUnconfirmed({
      key,
      what: `the restore of ${key} was accepted but the graph does not read back cleanly`,
      found: stillTrashed.length > 0
        ? `Still in the trash: ${stillTrashed.join(', ')}.`
        : 'The node set changed between the plan and the re-read.',
    })
  }
  console.log(`\nOK - ${key} and ${nodes.length - 1} child node(s) are live (version ${graph.version} was the plan).`)
  return 0
}

async function runRestore(options, gate) {
  let code = 0
  for (const key of options.restore) code = worseExit(code, await restoreOne({ gate, key, write: options.write }))
  process.exitCode = code
}

/** Replace one note's body, read back the result, and report a mismatch honestly. */
async function runNote(options, gate) {
  const key = options.note
  const before = await readItem(key)
  if (before.itemType !== 'note') {
    throw new Refusal(`item ${key} is a ${before.itemType}, not a note`, {
      fix: 'address the note itself by its own key; zotero-read --item prints the notes a paper has',
      command: `node "${READ_TOOL}" --item ${key}`,
    })
  }
  console.log(`item    : ${key}  [note]  child of ${before.parentItem ?? 'the library root'}`)
  console.log(`version : ${before.version}`)
  if (String(before.note ?? '') === options.text) {
    console.log('No change: the note already holds exactly that text.')
    return
  }
  console.log(`body    : ${JSON.stringify(options.text)}`)
  console.log(`write   : PATCH /api/users/0/items/${key}  If-Unmodified-Since-Version: ${before.version}`)
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write to replace the note body.')
    return
  }
  const result = await patchItem({
    gate,
    key,
    patch: { note: options.text },
    apply: true,
    beforeWrite: () => {
      writeAttempted = true
    },
  })
  if (result.conflict) {
    printConflict(key, { patch: { note: options.text } }, result.before)
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    if (mayHaveLanded(result.status)) {
      process.exitCode = reportUnconfirmed({
        key,
        what: `the note update answered HTTP ${result.status}`,
        found: 'The note may already hold the new body. Read it before resending.',
      })
      return
    }
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    process.exitCode = 1
    return
  }
  if (String(result.after.note ?? '') !== options.text) {
    process.exitCode = reportUnconfirmed({
      key,
      what: `the library accepted the new note body and the record reads back differently (version ${result.after.version})`,
      found: 'Read the note before deciding; nothing further was changed.',
    })
    return
  }
  console.log(`\nOK - ${key} now reads back with the new body (version ${result.after.version}).`)
}

/**
 * Delete tags from the whole library.
 *
 * A tag exists only as long as some record carries it, so this is a library-wide operation with one
 * version precondition - not a per-record edit. The local API deletes a tag by name, which is why the
 * plan names every tag and nothing else.
 */
/**
 * Every tag name the library still holds, read back in pages so a large library is not truncated.
 *
 * @returns {Promise<string[]>} The tag names.
 */
async function tagNamesInLibrary() {
  const names = []
  for (let start = 0; ; start += 100) {
    const page = await getJson(`/api/users/0/tags?format=json&limit=100&start=${start}`)
    names.push(...page.map((row) => row.tag))
    if (page.length < 100) return names
  }
}

async function runPurge(options, gate) {
  const tags = [...new Set(options.purgeTags)]
  const probe = await libraryVersion()
  const path = `/api/users/0/tags?tag=${tags.map((tag) => encodeURIComponent(tag)).join('||')}`
  console.log(`tags    : ${tags.join(' · ')}`)
  console.log(`library : version ${probe.version}`)
  console.log(`write   : DELETE ${path}`)
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write to delete these tags from every record.')
    return
  }
  writeAttempted = true
  const res = await gate.write('DELETE', path, undefined, {
    'If-Unmodified-Since-Version': String(probe.version),
  })
  if (isWriteAccepted(res.status)) {
    const remaining = await tagNamesInLibrary().catch(() => null)
    if (remaining === null || tags.some((tag) => remaining.includes(tag))) {
      process.exitCode = reportUnconfirmed({
        key: '',
        what:
          remaining === null
            ? `the tag delete answered HTTP ${res.status} but the tags could not be re-read`
            : `the delete answered HTTP ${res.status} and ${tags.filter((tag) => remaining.includes(tag)).join(', ')} still exists`,
        found: 'Read the tag list before resending.',
      })
      return
    }
    console.log(`\nOK - ${tags.length === 1 ? 'the tag is' : 'the tags are'} gone from the library (HTTP ${res.status}).`)
    return
  }
  if (mayHaveLanded(res.status)) {
    process.exitCode = reportUnconfirmed({
      key: '',
      what: `the tag delete answered HTTP ${res.status}`,
      found: 'The library may already have deleted them; browse the tags before resending.',
    })
    return
  }
  console.error(`\nThe library refused the delete (HTTP ${res.status}): ${res.text.slice(0, 300)}`)
  process.exitCode = 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const action = resolveAction(options)
  const gate = createWriteGate({ appName: APP_NAME })
  const info = await gate.open()
  console.log(`library : Zotero ${info.version} · server ${info.id}`)
  if (action === 'edit') return runEdit(options, gate)
  if (action === 'restore') return runRestore(options, gate)
  if (action === 'note') return runNote(options, gate)
  return runPurge(options, gate)
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

if (isEntryPoint && wantsHelp(process.argv.slice(2))) {
  process.exitCode = reportHelp(USAGE)
} else if (isEntryPoint) {
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
