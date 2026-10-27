// The absolute directory of the helpers this package ships.
//
// A consumer (the dsh-autoresearch preset) resolves THIS module by package subpath and reads
// `cliToolsDir`, instead of guessing an install location or walking the profile's node_modules. The
// path comes from this module's own URL, so it is correct wherever the package is installed — a
// checkout, a junction in a DSH profile, or an npm install.
//
// Forward slashes are kept deliberately: Windows accepts them, and a path pasted into a shell
// command or a prompt needs no escaping that way. The trailing slash is dropped so a caller can
// write `<cliToolsDir>/zotero-read.mjs`.
import { fileURLToPath } from 'node:url'

/** Absolute directory holding the command-line helpers, forward-slashed, no trailing slash. */
export const cliToolsDir = fileURLToPath(new URL('./tools/', import.meta.url))
  .replace(/\\/g, '/')
  .replace(/\/+$/, '')
