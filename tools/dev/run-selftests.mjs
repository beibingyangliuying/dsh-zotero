#!/usr/bin/env node
// Run every self-test this package ships, in one command, discovered from disk.
//
// The list is DERIVED, not hand-written: a new `*-selftest.mjs` under `tools/` runs the day it
// lands. A hand-written list has one failure mode and this repository has seen it — a test is added
// and the list is not, so the new guard runs in nobody's round.
//
// Offline is the point: every test here must pass without a Zotero instance, a network, or DSH
// running. Tests that would need one take their I/O as an argument or refuse to run, which is why
// the suite is safe in CI and on a laptop with the library closed.
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
  const run = spawnSync(process.execPath, [path], { cwd: ROOT, stdio: 'inherit' })
  results.push({ path, passed: run.status === 0, detail: run.status === 0 ? '' : `exit ${run.status}` })
}

console.log('\n--- suite ---')
for (const { path, passed, detail } of results) {
  console.log(`  ${(passed ? 'PASS' : 'FAIL').padEnd(10)} ${path}${detail ? `  (${detail})` : ''}`)
}
const failed = results.filter((result) => !result.passed).length
console.log(`\n${results.length} self-test(s): ${results.length - failed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
