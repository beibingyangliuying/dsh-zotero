#!/usr/bin/env node
// One place for the reference library's local API: the transport, the write gate, plain reads, and the
// one definition of a note body's visible text, which is what a note write is compared against.
//
// WHY THIS FILE EXISTS
//
// Six helpers talk to this API (add an item, read or search the library, write a section note, edit
// fields and tags, file a collection, and turn stored PDFs into linked files). The
// transport and - above all - the WRITE GATE were duplicated in each tool: authorize, carry the
// key, send the per-write token. That gate is what the contract's authorization rule rests on, so
// six copies of it would be six places to drift apart. The same argument holds for
// {@link visibleText}: the note tool compares what the library stored against what it sent, and two
// definitions of "the same text" would let it call a delivered note undelivered.
//
// TRANSPORT, and why this is not `fetch`: the local API answers HTTP/1.0, and an authorization request
// BLOCKS until the owner answers a dialog in the reference manager. `fetch` aborts that on its default
// headers timeout and reports the whole thing as a bare "fetch failed". These calls therefore use
// node:http with NO timeout - a request that legitimately waits for a human must not be given one.
//
// Reads need no authorization. Every write does, and the dialog that grants one is raised on EVERY
// request for a key: the local API has no "this application is already trusted" path, so the owner's
// "Always Allow" answer chooses the KIND of key issued and never whether they are asked again. What
// ends the asking is keeping the lasting key, which is what the grant store below does. "Allow" covers
// exactly one write and is never written down; a lasting grant is dropped the moment the library
// rejects it, because the owner revokes grants in the reference manager and a revocation arrives as a
// 401 rather than as a notification.

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 23119

/** The personal library every helper used before a library could be named. */
export const PERSONAL_LIBRARY = Object.freeze({ type: 'user', id: 0 })

/**
 * The API prefix one library answers under.
 *
 * Only `user:0` (the personal library) and `group:<id>` are accepted. A stranger's user id is not a
 * library this API serves, and falling back to `users/0` would read the wrong shelf without saying so.
 *
 * @param {{type: string, id: number}} [library] The library; defaults to the personal one.
 * @returns {string} `/api/users/0` or `/api/groups/<id>`.
 */
export function libraryPrefix(library = PERSONAL_LIBRARY) {
  const { type, id } = library ?? PERSONAL_LIBRARY
  if (type === 'user' && id === 0) return '/api/users/0'
  if (type === 'group' && Number.isInteger(id) && id > 0) return `/api/groups/${id}`
  throw new Error(`unsupported library ${JSON.stringify(library)}: expected user:0 or group:<id>`)
}

/**
 * Parse `--library` as `user:0` or `group:<id>`.
 *
 * @param {string} [value] The flag value; empty or absent means the personal library.
 * @returns {{type: string, id: number}} The library.
 * @throws {Error} When the value names a library this API cannot serve.
 */
export function parseLibrary(value) {
  const text = String(value ?? '').trim()
  if (text === '') return PERSONAL_LIBRARY
  const match = /^(user|users|group|groups)[:/](\d+)$/.exec(text)
  if (!match) throw new Error(`--library takes user:0 or group:<id>, got '${text}'`)
  const type = match[1].startsWith('group') ? 'group' : 'user'
  const id = Number(match[2])
  if (type === 'user' && id !== 0) {
    throw new Error('only the personal library (user:0) is served; a group is named group:<id>')
  }
  if (type === 'group' && id <= 0) throw new Error(`a group id must be positive, got ${id}`)
  return { type, id }
}

/** The `zotero://` prefix one library's refs share. */
export function libraryRef(library = PERSONAL_LIBRARY) {
  return `zotero://${library.type}/${library.id}`
}

/**
 * One item ref: the identity a read, a citation and a later write can all be replayed from.
 *
 * @param {string} key The item key.
 * @param {{type: string, id: number}} [library] The library.
 * @returns {string} `zotero://user/0/item/<key>`.
 */
export function itemRef(key, library = PERSONAL_LIBRARY) {
  return `${libraryRef(library)}/item/${key}`
}

/** One attachment ref. */
export function attachmentRef(key, library = PERSONAL_LIBRARY) {
  return `${libraryRef(library)}/attachment/${key}`
}

/** One collection ref. */
export function collectionRef(key, library = PERSONAL_LIBRARY) {
  return `${libraryRef(library)}/collection/${key}`
}

/**
 * The filesystem path behind a `file://` location, or '' when it is not a file URL.
 *
 * The local API answers an attachment read with a redirect to `file:///C:/...`; the path is what a
 * reader can open. A linked URL is not a file and returns '' so the caller reports the URL instead of
 * inventing a path.
 *
 * @param {string} location The `Location` header.
 * @returns {string} The path, or ''.
 */
export function filePathFrom(location) {
  const url = String(location ?? '')
  if (!url.startsWith('file:')) return ''
  return decodeURIComponent(url.replace(/^file:\/\/\/?/, '')).replace(/\//g, '\\')
}

/**
 * Whether an attachment location is a local file or a web URL.
 *
 * @param {string} location The `Location` header.
 * @returns {'file'|'url'} The kind.
 */
export function locationKind(location) {
  return /^https?:/i.test(String(location ?? '')) ? 'url' : 'file'
}

/**
 * The fields and creator types valid for one item type.
 *
 * The schema is the library's, not this repository's: a dataset and a patent have fields a journal
 * article does not, and a static whitelist would either refuse a valid edit or send one the library
 * rejects. A build that does not serve the endpoint answers 404, and `null` says "not knowable here"
 * rather than pretending the set is empty.
 *
 * @param {string} itemType The Zotero item type.
 * @returns {Promise<Set<string>|null>} The valid field names, or null when the build cannot say.
 */
export async function fieldNamesForType(itemType) {
  const rows = await itemTypeFields(itemType)
  if (rows === null) return null
  return new Set(rows.map((row) => row?.field).filter(Boolean))
}

/**
 * The rows `/itemTypeFields` answers for one item type.
 *
 * @param {string} itemType The Zotero item type.
 * @returns {Promise<object[]|null>} The rows, or null when the build does not serve the endpoint.
 */
export async function itemTypeFields(itemType) {
  const res = await localRequest('GET', `/api/itemTypeFields?itemType=${encodeURIComponent(itemType)}`)
  if (res.status === 404) return null
  if (res.status !== 200) throw new Error(`itemTypeFields answered ${res.status}: ${res.text.slice(0, 200)}`)
  const rows = JSON.parse(res.text)
  return Array.isArray(rows) ? rows : null
}

/** The item types this build serves. */
export async function itemTypes() {
  return getJson('/api/itemTypes')
}

/** The saved searches filed in one library. */
export async function savedSearches(library = PERSONAL_LIBRARY) {
  return getJson(`${libraryPrefix(library)}/searches?format=json&limit=100`)
}

/**
 * The library's current transaction version, and the instance that reported it.
 *
 * @param {{type: string, id: number}} [library] The library.
 * @returns {Promise<{version: number, serverId: string}>} The version (0 when the header is absent).
 */
export async function libraryVersion(library = PERSONAL_LIBRARY) {
  const res = await localRequest('GET', `${libraryPrefix(library)}/items/top?limit=1`)
  if (res.status !== 200) throw new Error(`the version probe answered ${res.status}: ${res.text.slice(0, 200)}`)
  return {
    version: Number(res.headers['last-modified-version'] ?? 0),
    serverId: String(res.headers['zotero-server-id'] ?? ''),
  }
}

/**
 * The top-level items whose version is newer than `since`.
 *
 * A build whose tombstone history does not reach back answers 409; a build that does not serve the
 * resource answers 404. Both mean "this range is not observable here", which is a finding the caller
 * reports rather than an empty diff.
 *
 * @param {number} since The library version to diff from.
 * @param {{type: string, id: number}} [library] The library.
 * @returns {Promise<{keys: string[], version: number, total: number, serverId: string, unsupported: boolean}>}
 *   The changed keys and the version the diff is pinned to.
 */
export async function changedItemsSince(since, library = PERSONAL_LIBRARY) {
  const res = await localRequest('GET', `${libraryPrefix(library)}/items/top?since=${since}&format=versions`)
  if (res.status === 404 || res.status === 409) {
    return { keys: [], version: since, total: 0, serverId: '', unsupported: true }
  }
  if (res.status !== 200) throw new Error(`the changes read answered ${res.status}: ${res.text.slice(0, 200)}`)
  const map = JSON.parse(res.text)
  const rows = map && typeof map === 'object' && !Array.isArray(map) ? map : {}
  return {
    keys: Object.keys(rows),
    version: Number(res.headers['last-modified-version'] ?? since),
    total: Number(res.headers['total-results'] ?? Object.keys(rows).length),
    serverId: String(res.headers['zotero-server-id'] ?? ''),
    unsupported: false,
  }
}

/**
 * Failures that mean "nothing answered at all", as opposed to something that answered badly.
 *
 * `ECONNRESET` is deliberately absent: a reset can arrive in the middle of a request, so it belongs to
 * the class a write tool reports as "sent but unconfirmed" rather than to "the library was never up".
 */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'])

/**
 * Where the reference manager answers, as `host:port`.
 *
 * The write gate carries a `transport` seam its self-test replaces, but a READ has none, and the
 * command-line path that decides **before** it opens that gate could therefore only be exercised
 * against the owner's real library. `ZOTERO_LOCAL_API` gives that path the same kind of seam the grant
 * file already has: a self-test stands a stub library up on a temporary port and points the tool at it.
 * It names an address rather than a credential, and an unset variable means the reference manager
 * exactly as before.
 *
 * A malformed value throws rather than falling back: silently talking to the real library while a test
 * believed it was talking to a stub is the one failure this seam must not have.
 *
 * @returns {{host: string, port: number}} The address to talk to.
 */
export function localOrigin() {
  const override = String(process.env.ZOTERO_LOCAL_API ?? '').trim()
  if (!override) return { host: DEFAULT_HOST, port: DEFAULT_PORT }
  const separator = override.lastIndexOf(':')
  const port = Number(override.slice(separator + 1))
  if (separator === -1 || !Number.isInteger(port) || port <= 0) {
    throw new Error(`ZOTERO_LOCAL_API must be host:port, got '${override}'`)
  }
  return { host: override.slice(0, separator), port }
}

/**
 * Turn "nothing answered" into an error that names the way out.
 *
 * A bare `ECONNREFUSED` says the socket was refused and nothing else: it reads like a broken
 * instrument, and an instrument that looks broken is what invites a caller to read the library by
 * another route - the database file, or the stored attachments picked out by path. Those routes lose
 * the record key, so what they read can be written onto nothing and checked by no reader. This is the
 * one place every helper passes through, so the sentence is written once here instead of seven times.
 *
 * What is changed is the prose and nothing else: `code` is carried over, and a failure that is not in
 * {@link UNREACHABLE_CODES} is returned as the same object, so a caller that classifies failures (the
 * write tools' unconfirmed branch does) keeps seeing what the transport saw.
 *
 * @param {Error & {code?: string}} error What the transport raised.
 * @returns {Error} The same error, or a new one whose message says what to do next.
 */
export function libraryUnreachable(error) {
  if (!UNREACHABLE_CODES.has(error?.code)) return error
  const { host, port } = localOrigin()
  const address = `${host}:${port}`
  const overridden = String(process.env.ZOTERO_LOCAL_API ?? '').trim() !== ''
  const message = overridden
    ? [
        `the address ${address} did not answer (${error.code}), and ZOTERO_LOCAL_API names it:`,
        'this run was pointed at a stub library or another instance, so the reference manager is not',
        'involved and nothing here will start it.',
      ].join('\n')
    : [
        `the reference library is not answering on ${address} (${error.code}).`,
        "The library is read only through the reference manager's own API; start it with",
        `    node "${fileURLToPath(new URL('./zotero-ensure.mjs', import.meta.url))}"`,
        'and run this command again. Its database and its stored attachments are not read by path:',
        'a reading that cannot name its record cannot be recorded onto it.',
      ].join('\n')
  const translated = new Error(message, { cause: error })
  translated.code = error.code
  return translated
}

/**
 * One request to the local API.
 *
 * `timeoutMs` exists for a PROBE and is `0` for everything else. An authorization request BLOCKS until
 * the owner answers a dialog, so giving it a timeout is how a legitimate write gets reported as a
 * failure; a caller deciding "is anything listening on this address" is the opposite case, and must not
 * be able to hang on a socket that accepted a connection and then said nothing.
 *
 * @param {string} method HTTP method.
 * @param {string} path Path beginning with `/api/`.
 * @param {{body?: string, headers?: Record<string, string>, timeoutMs?: number}} [options] A body is
 *   sent verbatim; `timeoutMs` defaults to 0, which is "wait as long as it takes".
 * @returns {Promise<{status: number, headers: object, text: string}>} The response, unparsed.
 */
export function localRequest(method, path, { body, headers = {}, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...localOrigin(),
        path,
        method,
        headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
      },
    )
    req.on('error', (error) => reject(libraryUnreachable(error)))
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        const error = new Error(`nothing answered within ${timeoutMs} ms`)
        // A real code, so a caller can tell "the socket said nothing" from "the library refused".
        error.code = 'ETIMEDOUT'
        req.destroy(error)
      })
    } else {
      req.setTimeout(0)
    }
    if (body) req.write(body)
    req.end()
  })
}

/**
 * A read whose body is JSON.
 *
 * @param {string} path Path beginning with `/api/`.
 * @returns {Promise<any>} The parsed body.
 * @throws {Error} When the API did not answer 200, naming the status instead of a parse failure.
 */
export async function getJson(path) {
  const res = await localRequest('GET', path)
  if (res.status !== 200) throw statusError(path, res)
  return JSON.parse(res.text)
}

/**
 * A non-200 answer, carrying the status as a FIELD rather than only as a number in a sentence.
 *
 * The same 404 means "that key is not in this library" to a reader and "no such collection" to a write,
 * and the remedy differs, so the transport keeps the fact and names no remedy. A caller that knows what
 * its own 404 means reads `error.status`; nothing anywhere parses this message.
 *
 * @param {string} path The path that was asked.
 * @param {{status: number, text: string}} res What answered.
 * @returns {Error} The error to throw, with `status` and `path` attached.
 */
function statusError(path, res) {
  const error = new Error(`${path} answered ${res.status}: ${res.text.slice(0, 200)}`)
  error.status = res.status
  error.path = path
  return error
}

/**
 * Identify the library. Every write must carry this server id, and it is also how a tool reports which
 * reference manager it is talking to.
 *
 * @returns {Promise<{id: string, version: string}>} The server id and the application version.
 * @throws {Error} When the API is unreachable or too old to expose a server id.
 */
export async function serverInfo() {
  const res = await localRequest('GET', '/api/')
  if (res.status !== 200) {
    throw new Error(`the local API answered ${res.status} - is it enabled in Settings, Advanced?`)
  }
  const id = res.headers['zotero-server-id']
  if (!id) throw new Error('no Zotero-Server-ID header: writes need Zotero 10 or newer')
  return { id, version: res.headers['x-zotero-version'] ?? '?' }
}

/**
 * One item's `data` object.
 *
 * @param {string} key An 8-character item key.
 * @param {{library?: {type: string, id: number}}} [options] The library to read from.
 * @returns {Promise<object>} The item data.
 */
export async function readItem(key, { library = PERSONAL_LIBRARY } = {}) {
  return (await getJson(`${libraryPrefix(library)}/items/${key}`)).data
}

/**
 * One item's child items - attachments and notes, and annotations when the filter names them.
 *
 * A bare listing never returns annotations: Zotero stores those under the PDF attachment, not under
 * the paper. `itemType: 'annotation'` is the filtered read that reaches them.
 *
 * @param {string} key An 8-character item key.
 * @param {{library?: {type: string, id: number}, itemType?: string}} [options] The library, and an
 *   optional child type filter.
 * @returns {Promise<object[]>} The children, as the API returns them.
 */
export async function childrenOf(key, { library = PERSONAL_LIBRARY, itemType = '' } = {}) {
  const filter = itemType ? `&itemType=${encodeURIComponent(itemType)}` : ''
  return getJson(`${libraryPrefix(library)}/items/${key}/children?format=json${filter}`)
}

/**
 * One attachment's annotations.
 *
 * @param {string} key The attachment key (annotations live under the PDF, not under the paper).
 * @param {{library?: {type: string, id: number}}} [options] The library.
 * @returns {Promise<object[]>} The annotation children.
 */
export async function annotationsOf(key, { library = PERSONAL_LIBRARY } = {}) {
  return childrenOf(key, { library, itemType: 'annotation' })
}

/**
 * `collections` is a bare string when there is one and an array when there are several.
 *
 * Every falsy value means "none": the library does not omit the field, it answers `false` for a
 * collection at the root, and `''`/`[]`/`null` appear in other shapes. Returning `[false]` for that
 * would make "no parent" compare unequal to itself.
 *
 * @param {string|string[]|false|null|undefined} value The field as the library returns it.
 * @returns {string[]} Always an array of keys.
 */
export function normalizeCollections(value) {
  if (!value) return []
  return Array.isArray(value) ? [...value] : [value]
}

/**
 * `tags` arrives as `[{tag}]` on a record and as plain strings in some shapes.
 *
 * @param {Array<object|string>|undefined} value The field as the library returns it.
 * @returns {string[]} The tag names, with nameless entries dropped rather than printed blank.
 */
export function normalizeTags(value) {
  if (!Array.isArray(value)) return []
  return value.map((tag) => (typeof tag === 'string' ? tag : (tag?.tag ?? ''))).filter(Boolean)
}

/**
 * The text a reader sees: tags and comments removed, whitespace collapsed.
 *
 * A note body is **not** stored byte-for-byte as it was sent. The application rewrites a note it has
 * edited - measured: the note gained a `<div data-schema-version="9">` wrapper and LOST the invisible
 * marker comment this preset writes - so two bodies that read identically can differ byte for byte,
 * and comparing bytes reports a mismatch on a write that in fact landed. That false alarm about the
 * owner's library is what every note comparison here exists to avoid. The definition lives in one
 * place because two note tools compare stored text against sent text, and two definitions of "the
 * same text" would let one of them call a delivered note undelivered.
 *
 * @param {string} html Note body as the library stores it.
 * @returns {string} Its visible text.
 */
export function visibleText(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * One collection's `data`.
 *
 * @param {string} key An 8-character collection key.
 * @param {{library?: {type: string, id: number}}} [options] The library to read from.
 * @returns {Promise<object>} The collection data - `name`, `parentCollection`, `version`.
 */
export async function readCollection(key, { library = PERSONAL_LIBRARY } = {}) {
  return (await getJson(`${libraryPrefix(library)}/collections/${key}`)).data
}

/**
 * Whether the library accepted a write.
 *
 * ANY 2xx is acceptance. A `PATCH` answers **204 No Content** when it succeeds - measured on the first
 * real write this preset ever made, 2026-10-15 - and treating 200 as the only success reported a
 * completed write as "the library refused it", which is the worst thing a write tool can say: a false
 * statement about whether the owner's library changed. A success therefore carries no body and the
 * read-back is what proves what happened.
 *
 * @param {number} status The HTTP status the library answered with.
 * @returns {boolean} True for 2xx.
 */
export function isWriteAccepted(status) {
  return status >= 200 && status < 300
}

/**
 * Whether the library's answer to a failed write leaves the outcome open.
 *
 * A request that never got an answer (status 0) and a server-side failure (5xx) may both have been
 * carried out: HTTP names a response, not an effect. Telling a caller "nothing was written" in either
 * case is how one write becomes two, so the tools say "unconfirmed" instead and name what they found.
 *
 * @param {number} status The status the channel answered, or 0 when it answered nothing.
 * @returns {boolean} True when the write may exist.
 */
export function mayHaveLanded(status) {
  return status === 0 || status >= 500
}

/**
 * Report a write whose outcome is not proven, and return the exit code that states it.
 *
 * Prints rather than throws, because the caller has already decided what to say about the write: this
 * only gives every tool the same words and the same exit code. The key is printed when one was found,
 * because the next step is to read that key, never to repeat the request.
 *
 * @param {{key?: string, what?: string, found?: string}} options `what` names the write, in the
 *   caller's own terms; `found` says what a read-back after the failure showed, when one was made.
 * @returns {number} Always 3: written or sent, and unconfirmed.
 */
export function reportUnconfirmed({ key = '', what = 'the write', found = '' }) {
  console.error(`\n${key ? 'WRITTEN BUT UNCONFIRMED' : 'SENT BUT UNCONFIRMED'}: ${what}.`)
  if (key) console.error(`It is ${key} - read that item before anything else.`)
  if (found) console.error(found)
  console.error('Do NOT resend it: a write that may exist is read before it is repeated.')
  return 3
}

/**
 * Read, refuse a stale change, patch, read back.
 *
 * The staleness check is OURS rather than the library's: the change is refused when the record's
 * version moved between the read the plan was built from and the write, so an edit made in the
 * application while this ran is never overwritten. The version precondition is still sent as a second
 * line of defence - a 412 re-reads and reports a conflict only when the version really did move,
 * because in local mode the library overloads 401/412/428 and a 412 is not by itself proof that
 * someone else edited the record.
 *
 * One call makes at most one write.
 *
 * @param {{gate: object, path: string, readCurrent: () => Promise<object>, patch: object, apply: boolean,
 *   beforeWrite?: () => void}} options `beforeWrite` runs immediately before the request is sent, so a
 *   caller can record that a write was attempted before anything can throw.
 * @returns {Promise<{applied: boolean, conflict: boolean, status: number, detail: string, before: object, after: object|null}>}
 *   `before` is what the plan was built from; on a conflict it is re-read and holds the library's
 *   current state. `detail` carries the library's own words when it refused the write.
 */
async function applyPatch({ gate, path, readCurrent, patch, apply, beforeWrite = undefined }) {
  const before = await readCurrent()
  if (!apply) return { applied: false, conflict: false, status: 0, detail: '', before, after: null }
  const fresh = await readCurrent()
  if (fresh.version !== before.version) {
    return { applied: false, conflict: true, status: 0, detail: '', before: fresh, after: null }
  }
  beforeWrite?.()
  const res = await gate.write('PATCH', path, patch, { 'If-Unmodified-Since-Version': String(fresh.version) })
  if (res.status === 412) {
    const current = await readCurrent()
    return {
      applied: false,
      conflict: current.version !== fresh.version,
      status: 412,
      detail: res.text.slice(0, 300),
      before: current,
      after: null,
    }
  }
  if (!isWriteAccepted(res.status)) {
    return { applied: false, conflict: false, status: res.status, detail: res.text.slice(0, 300), before: fresh, after: null }
  }
  return { applied: true, conflict: false, status: res.status, detail: '', before, after: await readCurrent() }
}

/** One version-guarded change to one item. `beforeWrite` runs immediately before the request is sent. */
export async function patchItem({ gate, key, patch, apply, beforeWrite }) {
  return applyPatch({
    gate,
    path: `/api/users/0/items/${key}`,
    readCurrent: () => readItem(key),
    patch,
    apply,
    beforeWrite,
  })
}

/** One version-guarded change to one collection. */
export async function patchCollection({ gate, key, patch, apply, beforeWrite }) {
  return applyPatch({
    gate,
    path: `/api/users/0/collections/${key}`,
    readCurrent: () => readCollection(key),
    patch,
    apply,
    beforeWrite,
  })
}

/**
 * What the owner sees in the authorization dialog. ONE name for every helper, because the grant is
 * kept per library rather than per tool: whichever helper happened to ask first would otherwise be
 * the only name the owner ever saw, which would say less than the truth.
 */
export const APP_NAME = 'DSH autoresearch preset'

/**
 * Where a lasting grant is kept.
 *
 * @returns {string} The absolute path of the grant file, overridable for a test or a second profile.
 */
export function grantFilePath() {
  const override = String(process.env.ZOTERO_LOCAL_KEY_STORE ?? '').trim()
  if (override !== '') return override
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
  return join(base, 'dsh-autoresearch', 'zotero-local-api-key.json')
}

/** A store holding no grants. Also what an unreadable or unrecognised file reads as. */
export function emptyGrantStore() {
  return { version: 1, grants: {} }
}

/**
 * Parse a grant file. A corrupt file, an unknown version or a malformed entry all mean "no grant
 * kept": the owner is asked again, which is the only safe direction for a credential.
 *
 * @param {string} text The file's contents, as read.
 * @returns {object} The store, with only the entries that carry a usable key.
 */
export function parseGrantStore(text) {
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1) return emptyGrantStore()
    const grants = {}
    for (const [serverId, entry] of Object.entries(data.grants ?? {})) {
      if (typeof entry?.key !== 'string' || entry.key === '') continue
      grants[serverId] = {
        key: entry.key,
        appName: String(entry.appName ?? ''),
        createdAt: String(entry.createdAt ?? ''),
      }
    }
    return { version: 1, grants }
  } catch {
    return emptyGrantStore()
  }
}

/**
 * The grant kept for one library, or null.
 *
 * Partitioned by server id because a key means nothing to the instance that did not issue it: the
 * same address pointed at a different data directory must produce a fresh dialog rather than a
 * string of incomprehensible 401s.
 *
 * @param {object} store A parsed grant store.
 * @param {string} serverId The `Zotero-Server-ID` the grant was issued by.
 * @returns {string|null} The key, or null when this library has no grant on file.
 */
export function keptGrant(store, serverId) {
  return store?.grants?.[serverId]?.key ?? null
}

/**
 * The store with one library's grant recorded. Pure: returns a new store.
 *
 * @param {object} store A parsed grant store.
 * @param {string} serverId The instance the grant belongs to.
 * @param {{key: string, appName: string, createdAt: string}} grant The grant to keep.
 * @returns {object} A new store.
 */
export function withGrant(store, serverId, grant) {
  const base = store ?? emptyGrantStore()
  return { version: 1, grants: { ...base.grants, [serverId]: { ...grant } } }
}

/**
 * The store with one library's grant dropped. Pure: returns a new store.
 *
 * @param {object} store A parsed grant store.
 * @param {string} serverId The instance whose grant is being forgotten.
 * @returns {object} A new store.
 */
export function withoutGrant(store, serverId) {
  const base = store ?? emptyGrantStore()
  const grants = { ...base.grants }
  delete grants[serverId]
  return { version: 1, grants }
}

/**
 * The grant file as a store.
 *
 * A read that fails is "no grant kept" rather than an error - the owner is simply asked again - but a
 * save that fails throws: a grant the owner believed they had given must never be lost in silence.
 *
 * @param {string} [path] The grant file; defaults to {@link grantFilePath}.
 * @returns {{load: () => object, save: (store: object) => void}} The store.
 */
export function fileGrantStore(path = grantFilePath()) {
  return {
    load() {
      try {
        return parseGrantStore(readFileSync(path, 'utf8'))
      } catch {
        return emptyGrantStore()
      }
    },
    save(store) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    },
  }
}

/**
 * The write gate.
 *
 * `open()` must be called first: the server id it returns is carried by every write, and a write
 * without it is refused by the reference manager.
 *
 * A grant the owner chose to make lasting is read from `store` and used without asking. "Allow" is
 * never written down and covers exactly one write. A key the library rejects is discarded, and a
 * lasting one leaves the store as well, so a grant the owner revoked in the reference manager recovers
 * by itself instead of failing forever. One `write()` raises at most two dialogs: a third could only
 * mean the library is issuing keys it then refuses.
 *
 * @param {{appName: string, store?: object, onAuthorized?: (info: {remember: boolean}) => void,
 *   onGrantDropped?: (info: {serverId: string}) => void, transport?: object}} options `appName` is
 *   what the owner sees in the dialog. `store` defaults to the grant file; `transport` is the seam the
 *   self-test replaces, and production callers pass nothing.
 * @returns {{open: () => Promise<{id: string, version: string, kept: boolean}>,
 *   write: (method: string, path: string, body?: any, extraHeaders?: object) => Promise<{status: number, headers: object, text: string}>}}
 */
export function createWriteGate({
  appName,
  store = fileGrantStore(),
  onAuthorized,
  onGrantDropped,
  transport = { serverInfo, localRequest },
}) {
  let serverId = null
  let grants = emptyGrantStore()
  let key = null
  let lasting = false

  async function authorize() {
    const res = await transport.localRequest('POST', '/api/local/authorize', {
      body: JSON.stringify({ appName }),
      headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': serverId },
    })
    // Every answer here arrives BEFORE the write is sent, so each one is a refusal in the sense the
    // exit codes use: nothing was written, and asking again is the right next step.
    const refusedError = (message) => {
      const error = new Error(message)
      error.refused = true
      return error
    }
    if (res.status === 403) throw refusedError('the authorization dialog was declined in the reference manager')
    if (res.status === 429) throw refusedError('too many authorization dialogs (limit 5/min) - wait a minute')
    if (res.status === 428) throw refusedError('the reference manager wants a Zotero-Server-ID header on this write')
    if (res.status === 401) throw refusedError('unauthorized: the key was rejected')
    if (res.status !== 200) throw refusedError(`authorize answered ${res.status}: ${res.text.slice(0, 200)}`)
    const body = JSON.parse(res.text)
    if (!body.key) throw refusedError('authorize returned no key')
    lasting = Boolean(body.remember)
    if (lasting) {
      grants = withGrant(grants, serverId, { key: body.key, appName, createdAt: new Date().toISOString() })
      store.save(grants)
    }
    onAuthorized?.({ remember: lasting })
    return body.key
  }

  /** Forget a rejected key. A lasting one leaves the store too, or every later run would retry it. */
  function dropKey() {
    if (lasting) {
      grants = withoutGrant(grants, serverId)
      store.save(grants)
      onGrantDropped?.({ serverId })
    }
    key = null
    lasting = false
  }

  return {
    async open() {
      const info = await transport.serverInfo()
      serverId = info.id
      grants = store.load()
      key = keptGrant(grants, serverId)
      lasting = key !== null
      return { ...info, kept: lasting }
    },

    /**
     * One authorized write. `Zotero-Write-Token` is fresh per attempt, and a key the library refuses
     * is dropped rather than resent: the next attempt asks the owner instead of replaying it.
     */
    async write(method, path, body, extraHeaders = {}) {
      if (!serverId) throw new Error('the write gate was not opened: call open() before writing')
      let dialogs = 0
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (key === null) {
          if (dialogs === 2) break
          dialogs += 1
          key = await authorize()
        }
        const sentLasting = lasting
        const res = await transport.localRequest(method, path, {
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            'Zotero-Server-ID': serverId,
            'Zotero-API-Key': key,
            'Zotero-Write-Token': randomUUID().replace(/-/g, ''),
            ...extraHeaders,
          },
        })
        // The library deletes a single-use key while validating the request that carried it, so it is
        // never reused - whether that request went on to succeed or not.
        if (!sentLasting) key = null
        if (res.status !== 401) return res
        dropKey()
      }
      const refused = new Error('the write was still refused with 401 after re-authorizing twice')
      // A refusal is the one failure that proves nothing was written, so the tools can say so with
      // exit 1 even though a write was attempted. Anything else thrown after this point stays open.
      refused.refused = true
      throw refused
    },
  }
}
