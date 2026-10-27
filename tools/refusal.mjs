// One voice for failures.
//
// A reader meets the same facts every time a helper stops: what did not happen, what to do next, and
// - when a write was already sent - whether it MAY have landed. The first two live here so that ten
// programs cannot each invent an eleventh layout.
//
// The remedy travels WITH the error, from the site that knows what the request meant. Nothing here
// inspects a message for keywords: a 404 on a record key and a 404 on a metadata channel are the same
// status and different situations, and only the throwing site can tell them apart. A helper that does
// not know the next action throws a plain Error and gets no `fix` line - a guessed remedy turns
// "retry" into "drift", and drift is the expensive failure in this channel.
//
// Exit codes are returned rather than applied: three tools answer "sent, and then the connection
// failed" with 3, and that decision belongs to the caller that remembers what it had already sent.

/** A malformed command line. Exit 2, and the caller prints the usage block beneath it. */
export class UsageError extends Error {}

/** A request the channel refused, where exactly one next action is known. Exit 1. */
export class Refusal extends Error {
  /**
   * @param {string} what What did not happen, in the reader's terms.
   * @param {object} [details] What is known about the way out.
   * @param {string} [details.fix] The one next action, in prose, when there is exactly one.
   * @param {string} [details.command] A command that works as printed - no placeholders.
   * @param {string[]} [details.checked] Places that were looked at and did not answer.
   */
  constructor(what, { fix = '', command = '', checked = [] } = {}) {
    super(what)
    this.name = 'Refusal'
    this.fix = fix
    this.command = command
    this.checked = checked
  }
}

/** The label column every block in this suite already uses (`library : `, `state   : `). */
const LABEL_WIDTH = 8

/**
 * The message a reader sees, with the underlying socket failure appended when it adds something.
 *
 * `code !== cause.code` is what keeps this quiet for the transport's own refusals: those already name
 * the code in their sentence, and repeating it as a cause would read like a second, different fault.
 *
 * @param {unknown} error Whatever was thrown.
 * @returns {string} One message, possibly multi-line.
 */
function messageOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error ? error.cause : undefined
  const code = cause?.code ?? cause?.message
  if (code === undefined || code === error?.code) return message
  return `${message} (cause: ${code})`
}

/**
 * One labelled field, its continuation lines indented under the value column.
 *
 * @param {string} label Field name.
 * @param {string} text Value, possibly multi-line.
 * @param {number} width Label column width.
 * @returns {string[]} The lines.
 */
function field(label, text, width) {
  const indent = ' '.repeat(width + 2)
  const [first, ...rest] = String(text).split('\n')
  return [`${label.padEnd(width)}: ${first}`, ...rest.map((line) => indent + line)]
}

/**
 * The failure block, as lines. Pure: it writes nothing and decides no exit code, so the shape can be
 * asserted offline and the caller keeps its own way of leaving.
 *
 * A plain Error renders as the one line it always did, so nothing that was already readable regresses;
 * a Refusal adds only the fields it actually carries.
 *
 * @param {unknown} error Whatever was thrown.
 * @param {object} [options]
 * @param {number} [options.width] Label column width.
 * @returns {string[]} Lines, without a leading blank line.
 */
export function refusalLines(error, { width = LABEL_WIDTH } = {}) {
  const lines = field('ERROR', messageOf(error), width)
  if (!(error instanceof Refusal)) return lines
  if (error.fix) lines.push(...field('fix', error.fix, width))
  if (error.command) lines.push(...field('try', error.command, width))
  if (error.checked.length > 0) lines.push(...field('checked', error.checked.join('\n'), width))
  return lines
}

/**
 * The script this process is running, as the absolute path its reader needs.
 *
 * A usage block is written by hand and names the program the repository-relative way (`node
 * tools/<name>.mjs`), which is correct for someone standing in this checkout and wrong for the agent
 * that meets it: the agent's working directory is a study workspace, which carries no `tools/`. Rather
 * than restating the path in eighteen programs, one line here names the path the reader can actually
 * use. Node resolves `argv[1]` to an absolute path, so no import and no filesystem call is needed.
 */
const ENTRY_PATH = typeof process.argv[1] === 'string' ? process.argv[1] : ''

/** The line that turns a repository-relative usage block into something a study round can run. */
const ENTRY_LINE = ENTRY_PATH === ''
  ? ''
  : `This script is at ${ENTRY_PATH} - invoke it by that absolute path; a relative tools/... does not resolve in a study workspace.`

/**
 * Write the failure block and return the exit code the caller must set.
 *
 * The blank line in front separates the block from whatever the tool printed before it failing; the
 * usage block keeps its old place directly under the message, so a malformed command still reads as
 * one paragraph rather than as a failure report. A usage block also carries the absolute path of the
 * script it describes, because the relative one it prints by hand names nothing outside this checkout.
 *
 * @param {unknown} error Whatever was thrown.
 * @param {object} [options]
 * @param {string} [options.usage] The usage block to print under a UsageError.
 * @param {function(string): void} [options.write] Where the block goes; injected for the self-test.
 * @param {number} [options.width] Label column width.
 * @returns {number} 2 for a malformed command line, 1 for everything else.
 */
export function reportFailure(error, { usage = '', write = (text) => console.error(text), width = LABEL_WIDTH } = {}) {
  if (error instanceof UsageError) {
    const lines = [usage ? `${error.message}\n${usage}` : error.message]
    if (ENTRY_LINE) lines.push(ENTRY_LINE)
    write(lines.join('\n'))
    return 2
  }
  write(`\n${refusalLines(error, { width }).join('\n')}`)
  return 1
}
