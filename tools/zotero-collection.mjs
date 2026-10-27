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
//   node tools/zotero-collection.mjs --assign <itemKey> --collection <collectionKey> --write
//   node tools/zotero-collection.mjs --assign <itemKey> --collection <collectionKey> --remove --write
//
// Exit codes: 0 applied and read back, or nothing to do | 1 refused, nothing written | 2 usage |
// 3 sent or written but unconfirmed - the tree or the record may already carry the change, so read it
// rather than resending it.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APP_NAME,
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
import { UsageError, reportFailure } from './refusal.mjs'

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

const USAGE =
  'usage: node tools/zotero-collection.mjs --list\n' +
  '       node tools/zotero-collection.mjs --create "<name>" [--parent <key>] [--write]\n' +
  '       node tools/zotero-collection.mjs --rename <key> --name "<new name>" [--write]\n' +
  '       node tools/zotero-collection.mjs --assign <itemKey> --collection <key> [--remove] [--write]'

function parseArgs(argv) {
  const options = { mode: '', value: '', name: '', parent: '', item: '', remove: false, write: false }
  const take = (flag, next, field) => {
    if (!next) throw new UsageError(`${flag} needs a value`)
    options[field] = next
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = argv[index + 1]
    switch (flag) {
      case '--list':
        options.mode = 'list'
        break
      case '--create':
      case '--rename':
      case '--assign':
        if (options.mode) throw new UsageError('pass one of --list/--create/--rename/--assign')
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
  if (!options.mode) throw new UsageError('pass --list, --create, --rename or --assign')
  if (options.mode === 'rename' && !options.name) throw new UsageError('--rename needs --name "<new name>"')
  if (options.mode === 'assign' && !options.value) throw new UsageError('--assign needs --collection <key>')
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
  const saved = body?.successful?.['0'] ?? body?.success?.['0']
  const created = typeof saved === 'string' ? saved : saved?.key
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

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const runners = { list: runList, create: runCreate, rename: runRename, assign: runAssign }
  await runners[options.mode](options)
}

const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
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
