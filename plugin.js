// The one tool this package publishes: a door to the fifteen channel programs it ships.
//
// WHY A TOOL AND NOT A SKILL
//
// The programs are command-line programs, so a session can reach them through the shell. What a shell
// cannot do is TELL an agent they exist: nothing in a bare profile mentions this package, and until an
// agent knows a program's name it will not run it. A skill would solve that with a description that
// loads with every request anyway; a single tool does it with one schema that also runs the program, so
// the "discover then use" step is one call rather than a shell command the agent has to compose.
//
// WHAT IT DOES NOT DO
//
// It does not mount the library, does not keep state, and does not interpret a program's output. It
// spawns one program, returns what the program printed, and lets the agent read it - the programs own
// their own refusals and their own exit-code meanings.
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-zotero'

/** The tool registry this row contributes to. */
export const inject = ['tools']

const PACKAGE_ROOT = fileURLToPath(new URL('./', import.meta.url))

/** One program's public face: what it is for, and one command that actually works. */
const CATALOG = [
  {
    program: 'zotero-read',
    purpose: 'read the library: full-text search, one item or note, BM25 passages, collections, item-type schema, change cursor, DOI lookup',
    example: '--search "seismic risk" --limit 10',
  },
  {
    program: 'zotero-write',
    purpose: 'add one item by DOI or arXiv id, optionally filing it into a collection; a dry run unless --write is given',
    example: '--doi 10.1000/xyz --write',
  },
  {
    program: 'zotero-edit',
    purpose: "change an item's fields or tags; a dry run unless --write is given",
    example: '--item ABCD1234 --set title="A new title" --write',
  },
  {
    program: 'zotero-remark',
    purpose: 'replace the single remark line of an item whose old value you must state; a dry run unless --write is given',
    example: '--item ABCD1234 --new-line "rate: 2" --expect-current "rate: 3" --write',
  },
  {
    program: 'zotero-collection',
    purpose: 'list, create, rename or assign collections; every write is a dry run unless --write is given',
    example: '--list',
  },
  {
    program: 'zotero-export',
    purpose: 'formatted citations, bibliographies and BibTeX/RIS/CSL-JSON exports, through the library own translators',
    example: '--item ABCD1234 --format bibtex',
  },
  {
    program: 'zotero-pdf',
    purpose: 'the attachment side: its outline, its text layer, or a page rendered to an image; rungs are chosen one per call',
    example: '--item ABCD1234 --extract',
  },
  {
    program: 'zotero-ensure',
    purpose: 'make the library answer, or say why it will not: probes the local API and starts the application when it is not running',
    example: '--wait 30',
  },
  {
    program: 'zotero-link-attachments',
    purpose: 'convert stored PDFs into linked files under a target directory; a dry run unless --write is given',
    example: '--target "D:\\Store"',
  },
  {
    program: 'zotero-section-note',
    purpose: 'one explanation note per top-level section: coverage plan, claim, rewrite, retire; writes need --write',
    example: '--item ABCD1234',
  },
  {
    program: 'arxiv',
    purpose: 'the preprint index: its own query syntax, records by id, Atom parsing that refuses to print an error feed as a record',
    example: "--search 'au:hinton' --max 10",
  },
  {
    program: 'metadata',
    purpose: 'bibliographic REST over OpenAlex/Crossref/Unpaywall: identifiers, search, references, citations, open-access lookup, citation formatting',
    example: '--doi 10.1038/s41586-021-03819-2',
  },
  {
    program: 'scholarly',
    purpose: 'discovery across arXiv/OpenAlex/Crossref/Semantic Scholar/PubMed/Europe PMC/DBLP with weighted RRF dedup and a library mark',
    example: '--search "retrieval augmented generation" --limit 10',
  },
  {
    program: 'scholarly-read',
    purpose: 'open-access full text by identifier: arXiv HTML, ar5iv, PMC JATS, or an open-access PDF, with outline and passage lookup',
    example: '--id 10.1038/s41586-021-03819-2 --outline',
  },
  {
    program: 'journal-rank',
    purpose: "one journal's provider reading (partition and rank), by journal name or DOI",
    example: '--journal "Reliability Engineering & System Safety"',
  },
]

/** The largest output one call returns. A program's own --limit is the cheaper cut; this is the backstop. */
const MAX_OUTPUT = 60_000

/** How long one program may run. Generous: several of them make a network request. */
const TIMEOUT_MS = 120_000

/**
 * The programs a caller may run, read from disk so a program that lands here is callable the same day.
 *
 * Libraries are excluded on purpose: `zotero-local-api` and `scholarly-sources` are imported by other
 * programs and have no entry point of their own, so running one would produce an empty success.
 */
export function programNames() {
  try {
    return readdirSync(join(PACKAGE_ROOT, 'tools'))
      .filter((file) => file.endsWith('.mjs'))
      .map((file) => file.slice(0, -'.mjs'.length))
      .filter((name) => name !== 'zotero-local-api' && name !== 'scholarly-sources')
      .filter((name) => CATALOG.some((entry) => entry.program === name))
      .sort()
  } catch {
    return []
  }
}

/** The catalog as the text an agent reads when it calls the tool with no arguments. */
export function catalogText() {
  const lines = [
    'The external-channel programs this package ships. Call this tool again with `program` and `args` to run one.',
    '',
  ]
  for (const entry of CATALOG) {
    lines.push(`${entry.program}`)
    lines.push(`  ${entry.purpose}`)
    lines.push(`  e.g. args: ["${entry.example}"]`)
    lines.push('')
  }
  lines.push('Arguments are passed to the program directly, without a shell: one array element per shell word,')
  lines.push('no quoting, no globbing, no pipes. A program that writes is a dry run unless --write is in its args.')
  return lines.join('\n')
}

/** Cut one program's output down to what one result can carry, saying what was left out and where. */
export function clip(text, max = MAX_OUTPUT) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = Math.max(0, Math.floor(max * 0.15))
  const omitted = text.length - head - tail
  return [
    text.slice(0, head),
    `… [${omitted} characters omitted; narrow the query or use the program's own --limit/--offset] …`,
    text.slice(text.length - tail),
  ].join('\n')
}

/** What one finished run looks like to the agent. The exit code is printed because the programs give it meaning. */
export function formatRun(code, stdout, stderr) {
  const parts = [`exit ${code}`]
  if (stdout.length > 0) parts.push('', stdout.trimEnd())
  if (stderr.length > 0) parts.push('', '--- stderr ---', stderr.trimEnd())
  return clip(parts.join('\n'))
}

/** Run one program and resolve with what it printed; never rejects, because a refusal is a result. */
function runProgram(program, args, signal) {
  const file = join(PACKAGE_ROOT, 'tools', `${program}.mjs`)
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [file, ...args],
      { cwd: PACKAGE_ROOT, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) })
        const timedOut = error.killed === true
        const code = typeof error.code === 'number' ? error.code : 1
        resolve({
          code,
          stdout: String(stdout),
          stderr: timedOut ? `${String(stderr)}\n[the program was stopped after ${TIMEOUT_MS / 1000} s]` : String(stderr),
        })
      },
    )
  })
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'zotero',
    description:
      'The external-channel programs this package ships: the local reference library (search, read, write, notes, export) and five metadata channels (arXiv, bibliographic REST, discovery, open-access reading, journal ranking). ' +
      'Call with no arguments to list every program with its purpose and a working example. ' +
      'Call with `program` and `args` to run one; arguments go to the program directly, without a shell. ' +
      'Printing costs nothing here - no library is mounted and no tool is added per channel.',
    parameters: {
      type: 'object',
      properties: {
        program: {
          type: 'string',
          description: 'Program name without the .mjs extension, exactly as the list prints it. Omit to get the list.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments for that program, one array element per shell word. No quoting is needed and none is removed.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (args.program === undefined) return { text: catalogText() }
      const available = programNames()
      if (!available.includes(args.program)) {
        return {
          text: `no program named "${args.program}". The available programs are:\n${available.join(', ')}\n\nCall this tool with no arguments for what each one does.`,
        }
      }
      const result = await runProgram(args.program, args.args ?? [], exec?.signal)
      return { text: formatRun(result.code, result.stdout, result.stderr) }
    },
  })
}
