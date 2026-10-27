#!/usr/bin/env node
// Self-test for the one tool this package publishes, offline.
//
// What is load-bearing here: the tool must be REGISTERED with the shape the registry validates, the
// catalog must name the programs that actually exist (a stale list is how an agent runs a program that
// is gone), and the program white list must refuse a name that is not one of them - including a path.
// The last assertions run a real program end to end, because "it registers" says nothing about whether
// a call reaches the library side at all.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, catalogText, clip, formatRun, programNames } from '../../plugin.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

let failures = 0
const check = (condition, label, detail = '') => {
  console.log(`  ${condition ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`)
  if (!condition) failures += 1
}

console.log('channel tool self-test')

// --- the registration -----------------------------------------------------------------------------

const registered = []
apply({ tools: { register: (tool) => registered.push(tool) } })
const tool = registered[0] ?? {}

check(registered.length === 1, 'apply registers exactly one tool', `count=${registered.length}`)
check(tool.name === 'zotero', 'the tool carries the documented name', String(tool.name))
check(typeof tool.description === 'string' && tool.description.length > 200, 'the description explains the two call shapes')
check(tool.description.includes('no arguments'), 'the description says a call with no arguments lists the programs')
check(tool.parameters?.type === 'object' && tool.parameters.properties?.program !== undefined, 'the parameters carry `program`')
check(tool.parameters?.additionalProperties === false, 'unknown parameters are refused by the schema')
check(typeof tool.output?.render === 'function', 'the output carries a renderer')
check(tool.output?.schema?.required?.includes('text'), 'the output schema requires the text field')

// --- the catalog against the programs on disk ------------------------------------------------------

const names = programNames()
check(names.length === 15, 'fifteen entry programs are callable', `${names.length}: ${names.join(', ')}`)
for (const expected of ['zotero-read', 'zotero-write', 'zotero-edit', 'zotero-remark', 'zotero-collection', 'zotero-export', 'zotero-pdf', 'zotero-ensure', 'zotero-link-attachments', 'zotero-section-note', 'arxiv', 'metadata', 'scholarly', 'scholarly-read', 'journal-rank']) {
  check(names.includes(expected), `callable: ${expected}`)
}
for (const library of ['zotero-local-api', 'scholarly-sources', 'refusal']) {
  check(!names.includes(library), `a library is not callable: ${library}`)
}

// Every callable program exists as a file, and the catalog names nothing that is missing.
const onDisk = readdirSync(join(ROOT, 'tools')).filter((file) => file.endsWith('.mjs')).map((file) => file.slice(0, -4))
check(names.every((name) => onDisk.includes(name)), 'every callable program exists on disk')
const text = catalogText()
check(names.every((name) => text.includes(`\n${name}\n`)), 'the catalog names every callable program on its own line')
check((text.match(/e\.g\. args:/g) ?? []).length === names.length, 'every program carries one example', String((text.match(/e\.g\. args:/g) ?? []).length))
check(text.includes('without a shell'), 'the catalog states that arguments do not pass through a shell')
check(text.includes('dry run unless --write'), 'the catalog states the write rule')

// --- a name that is not a program ------------------------------------------------------------------

const refuse = async (program) => (await tool.execute({ program }, {})).text
let refused = await refuse('../zotero-read')
check(refused.includes('no program named'), 'a path-shaped name is refused', refused.split('\n')[0])
refused = await refuse('zotero-local-api')
check(refused.includes('no program named'), 'a library name is refused, not silently run')
check(refused.includes('zotero-read'), 'the refusal lists what is available')
const listed = await tool.execute({}, {})
check(listed.text === catalogText(), 'a call with no program returns the catalog')

// --- one real program, end to end ------------------------------------------------------------------

// `--selftest` is the one mode a streaming program offers that writes nothing and needs no library.
const result = await tool.execute({ program: 'zotero-write', args: ['--selftest'] }, {})
check(result.text.startsWith('exit 0'), 'a real program runs and reports its exit code', result.text.split('\n')[0])
check(!result.text.includes('--- stderr ---') || result.text.includes('stderr'), 'stderr only appears when the program wrote to it')

// --- the two text transforms -----------------------------------------------------------------------

check(clip('short') === 'short', 'a short output is not touched')
const long = 'x'.repeat(200_000)
const clipped = clip(long, 1000)
check(clipped.length < 2000, 'a long output is cut to the budget', `${clipped.length} chars`)
check(clipped.includes('characters omitted'), 'and says what it left out')
check(clip(long, 1000).includes('narrow the query'), 'and says how to get the rest')

const failed = formatRun(3, 'written but unconfirmed', 'the record may already carry the change')
check(failed.startsWith('exit 3'), 'the exit code leads, because the programs give it meaning')
check(failed.includes('--- stderr ---'), 'stderr is marked apart from stdout')

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exitCode = failures === 0 ? 0 : 1
