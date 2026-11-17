#!/usr/bin/env node
// Create, rename, or file items into collections in the reference library: one change, one write.
//
// WHY THIS FILE EXISTS
//
// The reference library reached this preset through an MCP row whose collection tools write directly.
// This tool states the change first and refuses it if the record moved in the meantime; it also
// refuses to create a collection that already exists among its siblings, because a silently created
// duplicate is invisible in the library's own tree.
//
// WHAT THIS REPOSITORY HAS AND HAS NOT MEASURED, AND HOW THE TOOL BEHAVES BECAUSE OF IT
//
//   * [MEASURED 2026-10-16 against Zotero 10.0.6, reproduced in one run] `PATCH /collections/<key>` IS
//     accepted: `XBUY9SCY` was renamed "00 基础理论与综述" -> "00 基础理论与综述 (probe)" (version
//     1125 -> 2178) and back (-> 2179), with the name read back through a SECOND code path, and the
//     collection tree unchanged at 75 collections. An earlier run recorded the same outcome for
//     `LZ6P7MSJ`, a collection that has since been deleted - which is why the measurement was redone
//     rather than inherited. Creation and deletion were measured earlier still. `--rename` is still
//     ATTEMPTED rather than assumed, and if a library refuses it the tool SAYS SO and stops - it does
//     not fall back to "create a new one and move the items", which would quietly change the keys
//     other documents may refer to. Renaming in the application remains the fallback for a library
//     that refuses.
//   * Whether a patch's `collections` list REPLACES or MERGES with the record's own. This tool reads
//     the current list, computes the full next list and sends that, so the answer does not matter.
//   * That a collection's version is UNRELIABLE rather than absent. Measured 2026-10-15: nearly every
//     collection in this library reported version 0, so a rename could not be guarded the way an item's
//     edit is. Measured 2026-10-16: the collection renamed here reported a real version and moved it
//     (1125 -> 2178 -> 2179), so the guard is sent and works WHERE THE LIBRARY KEEPS ONE. `--rename`
//     states both cases rather than implying a guard it may not have; the patch carries only a name, so
//     no other field can be lost. Items DO carry real versions (567 where a collection said 0), which
//     is why `--assign` is guarded normally.
//
// Usage:
//   node tools/zotero-collection.mjs --list
//   node tools/zotero-collection.mjs --create "Reading list" --parent <collectionKey>   # dry run
//   node tools/zotero-collection.mjs --create "Reading list" --write
//   node tools/zotero-collection.mjs --rename <collectionKey> --name "Archive" --write  # measured 2026-10-16
//   node tools/zotero-collection.mjs --delete <collectionKey> --write
//   node tools/zotero-collection.mjs --assign <itemKey> --collection <collectionKey> --write
//   node tools/zotero-collection.mjs --assign <itemKey> --collection <collectionKey> --remove --write
//   node tools/zotero-collection.mjs --saved-search-create "Reading" --query "graph neural" --write
//   node tools/zotero-collection.mjs --saved-search-update <searchKey> --name "Reading 2026" --write
//   node tools/zotero-collection.mjs --saved-search-delete <searchKey> --write
//
// Exit codes: 0 applied and read back, or nothing to do | 1 refused, nothing written | 2 usage |
// 3 sent or written but unconfirmed - the tree or the record may already carry the change, so read it
// rather than resending it.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_NAME,
  createdItemKey,
  createWriteGate,
  getJson,
  mayHaveLanded,
  normalizeCollections,
  patchCollection,
  patchItem,
  readCollection,
  readItem,
  reportUnconfirmed,
} from './zotero-local-api.mjs'
import { Refusal, UsageError, reportFailure, reportHelp, wantsHelp } from './refusal.mjs'

/** Set immediately before a write is sent, so a failure after that point is never called a refusal. */
let writeAttempted = false

/**
 * A collection with this name already among these siblings.
 *
 * Siblings means the same parent, including both being at the root: the library allows two collections
 * with the same name under different parents, and forbidding that would forbid a real convention.
 *
 * @param {object[]} collections Collection rows as `/collections` returns them.
 * @param {{name: string, parentKey?: string}} wanted The proposed collection.
 * @returns {object|undefined} The existing sibling, if any.
 */
export function siblingWithName(collections, { name, parentKey }) {
  const wanted = name.trim().toLowerCase()
  const parent = parentKey || undefined
  return collections.find(
    (row) =>
      (row.data?.name ?? '').trim().toLowerCase() === wanted &&
      normalizeCollections(row.data?.parentCollection)[0] === parent,
  )
}

/**
 * The collection list an assignment produces.
 *
 * @param {string[]} current The record's collections, normalised.
 * @param {string} collectionKey The collection to file into or remove from.
 * @param {{remove?: boolean}} [options] Remove instead of add.
 * @returns {{next: string[], changed: boolean}} The full next list, and whether it differs.
 */
export function nextCollections(current, collectionKey, { remove = false } = {}) {
  const next = remove ? current.filter((key) => key !== collectionKey) : [...new Set([...current, collectionKey])]
  return { next, changed: JSON.stringify(next) !== JSON.stringify(current) }
}

/**
 * The condition list a --query saved search carries.
 *
 * Zotero's own saved-search form calls free text "Search terms" and stores it as one `quicksearch`
 * condition with the `contains` operator, so name plus query covers the common case. Multi-clause
 * searches wait until something asks for them, which keeps the flag surface small.
 *
 * @param {string} query Free text to match.
 * @returns {object[]} One condition in the shape `/searches` accepts.
 */
export function searchConditions(query) {
  return [{ condition: 'quicksearch', operator: 'contains', value: query }]
}

/**
 * Whether a saved search holds the conditions asked for.
 *
 * Zotero expands one `quicksearch` condition into its field/tag/note/… clauses when it stores a
 * search, so an exact comparison would call a successful create unconfirmed. A quicksearch is
 * satisfied when every clause that carries a value carries the searched term.
 *
 * @param {object[]} expected The conditions that were sent.
 * @param {object[]} actual The conditions the library reads back.
 * @returns {boolean} True when the search means the same thing.
 */
export function sameConditions(expected, actual) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return true
  if (expected.length !== 1 || expected[0].condition !== 'quicksearch') return false
  const meaningful = actual.filter((condition) => condition.value !== undefined && condition.value !== '')
  return meaningful.length > 0 && meaningful.every((condition) => condition.value === expected[0].value)
}

/**
 * A saved search flattened from either a row of `/searches` or a single `/searches/<key>`.
 *
 * @param {object} [row] The API row, whose fields may sit at the top level or under `data`.
 * @returns {{key: string, version: number, name: string, conditions: object[]}} The search.
 */
export function normalizeSearch(row = {}) {
  const data = row.data ?? row
  return {
    key: row.key ?? data.key ?? '',
    version: row.version ?? data.version ?? 0,
    name: data.name ?? '',
    conditions: Array.isArray(data.conditions) ? data.conditions : [],
  }
}

/** One line that says what a saved search matches, for plans and read-backs. */
export function describeConditions(conditions) {
  const parts = conditions.map((each) => `${each.condition} ${each.operator} "${each.value}"`)
  return parts.join(' · ') || 'no conditions'
}

async function allSearches() {
  return (await getJson('/api/users/0/searches?format=json&limit=100')).map(normalizeSearch)
}

async function readSearch(key) {
  return normalizeSearch(await getJson(`/api/users/0/searches/${key}?format=json`))
}

const USAGE =
  'usage: node tools/zotero-collection.mjs --list\n' +
  '       node tools/zotero-collection.mjs --show <key>\n' +
  '       node tools/zotero-collection.mjs --create "<name>" [--parent <key>] [--write]\n' +
  '       node tools/zotero-collection.mjs --rename <key> --name "<new name>" [--write]\n' +
  '       node tools/zotero-collection.mjs --delete <key> [--write]\n' +
  '       node tools/zotero-collection.mjs --assign <itemKey> --collection <key> [--remove] [--write]\n' +
  '       node tools/zotero-collection.mjs --saved-search-create "<name>" --query "<terms>" [--write]\n' +
  '       node tools/zotero-collection.mjs --saved-search-update <key> [--name "<new name>"] [--query "<terms>"] [--write]\n' +
  '       node tools/zotero-collection.mjs --saved-search-delete <key> [--write]'

function parseArgs(argv) {
  const options = { mode: '', value: '', name: '', parent: '', item: '', query: '', remove: false, write: false }
  const take = (flag, next, field) => {
    if (!next) throw new UsageError(`${flag} needs a value`)
    options[field] = next
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = argv[index + 1]
    switch (flag) {
      case '--list':
        if (options.mode) throw new UsageError('pass one of --list/--show/--create/--rename/--delete/--assign/--saved-search-*')
        options.mode = 'list'
        break
      case '--create':
      case '--rename':
      case '--show':
      case '--delete':
      case '--assign':
      case '--saved-search-create':
      case '--saved-search-update':
      case '--saved-search-delete':
        if (options.mode) throw new UsageError('pass one of --list/--show/--create/--rename/--delete/--assign/--saved-search-*')
        options.mode = flag.slice(2)
        take(flag, next, flag === '--assign' ? 'item' : 'value')
        index += 1
        break
      case '--name':
        take(flag, next, 'name')
        index += 1
        break
      case '--parent':
        take(flag, next, 'parent')
        index += 1
        break
      case '--collection':
        take(flag, next, 'value')
        index += 1
        break
      case '--query':
        take(flag, next, 'query')
        index += 1
        break
      case '--remove':
        options.remove = true
        break
      case '--write':
        options.write = true
        break
      default:
        throw new UsageError(`unrecognised argument '${flag}'`)
    }
  }
  if (!options.mode) throw new UsageError('pass --list, --show, --create, --rename, --delete, --assign or --saved-search-*')
  if (options.mode === 'rename' && !options.name) throw new UsageError('--rename needs --name "<new name>"')
  if (options.mode === 'assign' && !options.value) throw new UsageError('--assign needs --collection <key>')
  if (options.mode === 'saved-search-create' && !options.query) throw new UsageError('--saved-search-create needs --query "<terms>"')
  if (options.mode === 'saved-search-update' && !options.name && !options.query) {
    throw new UsageError('--saved-search-update needs --name and/or --query')
  }
  return options
}

async function allCollections() {
  return getJson('/api/users/0/collections?format=json&limit=200')
}

async function runList() {
  const rows = await allCollections()
  const byParent = new Map()
  for (const row of rows) {
    const parent = normalizeCollections(row.data?.parentCollection)[0] ?? ''
    byParent.set(parent, [...(byParent.get(parent) ?? []), row])
  }
  console.log(`collections: ${rows.length} in ${(byParent.get('') ?? []).length} root(s)`)
  const walk = (parentKey, depth) => {
    for (const row of byParent.get(parentKey) ?? []) {
      console.log(`${'  '.repeat(depth)}${row.key}  ${String(row.meta?.numItems ?? 0).padStart(5)}  ${row.data?.name ?? '(unnamed)'}`)
      walk(row.key, depth + 1)
    }
  }
  walk('', 0)
}

async function runShow(options) {
  const rows = await allCollections()
  const row = rows.find((candidate) => candidate.key === options.value)
  if (!row) {
    throw new Refusal(`no collection ${options.value} in this library.`, {
      fix: 'Run --list for the keys it does have.',
    })
  }
  const byKey = new Map(rows.map((each) => [each.key, each]))
  const name = (key) => `${byKey.get(key)?.data?.name ?? '(unnamed)'} (${key})`
  const parentOf = (each) => normalizeCollections(each.data?.parentCollection)[0] ?? ''
  const parentKey = parentOf(row)
  // Walk up to the root, guarding against a malformed tree rather than looping on it.
  const path = [name(row.key)]
  const seen = new Set([row.key])
  for (let key = parentKey; key && !seen.has(key); key = parentOf(byKey.get(key) ?? {})) {
    seen.add(key)
    path.unshift(name(key))
  }
  const children = rows.filter((each) => parentOf(each) === row.key)
  console.log(`collection : ${row.key}`)
  console.log(`name       : ${row.data?.name ?? '(unnamed)'}`)
  console.log(`parent     : ${parentKey ? name(parentKey) : '(library root)'}`)
  console.log(`items      : ${row.meta?.numItems ?? 0}  directly in this collection`)
  console.log(`path       : ${path.join(' > ')}`)
  console.log(`children   : ${children.length}`)
  for (const child of children) {
    console.log(`             ${child.key}  ${String(child.meta?.numItems ?? 0).padStart(5)}  ${child.data?.name ?? '(unnamed)'}`)
  }
}

async function runCreate(options) {
  const rows = await allCollections()
  const parentKey = options.parent || undefined
  if (parentKey && !rows.some((row) => row.key === parentKey)) {
    throw new Error(`no collection ${parentKey} in this library`)
  }
  const parentName = parentKey ? (rows.find((row) => row.key === parentKey)?.data?.name ?? '(unnamed)') : '(library root)'
  const duplicate = siblingWithName(rows, { name: options.value, parentKey })
  console.log(`parent  : ${parentKey ?? '(root)'}  ${parentName}`)
  console.log(`create  : "${options.value}"`)
  // Measured from a working implementation: the body is a LIST, and a root collection says
  // `parentCollection: false` rather than omitting the key or sending null.
  console.log(`body    : ${JSON.stringify([{ name: options.value, parentCollection: parentKey ?? false }])}`)
  if (duplicate) {
    console.error(`\nREFUSING: "${duplicate.data.name}" (${duplicate.key}) already exists under ${parentName}.`)
    console.error('Two collections of the same name under one parent are indistinguishable in the library tree.')
    process.exitCode = 1
    return
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write; the reference manager will then')
    console.log('ask you to Allow the write, and is asked once.')
    return
  }
  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  writeAttempted = true
  const res = await gate.write('POST', '/api/users/0/collections', [
    { name: options.value, parentCollection: parentKey ?? false },
  ])
  if (res.status !== 200 && !mayHaveLanded(res.status)) {
    console.error(`\nThe library refused the creation (HTTP ${res.status}): ${res.text.slice(0, 300)}`)
    process.exitCode = 1
    return
  }
  const body = res.status === 200 ? JSON.parse(res.text) : null
  const created = createdItemKey(body)
  if (created) {
    const back = await readCollection(created)
    console.log(`\nOK - ${created} "${back.name}" now exists under ${parentName} (version ${back.version}).`)
    return
  }
  // No key came back, and the request was sent: the tree itself can say whether the collection exists,
  // so ask it rather than reporting a refusal that a caller would answer with a second create.
  const again = siblingWithName(await allCollections(), { name: options.value, parentKey })
  process.exitCode = reportUnconfirmed({
    key: again?.key ?? '',
    what: `the creation of "${options.value}" answered ${
      res.status === 200 ? 'success without a key' : `HTTP ${res.status}`
    }`,
    found: again
      ? `The tree now lists "${options.value}" as ${again.key}: the collection exists, and nothing else was created.`
      : 'The tree lists no collection of that name, but the request was sent - do not create it twice.',
  })
}

async function runRename(options) {
  const before = await readCollection(options.value)
  console.log(`collection : ${options.value}  "${before.name}"  under ${before.parentCollection || '(root)'}`)
  console.log(`version    : ${before.version}`)
  console.log(`name       : "${before.name}"`)
  console.log(`        -> : "${options.name}"`)
  console.log(`write      : PATCH /api/users/0/collections/${options.value}  If-Unmodified-Since-Version: ${before.version}`)
  console.log('\nNOTE: a rename through the local API WAS measured to work on Zotero 10.0.6 (2026-10-16:')
  console.log('XBUY9SCY out and back, name read back through a second code path). If this library refuses it,')
  console.log('the tool stops rather than creating a replacement, because a new collection would carry a new')
  console.log('key.')
  console.log(`THE STALENESS GUARD IS SENT, BUT WHETHER IT BITES DEPENDS ON THE LIBRARY: measured 2026-10-15,`)
  console.log(`nearly every collection reported version 0 (this one is ${before.version}), and a version that never`)
  console.log('moves cannot refuse anything. What that costs is bounded: this patch sends only a name, so')
  console.log('nothing else on the collection can be overwritten. Two renames at once resolve last-writer-wins.')
  if (before.name === options.name) {
    console.log('\nNo change: the collection already has that name.')
    return
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write to attempt it.')
    return
  }
  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  const result = await patchCollection({
    gate,
    key: options.value,
    patch: { name: options.name },
    apply: true,
    beforeWrite: () => {
      writeAttempted = true
    },
  })
  if (result.conflict) {
    console.error(`\nCONFLICT: collection ${options.value} changed since this plan was read. Nothing was written.`)
    console.error(`Its current name is "${result.before.name}" at version ${result.before.version}.`)
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    if (mayHaveLanded(result.status)) {
      const after = await readCollection(options.value).catch(() => null)
      process.exitCode = reportUnconfirmed({
        key: options.value,
        what: `the rename answered HTTP ${result.status} (${result.detail.slice(0, 200)})`,
        found: after
          ? after.name === options.name
            ? `A re-read shows "${options.name}": the rename landed.`
            : `A re-read still shows "${after.name}".`
          : 'The re-read that would settle it failed as well.',
      })
      return
    }
    console.error(`\nThe library refused the rename (HTTP ${result.status}): ${result.detail}`)
    console.error('This is the unmeasured case: the local API may not support renaming a collection.')
    console.error('Rename it in the application instead - this tool will not create a replacement.')
    process.exitCode = 1
    return
  }
  if (result.after.name !== options.name) {
    process.exitCode = reportUnconfirmed({
      key: options.value,
      what: `the library accepted the rename and the collection still reads "${result.after.name}"`,
      found: 'The collection was not renamed as asked; do not create a replacement, which would carry a new key.',
    })
    return
  }
  console.log(`\nOK - ${options.value} is now "${result.after.name}" (version ${result.after.version}).`)
}

async function runAssign(options) {
  const item = await readItem(options.item)
  const collection = await readCollection(options.value)
  const current = normalizeCollections(item.collections)
  const { next, changed } = nextCollections(current, options.value, { remove: options.remove })
  console.log(`item       : ${options.item}  [${item.itemType}]  "${item.title ?? ''}"`)
  console.log(`collection : ${options.value}  "${collection.name}"`)
  console.log(`version    : ${item.version}`)
  console.log(`filing     : ${current.join(' · ') || 'none'}`)
  console.log(`        -> : ${next.join(' · ') || 'none'}`)
  console.log(`body       : ${JSON.stringify({ collections: next })}`)
  console.log(`write      : PATCH /api/users/0/items/${options.item}  If-Unmodified-Since-Version: ${item.version}`)
  if (!changed) {
    console.log(`\nNo change: the item is ${options.remove ? 'not ' : 'already '}in ${options.value}.`)
    return
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write; the reference manager will then')
    console.log('ask you to Allow the write, and is asked once.')
    return
  }
  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  const result = await patchItem({
    gate,
    key: options.item,
    patch: { collections: next },
    apply: true,
    beforeWrite: () => {
      writeAttempted = true
    },
  })
  if (result.conflict) {
    console.error(`\nCONFLICT: item ${options.item} changed since this plan was read. Nothing was written.`)
    console.error(`Its current filing is ${normalizeCollections(result.before.collections).join(' · ') || 'none'} at version ${result.before.version}.`)
    process.exitCode = 1
    return
  }
  if (!result.applied) {
    if (mayHaveLanded(result.status)) {
      const after = await readItem(options.item).catch(() => null)
      const filing = after ? normalizeCollections(after.collections) : null
      process.exitCode = reportUnconfirmed({
        key: options.item,
        what: `the filing change answered HTTP ${result.status} (${result.detail.slice(0, 200)})`,
        found: filing
          ? JSON.stringify(filing) === JSON.stringify(next)
            ? `A re-read shows exactly the requested filing (${filing.join(' · ') || 'none'}): the write landed.`
            : `A re-read shows ${filing.join(' · ') || 'none'}.`
          : 'The re-read that would settle it failed as well.',
      })
      return
    }
    console.error(`\nThe library refused the write (HTTP ${result.status}): ${result.detail}`)
    process.exitCode = 1
    return
  }
  const after = normalizeCollections(result.after.collections)
  if (JSON.stringify(after) !== JSON.stringify(next)) {
    process.exitCode = reportUnconfirmed({
      key: options.item,
      what: `the library accepted the filing and the record reads back as ${after.join(' · ') || 'none'}`,
      found: 'The filing is not what was asked; read the record before filing it again.',
    })
    return
  }
  console.log(`\nOK - ${options.item} now files under ${after.join(' · ') || 'none'} (version ${result.after.version}).`)
}

// A collection is deleted by key, with the version guard the library keeps for it. Zotero deletes the
// collection's children with it and leaves every item in the library; saying both before the write is
// the whole point of the plan line, because "delete" here never means "delete the papers".
async function runDelete(options) {
  const before = await readCollection(options.value).catch(() => null)
  if (!before) {
    throw new Refusal(`no collection ${options.value} in this library.`, {
      fix: 'Run --list for the keys it does have.',
    })
  }
  const rows = await allCollections()
  const children = rows.filter((row) => normalizeCollections(row.data?.parentCollection)[0] === options.value)
  console.log(`collection : ${options.value}  "${before.name}"  under ${before.parentCollection || '(root)'}`)
  console.log(`version    : ${before.version}`)
  console.log(`children   : ${children.length}  deleted with it`)
  console.log(`items      : stay in the library - deleting a collection never deletes an item`)
  console.log(`write      : DELETE /api/users/0/collections/${options.value}  If-Unmodified-Since-Version: ${before.version}`)
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write; the reference manager will then')
    console.log('ask you to Allow the write, and is asked once.')
    return
  }
  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  writeAttempted = true
  const res = await gate.write('DELETE', `/api/users/0/collections/${options.value}`, undefined, {
    'If-Unmodified-Since-Version': before.version,
  })
  if (res.status === 412) {
    const now = await readCollection(options.value).catch(() => null)
    console.error(`\nCONFLICT: collection ${options.value} changed since this plan was read. Nothing was written.`)
    console.error(`It now reads "${now?.name ?? '(gone)'}" at version ${now?.version ?? '?'}.`)
    process.exitCode = 1
    return
  }
  const goneResult = await readCollection(options.value).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  const gone = goneResult.ok ? goneResult.value : null
  const goneForCertain = !goneResult.ok && goneResult.error?.status === 404
  if (res.status >= 200 && res.status < 300) {
    if (!goneForCertain) {
      process.exitCode = reportUnconfirmed({
        key: options.value,
        what: gone
          ? `the delete answered HTTP ${res.status} and the collection still reads "${gone.name}"`
          : `the delete answered HTTP ${res.status} but the re-read failed (${goneResult.error?.message})`,
        found: 'Read the tree before trying again.',
      })
      return
    }
    console.log(`\nOK - ${options.value} is gone; ${children.length} child collection(s) went with it and its items stay in the library.`)
    return
  }
  if (mayHaveLanded(res.status)) {
    process.exitCode = reportUnconfirmed({
      key: options.value,
      what: `the delete answered HTTP ${res.status} (${res.text.slice(0, 200)})`,
      found: gone ? `A re-read still lists "${gone.name}".` : 'A re-read no longer lists it: the delete landed.',
    })
    return
  }
  console.error(`\nThe library refused the delete (HTTP ${res.status}): ${res.text.slice(0, 300)}`)
  process.exitCode = 1
}

async function runSavedSearchCreate(options) {
  const body = { name: options.value, conditions: searchConditions(options.query) }
  console.log(`search     : "${body.name}"`)
  console.log(`conditions : ${describeConditions(body.conditions)}`)
  console.log(`body       : ${JSON.stringify([body])}`)
  console.log('write      : POST /api/users/0/searches')
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write; the reference manager will then')
    console.log('ask you to Allow the write, and is asked once.')
    return
  }
  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  writeAttempted = true
  const res = await gate.write('POST', '/api/users/0/searches', [body])
  if (res.status >= 200 && res.status < 300) {
    const parsed = JSON.parse(res.text || '{}')
    const created = createdItemKey(parsed)
    if (created) {
      const back = await readSearch(created)
      if (back.name === body.name && sameConditions(body.conditions, back.conditions)) {
        console.log(`\nOK - saved search ${created} "${back.name}" reads back with ${describeConditions(back.conditions)}.`)
        return
      }
      process.exitCode = reportUnconfirmed({
        key: created,
        what: 'the saved search was created and does not read back as sent',
        found: `It reads "${back.name}" with ${describeConditions(back.conditions)}.`,
      })
      return
    }
    const again = (await allSearches()).find((each) => each.name === body.name)
    process.exitCode = reportUnconfirmed({
      key: again?.key ?? '',
      what: 'the creation answered success without a key',
      found: again
        ? `The search list now has "${body.name}" as ${again.key}: the search exists.`
        : 'The search list does not show it, but the request was sent - do not create it twice.',
    })
    return
  }
  if (mayHaveLanded(res.status)) {
    process.exitCode = reportUnconfirmed({
      key: '',
      what: `the saved-search creation answered HTTP ${res.status}`,
      found: 'Read the saved searches with -read --saved-searches before creating it again.',
    })
    return
  }
  console.error(`\nThe library refused the creation (HTTP ${res.status}): ${res.text.slice(0, 300)}`)
  process.exitCode = 1
}

async function runSavedSearchUpdate(options) {
  const before = await readSearch(options.value).catch(() => null)
  if (!before) {
    throw new Refusal(`no saved search ${options.value} in this library.`, {
      fix: 'List them with -read --saved-searches.',
    })
  }
  const body = {}
  if (options.name) body.name = options.name
  if (options.query) body.conditions = searchConditions(options.query)
  const changed =
    (body.name !== undefined && body.name !== before.name) ||
    (body.conditions !== undefined && !sameConditions(body.conditions, before.conditions))
  console.log(`search     : ${options.value}  "${before.name}"  (version ${before.version})`)
  console.log(`conditions : ${describeConditions(before.conditions)}`)
  if (body.name !== undefined) console.log(`name       : "${before.name}" -> "${body.name}"`)
  if (body.conditions !== undefined) console.log(`conditions : -> ${describeConditions(body.conditions)}`)
  console.log(`body       : ${JSON.stringify(body)}`)
  console.log(`write      : PATCH /api/users/0/searches/${options.value}  If-Unmodified-Since-Version: ${before.version}`)
  if (!changed) {
    console.log('\nNo change: the saved search already reads that way.')
    return
  }
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write to attempt it.')
    return
  }
  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  writeAttempted = true
  const res = await gate.write('PATCH', `/api/users/0/searches/${options.value}`, body, {
    'If-Unmodified-Since-Version': before.version,
  })
  if (res.status === 412) {
    console.error(`\nCONFLICT: saved search ${options.value} changed since this plan was read. Nothing was written.`)
    process.exitCode = 1
    return
  }
  if (res.status >= 200 && res.status < 300) {
    const back = await readSearch(options.value)
    const sameName = body.name === undefined || back.name === body.name
    const conditionsMatch = body.conditions === undefined || sameConditions(body.conditions, back.conditions)
    if (sameName && conditionsMatch) {
      console.log(`\nOK - saved search ${options.value} now reads "${back.name}" with ${describeConditions(back.conditions)}.`)
      return
    }
    process.exitCode = reportUnconfirmed({
      key: options.value,
      what: 'the library accepted the update and the saved search does not read back as sent',
      found: `It reads "${back.name}" with ${describeConditions(back.conditions)}.`,
    })
    return
  }
  if (mayHaveLanded(res.status)) {
    const back = await readSearch(options.value).catch(() => null)
    process.exitCode = reportUnconfirmed({
      key: options.value,
      what: `the update answered HTTP ${res.status} (${res.text.slice(0, 200)})`,
      found: back
        ? `A re-read shows "${back.name}" with ${describeConditions(back.conditions)}.`
        : 'The re-read that would settle it failed as well.',
    })
    return
  }
  console.error(`\nThe library refused the update (HTTP ${res.status}): ${res.text.slice(0, 300)}`)
  process.exitCode = 1
}

async function runSavedSearchDelete(options) {
  const before = await readSearch(options.value).catch(() => null)
  if (!before) {
    throw new Refusal(`no saved search ${options.value} in this library.`, {
      fix: 'List them with -read --saved-searches.',
    })
  }
  console.log(`search     : ${options.value}  "${before.name}"  (version ${before.version})`)
  console.log(`conditions : ${describeConditions(before.conditions)}`)
  console.log(`write      : DELETE /api/users/0/searches/${options.value}  If-Unmodified-Since-Version: ${before.version}`)
  if (!options.write) {
    console.log('\nDRY RUN - nothing was written. Re-run with --write to attempt it.')
    return
  }
  const gate = createWriteGate({ appName: APP_NAME })
  await gate.open()
  writeAttempted = true
  const res = await gate.write('DELETE', `/api/users/0/searches/${options.value}`, undefined, {
    'If-Unmodified-Since-Version': before.version,
  })
  if (res.status === 412) {
    console.error(`\nCONFLICT: saved search ${options.value} changed since this plan was read. Nothing was written.`)
    process.exitCode = 1
    return
  }
  const goneResult = await readSearch(options.value).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  const gone = goneResult.ok ? goneResult.value : null
  const goneForCertain = !goneResult.ok && goneResult.error?.status === 404
  if (res.status >= 200 && res.status < 300) {
    if (!goneForCertain) {
      process.exitCode = reportUnconfirmed({
        key: options.value,
        what: gone
          ? `the delete answered HTTP ${res.status} and the saved search still reads "${gone.name}"`
          : `the delete answered HTTP ${res.status} but the re-read failed (${goneResult.error?.message})`,
        found: 'Read the saved searches before trying again.',
      })
      return
    }
    console.log(`\nOK - saved search ${options.value} is gone.`)
    return
  }
  if (mayHaveLanded(res.status)) {
    process.exitCode = reportUnconfirmed({
      key: options.value,
      what: `the delete answered HTTP ${res.status} (${res.text.slice(0, 200)})`,
      found: gone ? `A re-read still lists "${gone.name}".` : 'A re-read no longer lists it: the delete landed.',
    })
    return
  }
  console.error(`\nThe library refused the delete (HTTP ${res.status}): ${res.text.slice(0, 300)}`)
  process.exitCode = 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const runners = {
    list: runList,
    show: runShow,
    create: runCreate,
    rename: runRename,
    delete: runDelete,
    assign: runAssign,
    'saved-search-create': runSavedSearchCreate,
    'saved-search-update': runSavedSearchUpdate,
    'saved-search-delete': runSavedSearchDelete,
  }
  await runners[options.mode](options)
}

const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint && wantsHelp(process.argv.slice(2))) {
  process.exitCode = reportHelp(USAGE)
} else if (isEntryPoint) {
  main().catch((error) => {
    const code = reportFailure(error, { usage: USAGE })
    if (code === 1 && writeAttempted && !error.refused) {
      process.exitCode = reportUnconfirmed({
        what: 'the change was sent and then the connection failed: OUTCOME UNKNOWN',
        found: 'Read the collection tree or the record before trying again.',
      })
      return
    }
    process.exitCode = code
  })}
