/**
 * Turns a reminder body (free text typed by an agent) into a small tree of blocks
 * and inline parts. It is pure data on purpose: the React side (ReminderBody.tsx)
 * maps the tree to elements, so nothing here can ever become raw HTML.
 *
 * The rules lean conservative. When a piece of text is not clearly a step, a list
 * item, a link or a shell command, it stays plain text.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; text: string };

export type Block =
  | { kind: "p"; lines: Inline[][] }
  | { kind: "ol"; start: number; items: Inline[][] }
  | { kind: "ul"; items: Inline[][] };

const COMMAND_WORDS = new Set([
  "python", "python3", "pnpm", "npm", "npx", "kubectl", "git", "curl", "az", "dotnet", "docker", "helm",
]);

// A bare command word in prose ("git is slow") must not turn into code, so the word
// right after it has to look like an argument: a flag, a path/file/assignment, or a
// well-known subcommand.
const SUBCOMMANDS = new Set([
  "get", "apply", "logs", "describe", "run", "test", "install", "build", "push", "pull", "checkout",
  "commit", "status", "diff", "rebase", "rollout", "login", "show", "list", "sync", "exec", "delete",
  "restart", "upgrade", "template", "merge", "fetch", "branch", "switch", "restore", "publish", "ps",
]);

// Words that end a command run, e.g. "python x.py and then wait".
const RUN_STOP_WORDS = new Set([
  "and", "or", "then", "until", "to", "in", "on", "for", "with", "so", "but", "when", "if", "which", "that",
  "after", "before", "while", "once", "because",
]);

const SHELL_OPERATORS = new Set(["&&", "||", "|", ">", ">>", "2>&1"]);
const ENV_ASSIGN_RE = /^[A-Z_][A-Z0-9_]*=\S*$/;
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]]+$/;

function looksLikeArg(token: string): boolean {
  if (token.startsWith("-")) return true;
  if (/[/\\._=]/.test(token)) return true;
  return SUBCOMMANDS.has(token.replace(TRAILING_PUNCT_RE, ""));
}

/** Splits plain text into text/code parts, marking obvious shell commands as code. */
function detectCommands(text: string): Inline[] {
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ value: m[0], start: m.index }));
  const out: Inline[] = [];
  let cursor = 0;
  let i = 0;

  while (i < tokens.length) {
    let j = i;
    while (j < tokens.length && ENV_ASSIGN_RE.test(tokens[j].value)) j++;
    const hasEnv = j > i;
    const word = tokens[j]?.value;
    const next = tokens[j + 1]?.value;
    const isCommand = word !== undefined && COMMAND_WORDS.has(word) && next !== undefined && looksLikeArg(next);

    if (!isCommand) {
      i = hasEnv ? j : i + 1;
      continue;
    }

    // Extend the run until a stop word or a token that ends the clause.
    let end = j + 1;
    for (let k = j + 2; k < tokens.length; k++) {
      const prev = tokens[k - 1].value;
      if (!SHELL_OPERATORS.has(prev) && /[.,;:]$/.test(prev)) break;
      if (RUN_STOP_WORDS.has(tokens[k].value)) break;
      end = k;
    }

    const from = tokens[i].start;
    const last = tokens[end];
    const to = last.start + last.value.replace(TRAILING_PUNCT_RE, "").length;
    if (from > cursor) out.push({ kind: "text", text: text.slice(cursor, from) });
    out.push({ kind: "code", text: text.slice(from, to) });
    cursor = to;
    while (i < tokens.length && tokens[i].start < to) i++;
  }

  if (cursor < text.length) out.push({ kind: "text", text: text.slice(cursor) });
  return out;
}

function splitUrls(text: string): Inline[] {
  const out: Inline[] = [];
  let cursor = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING_PUNCT_RE, "");
    if (m.index > cursor) out.push(...detectCommands(text.slice(cursor, m.index)));
    out.push({ kind: "link", href: url, text: url });
    cursor = m.index + url.length;
  }
  if (cursor < text.length) out.push(...detectCommands(text.slice(cursor)));
  return out;
}

/** Inline formatting for one line or step: `code` spans, then URLs, then bare commands. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const parts = text.split("`");
  // With an odd number of backticks the last one is unpaired: its tail stays text.
  const pairedCount = parts.length % 2 === 1 ? parts.length : parts.length - 1;
  parts.forEach((part, idx) => {
    if (idx >= pairedCount) {
      out.push(...splitUrls(idx === pairedCount ? "`" + part : part));
    } else if (idx % 2 === 1) {
      if (part.length > 0) out.push({ kind: "code", text: part });
    } else if (part.length > 0) {
      out.push(...splitUrls(part));
    }
  });
  return out;
}

const STEP_MARKER_RE = /(?:^|\s)(\d{1,2})\.\s+(?=\S)/g;

/**
 * "intro 1. a 2. b 3. c" -> intro + steps, when the markers count up from 1.
 * Needs at least two steps, so "see section 1. Then go" is left alone.
 */
function splitInlineSteps(line: string): { intro: string; steps: string[] } | null {
  const markers: { start: number; end: number }[] = [];
  let expected = 1;
  for (const m of line.matchAll(STEP_MARKER_RE)) {
    if (Number(m[1]) !== expected) continue;
    const lead = m[0].length - m[0].trimStart().length;
    markers.push({ start: m.index + lead, end: m.index + m[0].length });
    expected++;
  }
  if (markers.length < 2) return null;

  const steps = markers.map((mk, idx) => {
    const stop = idx + 1 < markers.length ? markers[idx + 1].start : line.length;
    return line.slice(mk.end, stop).trim();
  });
  return { intro: line.slice(0, markers[0].start).trim(), steps };
}

const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const NUMBERED_RE = /^\s*(\d{1,2})\.\s+(.*)$/;

export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  let para: Inline[][] | null = null;

  const pushText = (text: string) => {
    if (!para) {
      para = [];
      blocks.push({ kind: "p", lines: para });
    }
    para.push(parseInline(text));
  };
  const pushItem = (kind: "ol" | "ul", text: string, n = 1) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) last.items.push(parseInline(text));
    else if (kind === "ol") blocks.push({ kind, start: n, items: [parseInline(text)] });
    else blocks.push({ kind, items: [parseInline(text)] });
    para = null;
  };

  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.trim() === "") {
      para = null;
      continue;
    }
    const inline = splitInlineSteps(line);
    if (inline) {
      para = null;
      if (inline.intro) pushText(inline.intro);
      para = null;
      // A fresh list, even right after another one.
      blocks.push({ kind: "ol", start: 1, items: inline.steps.map(parseInline) });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      pushItem("ul", bullet[1]);
      continue;
    }
    const num = NUMBERED_RE.exec(line);
    if (num) {
      pushItem("ol", num[2], Number(num[1]));
      continue;
    }
    pushText(line.trim());
  }
  return blocks;
}
