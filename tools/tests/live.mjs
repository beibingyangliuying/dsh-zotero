// The seam the end-to-end self-tests use: is a library there at all?
//
// Most of the suite is offline by construction - the tools take their I/O as an argument or a
// `ZOTERO_LOCAL_API` stub. One test runs a real program the way an owner would, and that path needs
// a running reference manager (and, for the metadata resolver, a network). A machine without one is
// not a broken checkout, so the test SKIPs rather than FAILs, and the suite counts the skip as green.
import { get } from 'node:http'
import { localOrigin } from '../zotero-local-api.mjs'

/** The address the tools would talk to, as `host:port`, honouring `ZOTERO_LOCAL_API`. */
export function libraryOrigin() {
  const { host, port } = localOrigin()
  return `${host}:${port}`
}

/**
 * Whether a local API answers right now.
 *
 * Any HTTP response counts - the point is that something is listening, not what it says - and the
 * probe is short: a closed library refuses the connection immediately. A reset is retried rather
 * than read as "absent": the local API drops connections under load (that is what the tool's own
 * retry is for), and a skip must mean the library is really not there.
 *
 * @param {{ attempts?: number, timeoutMs?: number }} [options] Retries and the wait per attempt.
 * @returns {Promise<boolean>} True when the address answered.
 */
export async function libraryAnswers({ attempts = 3, timeoutMs = 2500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await answersOnce(timeoutMs)) return true
  }
  return false
}

async function answersOnce(timeoutMs) {
  const { host, port } = localOrigin()
  return new Promise((done) => {
    let settled = false
    const settle = (answer) => {
      if (settled) return
      settled = true
      done(answer)
    }
    const request = get({ host, port, path: '/api/', timeout: timeoutMs }, (response) => {
      response.resume()
      settle(true)
    })
    request.on('timeout', () => request.destroy(new Error('timed out')))
    request.on('error', () => settle(false))
  })
}
