#!/usr/bin/env node
// Run every self-test this package ships, in one command, discovered from disk.
//
// The list is DERIVED, not hand-written: a new `*-selftest.mjs` under `tools/` runs the day it
// lands. A hand-written list has one failure mode and this repository has seen it — a test is added
// and the list is not, so the new guard runs in nobody's round.
//
// Mostly offline: a test here takes its I/O as an argument or stands a stub library up through
// `ZOTERO_LOCAL_API`, so the suite runs with the library closed. The exceptions are the end-to-end
// checks that need a running Zotero (and, for the metadata resolvers, a network): those print a
// `SKIP` line when the thing they need is absent, and this runner counts a skip as green - a closed
// library is a normal state, not a failing checkout.
//
// Usage:
//   node tools/dev/run-selftests.mjs                # everything
//   node tools/dev/run-selftests.mjs --list         # what a run would execute, and exit
//   node tools/dev/run-selftests.mjs --only zotero  # only matching paths
//
// Exit codes: 0 every test passed | 1 at least one failed.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** Every `*-selftest.mjs` under `tools/`, as paths relative to the package root, sorted. */
function discoverTests() {
  const found = []
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name)
      if (name.isDirectory()) {
        if (name.name !== 'node_modules') walk(full)
        continue
      }
      if (name.name.endsWith('-selftest.mjs')) found.push(relative(ROOT, full))
    }
  }
  walk(join(ROOT, 'tools'))
  return found.sort()
}

const argv = process.argv.slice(2)
const onlyIndex = argv.indexOf('--only')
const only = onlyIndex === -1 ? undefined : argv[onlyIndex + 1]
const tests = discoverTests().filter((path) => only === undefined || path.includes(only))

if (argv.includes('--list')) {
  for (const path of tests) console.log(path)
  console.log(`\n${tests.length} self-test(s)`)
  process.exit(0)
}
if (only !== undefined && tests.length === 0) {
  console.error(`no self-test path contains "${only}"`)
  process.exit(2)
}

const results = []
for (const path of tests) {
  console.log(`\n=== ${path} ===`)
  const run = spawnSync(process.execPath, [path], { cwd: ROOT, encoding: 'utf8' })
  if (run.stdout) process.stdout.write(run.stdout)
  if (run.stderr) process.stderr.write(run.stderr)
  const passed = run.status === 0
  const skipped = passed && /^\s*SKIP\b/m.test(run.stdout ?? '')
  results.push({ path, passed, skipped, detail: passed ? '' : `exit ${run.status}` })
}

console.log('\n--- suite ---')
for (const { path, passed, skipped, detail } of results) {
  const label = skipped ? 'SKIP' : passed ? 'PASS' : 'FAIL'
  console.log(`  ${label.padEnd(10)} ${path}${detail ? `  (${detail})` : ''}`)
}
const failed = results.filter((result) => !result.passed).length
const skipped = results.filter((result) => result.skipped).length
console.log(`\n${results.length} self-test(s): ${results.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
