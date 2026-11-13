// Pure helpers for the "search BAB first" line under a failed Bash command (register.tsx, tool.call).
// No imports: tests load this file on its own.

/**
 * A failed test or build that still exits 0: the agent piped it ("npm test 2>&1 | head -60", the eval
 * sessions all did), so only the output tells. Each pattern is a runner's own failure line, anchored to a
 * line start or a word boundary, and a count must be nonzero, so "0 failed", FAIL_FAST=true or a
 * "FAILED" inside code do not count.
 */
export const FAILURE_IN_OUTPUT_RE = new RegExp(
  [
    // TAP: a failed test, and the summary with a nonzero count.
    /^not ok \d/,
    /^#\s*fail\s+[1-9]/,
    // jest, vitest, go test (--- FAIL: and FAIL<tab>pkg), pytest (FAILED path::test).
    /^\s*(?:--- )?FAIL(?:ED)?(?=[\s:]|$)/,
    // "1 failed, 11 passed", "Tests  2 failed | 3 passed", "=== 1 failed in 0.1s ===", mocha "2 failing".
    /\b[1-9]\d* (?:failed|failing)\b/,
    // pytest stopping before any test ran: "Interrupted: 1 error during collection".
    /\bInterrupted: [1-9]\d* errors? during collection\b/,
    // npm before and after version 10.
    /^npm (?:ERR!|error )/,
    // A thrown error printed at a line start: "TypeError: x", "Error: x".
    /^\s*\w*Error: /,
    // Compilers: tsc "error TS2304:", cargo "error[E0425]:" and "error: could not compile".
    /\berror TS\d+:/,
    /^error(?:\[E\d+\])?: /,
    // A command that reports its own nonzero exit.
    /\b(?:exited|failed|terminated) with (?:exit )?(?:code|status) [1-9]\d*/,
    /^make(?:\[\d+\])?: \*\*\* .*Error [1-9]\d*/,
    /\bfailed with [1-9]\d* errors?\b/,
    // The shell's own words: "bash: foo: command not found", "zsh: command not found: foo".
    /^[\w./-]+: (?:.*: )?command not found\b/,
  ]
    .map(r => r.source)
    .join('|'),
  'm',
)

/** errno and npm codes a failed command prints: ENOENT, ECONNREFUSED, ELIFECYCLE, E404. Not any capitalised word. */
const ERRNO = [
  'ACCES', 'ADDRINUSE', 'ADDRNOTAVAIL', 'AI_AGAIN', 'BADENGINE', 'BUSY', 'CONNABORTED', 'CONNREFUSED', 'CONNRESET',
  'EXIST', 'HOSTUNREACH', 'INTEGRITY', 'INVAL', 'ISDIR', 'LIFECYCLE', 'MFILE', 'NETUNREACH', 'NOENT', 'NOMEM',
  'NOSPC', 'NOTDIR', 'NOTEMPTY', 'NOTFOUND', 'NOTSUP', 'PERM', 'PIPE', 'RESOLVE', 'ROFS', 'TIMEDOUT',
]

/** The error name in a failed command's output, if it has one: "LedgerSyncError", "TypeError", "error TS2304", "ENOENT". */
export const ERROR_NAME_RE = new RegExp(
  `\\b([A-Z][A-Za-z]*(?:Error|Exception)|error [A-Z]+\\d+|ERR_[A-Z0-9_]+|E(?:${ERRNO.join('|')})|E[45]\\d\\d)\\b`,
)

/** Commands that only read or print: their output may quote a failure without being one. */
const READ_ONLY = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'ls', 'dir', 'tree', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd',
  'wc', 'sort', 'uniq', 'cut', 'tr', 'echo', 'printf', 'pwd', 'cd', 'which', 'type', 'file', 'stat', 'du', 'df',
  'diff', 'cmp', 'jq', 'yq', 'sed', 'awk', 'realpath', 'dirname', 'basename', 'true', 'test', 'nl', 'column',
])
/** git subcommands that only read. */
const GIT_READ_ONLY = new Set([
  'log', 'show', 'diff', 'status', 'grep', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'shortlog',
  'cat-file', 'reflog',
])

/** The git subcommand after git's own options: "git -C repo diff" is "diff". */
function gitSubcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!
    if (w === '-C' || w === '-c') i++
    else if (!w.startsWith('-')) return w
  }
  return ''
}

/** True for one simple command (no pipes or lists) that only reads. */
function isReadOnlySegment(segment: string): boolean {
  const words = segment
    .trim()
    .replace(/^[({]\s*/, '')
    .split(/\s+/)
    .filter(Boolean)
  // Leading VAR=value assignments and a time or command prefix do not change what runs.
  while (words.length && (/^\w+=/.test(words[0]!) || words[0] === 'time' || words[0] === 'command')) words.shift()
  const head = words[0]
  if (!head) return true
  const name = head.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
  const rest = words.slice(1)
  if (name === 'git') return GIT_READ_ONLY.has(gitSubcommand(rest))
  if (!READ_ONLY.has(name)) return false
  // An in-place edit or a find that runs or deletes is not a read.
  if (name === 'sed' && rest.some(w => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'))) return false
  if (name === 'find' && rest.some(w => w === '-delete' || w === '-exec' || w === '-execdir' || w === '-ok')) return false
  return true
}

/**
 * True when every part of the command (split on pipes, &&, || and ;) only reads: "cat log | grep FAIL" or
 * "git log | head". "npm test | head" is not, since npm runs the tests. A quoted | or ; splits a word
 * wrongly, which only ever makes a command count as not read-only, as before this check.
 */
export function isReadOnlyCommand(command: string): boolean {
  const segments = command.split(/&&|\|\||[|;\n]/).filter(s => s.trim())
  return segments.length > 0 && segments.every(isReadOnlySegment)
}

/**
 * Interrupted by the person or refused by the host, not stuck: Claude Code's own words ("Interrupted by
 * user", "requires approval", "permission to use Bash"). A command's own "permission denied" (EACCES)
 * or pytest's "Interrupted: 1 error during collection" is a real failure and still counts.
 */
const NOT_STUCK_RE = /\binterrupted by (?:the )?user\b|\brequest interrupted\b|\bpermissions? to use\b|\bdenied by\b|\brequires approval\b|\bhaven't granted\b/i

/**
 * The key of the error a Bash result shows, or null when it is not a stuck moment: a read-only command,
 * an interrupted or refused one, or a success whose output shows no failure. The key is the error name
 * when the output has one, else the start of the command, so one error is nudged about once.
 */
export function stuckKey(command: string, text: string, isError: boolean): string | null {
  if (isReadOnlyCommand(command)) return null
  if (NOT_STUCK_RE.test(text.slice(0, 200))) return null
  if (!isError && !FAILURE_IN_OUTPUT_RE.test(text)) return null
  return ERROR_NAME_RE.exec(text)?.[1] ?? command.trim().slice(0, 60)
}
