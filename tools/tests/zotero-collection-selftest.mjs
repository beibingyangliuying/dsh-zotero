// Self-test for the collection tool, runnable without a library.
//
// Usage: node tools/tests/zotero-collection-selftest.mjs
//
// Two properties carry the safety of this tool:
//   * the duplicate check compares SIBLINGS, and the library answers `parentCollection: false` for a
//     collection at the root - so "no parent" has to compare equal to itself, or the check silently
//     misses every root-level duplicate;
//   * the filing list sent is the WHOLE next list, so it does not matter whether a patch's
//     `collections` replaces or merges.
//
// Sections [1] and [2] check the pure half directly. Section [3] spawns the command line against a
// STUB library on a spare port, because the exit code is what a caller acts on: an accepted-but-unread
// change must answer 3 (the tree may already carry it) and a refusal must answer 1 (nothing was
// written). Those two answers are the ones a mistake in this wiring would silently swap.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeConditions,
  nextCollections,
  normalizeSearch,
  sameConditions,
  searchConditions,
  siblingWithName,
} from '../zotero-collection.mjs'

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  -> ${detail}` : ''}`)
  if (!condition) failures += 1
}

console.log('collection tool self-test')

// The measured shape: a root answers `parentCollection: false`, not an omitted key and not null.
// The keys and names are synthetic; the SHAPE is the one the library answered.
const COLLECTIONS = [
  { key: 'COLROOT1', data: { name: 'Example root', parentCollection: false }, meta: { numItems: 18 } },
  { key: 'COLCHLD2', data: { name: 'Example child', parentCollection: 'COLROOT1' }, meta: { numItems: 13 } },
  { key: 'COLCHLD3', data: { name: 'Example child two', parentCollection: 'COLROOT1' }, meta: { numItems: 9 } },
  { key: 'COLNOTE4', data: { name: 'Example root two' }, meta: { numItems: 0 } },
]

console.log('\n[1] a duplicate is a sibling with the same name')

check(
  siblingWithName(COLLECTIONS, { name: 'Example child', parentKey: 'COLROOT1' })?.key === 'COLCHLD2',
  'the same name under the same parent is a duplicate',
)
check(
  siblingWithName(COLLECTIONS, { name: 'Example child', parentKey: 'COLCHLD3' }) === undefined,
  'the same name under a different parent is not',
)
check(
  siblingWithName(COLLECTIONS, { name: 'Example root' })?.key === 'COLROOT1',
  'a root-level duplicate is found - the root answers false, and "no parent" must equal itself',
)
check(
  siblingWithName(COLLECTIONS, { name: 'Example root two' })?.key === 'COLNOTE4',
  'a root whose parent field is absent altogether is found too',
)
check(
  siblingWithName(COLLECTIONS, { name: '  Example child  ', parentKey: 'COLROOT1' })?.key === 'COLCHLD2',
  'surrounding whitespace does not hide a duplicate',
)
check(
  siblingWithName(COLLECTIONS, { name: 'Example absent' }) === undefined,
  'a name that is not there is not a duplicate',
)

console.log('\n[2] filing is computed as a whole list')

check(JSON.stringify(nextCollections([], 'COLONLY1').next) === '["COLONLY1"]', 'filing into nothing yields that one')
check(
  JSON.stringify(nextCollections(['A'], 'B').next) === '["A","B"]',
  'a second collection is added after the first',
  JSON.stringify(nextCollections(['A'], 'B').next),
)
check(nextCollections(['A'], 'A').changed === false, 'filing into a collection it is already in changes nothing')
check(
  JSON.stringify(nextCollections(['A', 'B'], 'A', { remove: true }).next) === '["B"]',
  'removing keeps the rest in order',
)
check(
  nextCollections(['A'], 'B', { remove: true }).changed === false,
  'removing a collection it is not in changes nothing',
)
check(nextCollections([], 'A', { remove: true }).changed === false, 'removing from nothing changes nothing')

console.log('\n[2b] a saved search is a name plus one query condition')

check(
  JSON.stringify(searchConditions('graph neural')) ===
    '[{"condition":"quicksearch","operator":"contains","value":"graph neural"}]',
  '--query becomes the "Search terms contains" condition the library itself stores',
)
check(normalizeSearch({ key: 'S1', version: 4, data: { name: 'Mine', conditions: [] } }).key === 'S1', 'a row with data nests the fields')
check(normalizeSearch({ key: 'S1', version: 4, name: 'Mine' }).version === 4, 'a flat row works too')
check(normalizeSearch({}).conditions.length === 0, 'a search without conditions has an empty list, not undefined')
check(describeConditions(searchConditions('x')).includes('quicksearch contains "x"'), 'the plan line says what it matches')
check(
  sameConditions(searchConditions('x'), [
    { condition: 'groupStart', operator: '', value: '' },
    { condition: 'joinMode', operator: 'any', value: '' },
    { condition: 'field', operator: 'contains', value: 'x' },
    { condition: 'tag', operator: 'contains', value: 'x' },
    { condition: 'groupEnd', operator: '', value: '' },
  ]),
  'a quicksearch reads back expanded into clauses, and still counts as the same search',
)
check(
  !sameConditions(searchConditions('x'), [{ condition: 'field', operator: 'contains', value: 'y' }]),
  'a clause holding a different term is a different search',
)

console.log("\n[3] the command line against a stub library, not the owner's")

const scratch = mkdtempSync(join(tmpdir(), 'collection-cli-'))
const grantPath = join(scratch, 'grant.json')
const tool = fileURLToPath(new URL('../zotero-collection.mjs', import.meta.url))

const baseCollections = () => [
  { key: 'ROOTAAAA', data: { name: 'Example root', parentCollection: false }, meta: { numItems: 3 }, version: 7 },
]
const baseItems = () => ({
  ITEMAAAA: { key: 'ITEMAAAA', itemType: 'journalArticle', title: 'A paper', collections: [], version: 5 },
})
const baseSearches = () => [
  { key: 'SEARCH01', version: 2, data: { name: 'Old search', conditions: searchConditions('old') } },
]

// The library the tool talks to, and the hooks a scenario replaces. A hook that is null means "behave
// like the thing the tool was measured against"; a scenario sets one to answer differently.
const stub = {
  collections: baseCollections(),
  items: baseItems(),
  searches: baseSearches(),
  requests: [],
  created: 0,
  authorize: () => ({ status: 200, body: { key: 'stub-key', remember: false } }),
  createCollection: null,
  patchCollection: null,
  patchItem: null,
  deleteCollection: null,
  patchSearch: null,
  deleteSearch: null,
}

const resetLibrary = () => {
  stub.collections = baseCollections()
  stub.items = baseItems()
  stub.searches = baseSearches()
  stub.requests.length = 0
  stub.created = 0
  stub.authorize = () => ({ status: 200, body: { key: 'stub-key', remember: false } })
  stub.createCollection = null
  stub.patchCollection = null
  stub.patchItem = null
  stub.deleteCollection = null
  stub.patchSearch = null
  stub.deleteSearch = null
}

const addCollection = (name, parentCollection) => {
  const key = `NEWCOL${String(++stub.created).padStart(2, '0')}`
  stub.collections.push({ key, data: { name, parentCollection }, meta: { numItems: 0 }, version: 0 })
  return key
}

/** The library's own rule in miniature: honour the version precondition, then carry the change out. */
const patchRow = (row, patch, expectedVersion, into) => {
  if (String(expectedVersion) !== String(row.version)) return { status: 412 }
  Object.assign(into, patch)
  row.version += 1
  return { status: 204 }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  stub.requests.push(`${req.method} ${path}`)
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  const noContent = () => {
    res.writeHead(204)
    res.end()
  }
  const readBody = (done) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => done(raw))
  }
  const answerPatch = (answer) =>
    answer.status === 204 ? noContent() : send(answer.status, { error: 'the stub refused the write' })

  if (path === '/api/') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'zotero-server-id': 'stub-server',
      'x-zotero-version': 'stub',
    })
    res.end('{}')
    return
  }
  if (path === '/api/local/authorize' && req.method === 'POST') {
    const answer = stub.authorize()
    if (answer.status !== 200) send(answer.status, { error: 'the stub declined the dialog' })
    else send(200, answer.body)
    return
  }
  if (path === '/api/users/0/collections' && req.method === 'GET') {
    send(200, stub.collections)
    return
  }
  if (path === '/api/users/0/collections' && req.method === 'POST') {
    readBody((raw) => {
      const payload = JSON.parse(raw)
      if (stub.createCollection) {
        const answer = stub.createCollection(payload)
        send(answer.status, answer.body)
        return
      }
      send(200, { successful: { 0: addCollection(payload[0].name, payload[0].parentCollection) } })
    })
    return
  }
  const collectionPath = /^\/api\/users\/0\/collections\/([A-Z0-9]+)$/.exec(path)
  if (collectionPath) {
    const row = stub.collections.find((entry) => entry.key === collectionPath[1])
    if (!row) {
      send(404, { error: 'not found' })
      return
    }
    if (req.method === 'PATCH') {
      readBody((raw) => {
        const patch = JSON.parse(raw)
        const expected = req.headers['if-unmodified-since-version']
        answerPatch(
          stub.patchCollection
            ? stub.patchCollection(row, patch, expected)
            : patchRow(row, patch, expected, row.data),
        )
      })
      return
    }
    if (req.method === 'DELETE') {
      const expected = req.headers['if-unmodified-since-version']
      if (stub.deleteCollection) {
        answerPatch(stub.deleteCollection(row, expected))
        return
      }
      if (String(expected) !== String(row.version)) {
        send(412, { error: 'the version moved' })
        return
      }
      const doomed = new Set([row.key])
      let grew = true
      while (grew) {
        grew = false
        for (const each of stub.collections) {
          if (!doomed.has(each.key) && doomed.has(each.data?.parentCollection || '')) {
            doomed.add(each.key)
            grew = true
          }
        }
      }
      stub.collections = stub.collections.filter((each) => !doomed.has(each.key))
      noContent()
      return
    }
    send(200, { data: { ...row.data, version: row.version } })
    return
  }
  if (path === '/api/users/0/searches' && req.method === 'GET') {
    send(200, stub.searches)
    return
  }
  if (path === '/api/users/0/searches' && req.method === 'POST') {
    readBody((raw) => {
      const payload = JSON.parse(raw)
      const search = payload[0] ?? payload
      const key = `SEARCH${String(stub.searches.length + 2).padStart(2, '0')}`
      stub.searches.push({ key, version: 1, data: { name: search.name, conditions: search.conditions } })
      send(200, { successful: { 0: key } })
    })
    return
  }
  const searchPrefix = '/api/users/0/searches/'
  if (path.startsWith(searchPrefix)) {
    const key = path.slice(searchPrefix.length)
    const row = stub.searches.find((each) => each.key === key)
    if (!row) {
      send(404, { error: 'not found' })
      return
    }
    if (req.method === 'PATCH') {
      readBody((raw) => {
        const patch = JSON.parse(raw)
        const expected = req.headers['if-unmodified-since-version']
        answerPatch(stub.patchSearch ? stub.patchSearch(row, patch, expected) : patchRow(row, patch, expected, row.data))
      })
      return
    }
    if (req.method === 'DELETE') {
      const expected = req.headers['if-unmodified-since-version']
      if (stub.deleteSearch) {
        answerPatch(stub.deleteSearch(row, expected))
        return
      }
      if (String(expected) !== String(row.version)) {
        send(412, { error: 'the version moved' })
        return
      }
      stub.searches = stub.searches.filter((each) => each.key !== row.key)
      noContent()
      return
    }
    send(200, { key: row.key, version: row.version, data: row.data })
    return
  }
  const itemPath = /^\/api\/users\/0\/items\/([A-Z0-9]+)$/.exec(path)
  if (itemPath) {
    const row = stub.items[itemPath[1]]
    if (!row) {
      send(404, { error: 'not found' })
      return
    }
    if (req.method === 'PATCH') {
      readBody((raw) => {
        const patch = JSON.parse(raw)
        const expected = req.headers['if-unmodified-since-version']
        answerPatch(stub.patchItem ? stub.patchItem(row, patch, expected) : patchRow(row, patch, expected, row))
      })
      return
    }
    send(200, { data: { ...row } })
    return
  }
  send(404, { error: 'not found' })
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `127.0.0.1:${server.address().port}`
const runAsync = (args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [tool, ...args], {
      env: { ...process.env, ZOTERO_LOCAL_API: origin, ZOTERO_LOCAL_KEY_STORE: grantPath },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
const createsSent = () => stub.requests.filter((line) => line === 'POST /api/users/0/collections').length
/** What to show as the detail: the first line that says something, not the whole transcript. */
const first = (text) => text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''

resetLibrary()
const createdRun = await runAsync(['--create', 'Reading list', '--write'])
check(createdRun.status === 0, 'a create the library accepts exits 0', `status ${createdRun.status}`)
check(createdRun.stdout.includes('NEWCOL01'), 'and names the key it read back', first(createdRun.stdout))
check(
  stub.collections.some((row) => row.key === 'NEWCOL01' && row.data.name === 'Reading list'),
  'the stub library holds it',
)
check(createsSent() === 1, 'exactly one create was sent', String(createsSent()))

// The answer this tool exists for: 200, a collection in the tree, and no key in the body. A caller told
// "refused" would create it a second time, and two siblings of one name are invisible in the tree.
resetLibrary()
stub.createCollection = (payload) => {
  addCollection(payload[0].name, payload[0].parentCollection)
  return { status: 200, body: { successful: {} } }
}
const silentCreate = await runAsync(['--create', 'Reading list', '--write'])
check(silentCreate.status === 3, 'success without a key is exit 3, not 1 and not 0', `status ${silentCreate.status}`)
check(silentCreate.stderr.includes('WRITTEN BUT UNCONFIRMED'), 'and it says the collection exists', first(silentCreate.stderr))
check(silentCreate.stderr.includes('NEWCOL01'), 'and names the key a caller must read', first(silentCreate.stderr))
check(silentCreate.stderr.includes('nothing else was created'), 'and says no second one was made', first(silentCreate.stderr))
check(createsSent() === 1, 'the create was not sent twice', String(createsSent()))

resetLibrary()
stub.createCollection = () => ({ status: 500, body: { error: 'boom' } })
const failedCreate = await runAsync(['--create', 'Reading list', '--write'])
check(failedCreate.status === 3, 'a 500 with nothing in the tree is exit 3, not 1', `status ${failedCreate.status}`)
check(failedCreate.stderr.includes('SENT BUT UNCONFIRMED'), 'and it says only that the request was sent', first(failedCreate.stderr))
check(
  failedCreate.stderr.includes('lists no collection of that name'),
  'and that the tree is the thing to read, not the status',
  failedCreate.stderr,
)
check(createsSent() === 1, 'no second create was sent', String(createsSent()))

resetLibrary()
stub.createCollection = () => ({ status: 400, body: { error: 'bad request' } })
const refusedCreate = await runAsync(['--create', 'Reading list', '--write'])
check(refusedCreate.status === 1, 'a 4xx refusal is exit 1: nothing was written', `status ${refusedCreate.status}`)
check(refusedCreate.stderr.includes('refused the creation'), 'and it says so in the library\'s own terms', first(refusedCreate.stderr))

// A declined dialog happens BEFORE any request, so it is a refusal even though a write was attempted.
resetLibrary()
stub.authorize = () => ({ status: 403 })
const declined = await runAsync(['--create', 'Reading list', '--write'])
check(declined.status === 1, 'a declined dialog is exit 1, not 3', `status ${declined.status}`)
check(declined.stderr.includes('declined'), 'and names the dialog as the reason', first(declined.stderr))
check(createsSent() === 0, 'and not one create reached the library', String(createsSent()))

resetLibrary()
const renamed = await runAsync(['--rename', 'ROOTAAAA', '--name', 'Renamed root', '--write'])
check(renamed.status === 0, 'a rename the library accepts exits 0', `status ${renamed.status}`)
check(stub.collections[0].data.name === 'Renamed root', 'and the stub library holds the new name')
check(renamed.stdout.includes('is now "Renamed root"'), 'and the read-back is what the tool reports', first(renamed.stdout))

// 412 AND a version that really moved: the application edited the collection while this ran.
resetLibrary()
stub.patchCollection = (row) => {
  row.version += 1
  return { status: 412 }
}
const movedRename = await runAsync(['--rename', 'ROOTAAAA', '--name', 'Renamed root', '--write'])
check(movedRename.status === 1, 'a rename that lost a race is exit 1', `status ${movedRename.status}`)
check(movedRename.stderr.includes('CONFLICT'), 'and it is called a conflict, not a refusal', first(movedRename.stderr))
check(movedRename.stderr.includes('Nothing was written'), 'and it says nothing was written', first(movedRename.stderr))

// 5xx that DID land: the name is there on re-read, so the answer is 3 rather than "try again".
resetLibrary()
stub.patchCollection = (row, patch) => {
  Object.assign(row.data, patch)
  row.version += 1
  return { status: 500 }
}
const landedRename = await runAsync(['--rename', 'ROOTAAAA', '--name', 'Renamed root', '--write'])
check(landedRename.status === 3, 'a 500 rename that landed is exit 3', `status ${landedRename.status}`)
check(landedRename.stderr.includes('the rename landed'), 'and the re-read is what proves it', first(landedRename.stderr))

// Accepted, 2xx, and the name did not change: the worst case, because nothing else on the API reports it.
resetLibrary()
stub.patchCollection = (row) => {
  row.version += 1
  return { status: 204 }
}
const unchangedRename = await runAsync(['--rename', 'ROOTAAAA', '--name', 'Renamed root', '--write'])
check(unchangedRename.status === 3, 'an accepted rename that did not take is exit 3', `status ${unchangedRename.status}`)
check(
  unchangedRename.stderr.includes('do not create a replacement'),
  'and it refuses the fallback that would change the key',
  unchangedRename.stderr,
)

resetLibrary()
const filed = await runAsync(['--assign', 'ITEMAAAA', '--collection', 'ROOTAAAA', '--write'])
check(filed.status === 0, 'a filing the library accepts exits 0', `status ${filed.status}`)
check(JSON.stringify(stub.items.ITEMAAAA.collections) === '["ROOTAAAA"]', 'and the record carries the new list')
check(filed.stdout.includes('now files under ROOTAAAA'), 'and names the filing it read back', first(filed.stdout))

resetLibrary()
stub.patchItem = (row, patch) => {
  Object.assign(row, patch)
  row.version += 1
  return { status: 500 }
}
const landedFiling = await runAsync(['--assign', 'ITEMAAAA', '--collection', 'ROOTAAAA', '--write'])
check(landedFiling.status === 3, 'a 500 filing that landed is exit 3', `status ${landedFiling.status}`)
check(landedFiling.stderr.includes('the write landed'), 'and the re-read shows exactly the asked-for list', first(landedFiling.stderr))

resetLibrary()
stub.patchItem = (row) => {
  row.version += 1
  return { status: 412 }
}
const movedFiling = await runAsync(['--assign', 'ITEMAAAA', '--collection', 'ROOTAAAA', '--write'])
check(movedFiling.status === 1, 'a filing that lost a race is exit 1', `status ${movedFiling.status}`)
check(movedFiling.stderr.includes('CONFLICT'), 'and it is called a conflict', first(movedFiling.stderr))

// The duplicate rule, on the command line: refused before the gate is even opened.
resetLibrary()
const duplicate = await runAsync(['--create', 'Example root', '--write'])
check(duplicate.status === 1, 'a duplicate create is exit 1', `status ${duplicate.status}`)
check(duplicate.stderr.includes('REFUSING'), 'and it names the sibling it found', first(duplicate.stderr))
check(createsSent() === 0, 'and nothing was sent', String(createsSent()))

// A malformed command line is a different thing from a refused write.
resetLibrary()
const usage = await runAsync(['--create'])
check(usage.status === 2, 'a usage error is exit 2', `status ${usage.status}`)

console.log('\n[4] delete and saved searches')

resetLibrary()
const deletePlan = await runAsync(['--delete', 'ROOTAAAA'])
check(deletePlan.status === 0, 'a delete dry run exits 0', `status ${deletePlan.status}`)
check(deletePlan.stdout.includes('DELETE /api/users/0/collections/ROOTAAAA'), 'and prints the request it would send', first(deletePlan.stdout))
check(!stub.requests.some((line) => line.startsWith('DELETE')), 'and sends no delete', JSON.stringify(stub.requests))

resetLibrary()
const deleted = await runAsync(['--delete', 'ROOTAAAA', '--write'])
check(deleted.status === 0, 'a delete the library accepts exits 0', `status ${deleted.status}`)
check(!stub.collections.some((row) => row.key === 'ROOTAAAA'), 'and the collection is gone from the tree')
check(deleted.stdout.includes('is gone'), 'and the tool says so', first(deleted.stdout))

resetLibrary()
stub.deleteCollection = (row) => {
  row.version += 1
  return { status: 412 }
}
const movedDelete = await runAsync(['--delete', 'ROOTAAAA', '--write'])
check(movedDelete.status === 1, 'a delete that lost a race is exit 1', `status ${movedDelete.status}`)
check(movedDelete.stderr.includes('CONFLICT'), 'and it is called a conflict', first(movedDelete.stderr))

resetLibrary()
const madeSearch = await runAsync(['--saved-search-create', 'Reading', '--query', 'graph neural', '--write'])
check(madeSearch.status === 0, 'a saved-search create the library accepts exits 0', `status ${madeSearch.status}`)
check(
  stub.searches.some((row) => row.data.name === 'Reading' && row.data.conditions[0].value === 'graph neural'),
  'and the search holds the name and condition',
)
check(madeSearch.stdout.includes('reads back'), 'and the read-back is what the tool reports', first(madeSearch.stdout))

resetLibrary()
const updatedSearch = await runAsync(['--saved-search-update', 'SEARCH01', '--name', 'New search', '--write'])
check(updatedSearch.status === 0, 'a saved-search rename the library accepts exits 0', `status ${updatedSearch.status}`)
check(stub.searches[0].data.name === 'New search', 'and the stub library holds the new name')

resetLibrary()
stub.patchSearch = (row) => {
  row.version += 1
  return { status: 412 }
}
const movedSearch = await runAsync(['--saved-search-update', 'SEARCH01', '--name', 'New search', '--write'])
check(movedSearch.status === 1, 'a saved-search update that lost a race is exit 1', `status ${movedSearch.status}`)
check(movedSearch.stderr.includes('CONFLICT'), 'and it is called a conflict', first(movedSearch.stderr))

resetLibrary()
const deletedSearch = await runAsync(['--saved-search-delete', 'SEARCH01', '--write'])
check(deletedSearch.status === 0, 'a saved-search delete the library accepts exits 0', `status ${deletedSearch.status}`)
check(stub.searches.length === 0, 'and the search is gone')

resetLibrary()
const noQuery = await runAsync(['--saved-search-create', 'Reading'])
check(noQuery.status === 2, 'a saved search without --query is a usage error', `status ${noQuery.status}`)

server.close()

console.log(
  failures === 0
    ? '\nPASS - the sibling check holds, and every failure path answers 0/1/3 as the header documents'
    : `\nFAIL (${failures})`,
)
process.exit(failures === 0 ? 0 : 1)
