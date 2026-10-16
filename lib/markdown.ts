/**
 * A small markdown parser for memory bodies, written for agent-authored text.
 *
 * It returns a tree that app/components/Markdown.tsx renders as React elements, so no HTML
 * from a body ever reaches the page: raw HTML in a body is shown as text. Links keep only
 * http, https, mailto and same-site paths; anything else renders as its text. Images
 * render as a link, so a memory cannot make every reader's browser fetch a remote URL.
 *
 * Agent texts differ from hand-written markdown in two ways the parser follows:
 * a single newline is a line break (agents rarely leave blank lines), and a list may
 * start right under a paragraph line. Underscores only mark emphasis at word edges, so
 * names like extract_sddr_from_lines stay intact.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "pre"; lang: string | null; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

/** Deeper nesting than this renders as plain text, so a hostile body cannot blow the stack. */
const MAX_DEPTH = 8;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*$)/;
const TABLE_SEP = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, "").length;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  return i + 1 < lines.length && lines[i].includes("|") && lines[i + 1].includes("-") && TABLE_SEP.test(lines[i + 1]) &&
    splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
}

/** True when the line starts a block other than a paragraph, so it ends the paragraph above it. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  const item = ITEM.exec(line);
  const itemStarts = item !== null && (!/\d/.test(item[2]) || parseInt(item[2], 10) === 1);
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || itemStarts || isTableStart(lines, i);
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return parseBlocks(lines, 0);
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    if (depth >= MAX_DEPTH) {
      const rest = lines.slice(i).join("\n").trim();
      if (rest) out.push({ t: "p", c: [{ t: "text", v: rest }] });
      break;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // the closing fence, or past the end
      out.push({ t: "pre", lang: fence[2] || null, v: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: "h", level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const q = QUOTE.exec(lines[i]);
        if (q) inner.push(q[1]);
        else if (startsBlock(lines, i)) break;
        else inner.push(lines[i]); // a lazy continuation line
        i++;
      }
      out.push({ t: "quote", c: parseBlocks(inner, depth + 1) });
      continue;
    }

    if (ITEM.test(line)) {
      i = parseList(lines, i, depth, out);
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((c): Align => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? "")));
        i++;
      }
      out.push({ t: "table", align, head: head.map((c) => parseInline(c)), rows });
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    out.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return out;
}

/** Parses one list starting at line i, appends it to out and returns the next line index. */
function parseList(lines: string[], i: number, depth: number, out: Block[]): number {
  const first = ITEM.exec(lines[i])!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items: Block[][] = [];
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || Math.abs(m[1].length - base) > 1 || /\d/.test(m[2]) !== ordered) break;
    // The item's own lines: its first line, then anything indented past the marker,
    // and unindented lazy continuation lines that do not start a block.
    const contentIndent = base + m[2].length + 1;
    const body: string[] = [m[3] ?? ""];
    let fence: string | null = FENCE.exec(body[0])?.[1] ?? null;
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (fence) {
        // Inside a fenced block everything belongs to the item until the fence closes.
        const ind = indentOf(l);
        const line = l.slice(Math.min(ind, contentIndent));
        body.push(line);
        if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
        i++;
        continue;
      }
      if (isBlank(l)) {
        // A blank line continues the item only when indented content follows it.
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) > base) {
          for (; i < j; i++) body.push("");
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      const sibling = ITEM.exec(l);
      if (ind > base + 1 || (ind > base && !sibling)) {
        const line = l.slice(Math.min(ind, contentIndent));
        body.push(line);
        fence = FENCE.exec(line)?.[1] ?? null;
      } else if (!sibling && !startsBlock(lines, i)) {
        body.push(l.trim());
      } else {
        break;
      }
      i++;
    }
    items.push(parseBlocks(body, depth + 1));
    // Blank lines between items keep the list going.
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j++;
    const next = j < lines.length ? ITEM.exec(lines[j]) : null;
    if (j > i && next && Math.abs(next[1].length - base) <= 1 && /\d/.test(next[2]) === ordered) i = j;
  }
  out.push({ t: "list", ordered, start, items });
  return i;
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const ESCAPABLE = "`*_[]#!|~<>";

/** A link target the page may follow: http(s), mailto, or a path on this site. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (SAFE_HREF.test(href)) return href;
  if (href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\") && !/^\/api(?:[/?#]|$)/i.test(href)) return href;
  if (href.startsWith("#")) return href;
  return null;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** Index just past the code span opening at i, or -1 when its backtick run has no match. */
function codeSpanEnd(s: string, i: number): number {
  let n = 0;
  while (s[i + n] === "`") n++;
  const run = "`".repeat(n);
  let j = i + n;
  while (true) {
    const k = s.indexOf(run, j);
    if (k < 0) return -1;
    let m = 0;
    while (s[k + m] === "`") m++;
    if (m === n) return k + n;
    j = k + m;
  }
}

/** Finds the closing delimiter for emphasis opened at `from`, skipping code spans and escapes. */
function findCloser(s: string, from: number, delim: string): number {
  for (let k = from; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\") {
      k++;
      continue;
    }
    if (ch === "`") {
      const end = codeSpanEnd(s, k);
      if (end > 0) {
        k = end - 1;
        continue;
      }
      while (s[k + 1] === "`") k++;
      continue;
    }
    if (ch === "\n" && s[k + 1] === "\n") return -1;
    if (s.startsWith(delim, k) && k > from && !isSpace(s[k - 1])) {
      // A single * or _ must not be part of a longer run (that is the ** closer of an outer span).
      if (delim.length === 1 && s[k + 1] === delim) {
        k++;
        continue;
      }
      if (delim[0] === "_" && isWordChar(s[k + delim.length])) continue;
      return k;
    }
  }
  return -1;
}

/** Index of the `]` matching the `[` at i, or -1. */
function matchBracket(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    if (s[k] === "\\") {
      k++;
      continue;
    }
    if (s[k] === "`") {
      const end = codeSpanEnd(s, k);
      if (end > 0) k = end - 1;
      continue;
    }
    if (s[k] === "[") depth++;
    else if (s[k] === "]" && --depth === 0) return k;
  }
  return -1;
}

/** Parses `(url "title")` at i; returns the url and the index past `)`, or null. */
function linkTarget(s: string, i: number): { url: string; end: number } | null {
  if (s[i] !== "(") return null;
  let depth = 0;
  for (let k = i; k < s.length && s[k] !== "\n"; k++) {
    if (s[k] === "(") depth++;
    else if (s[k] === ")" && --depth === 0) {
      const inner = s.slice(i + 1, k).trim();
      const url = inner.startsWith("<") ? inner.slice(1, inner.indexOf(">") >>> 0) : inner.split(/\s+/)[0];
      return { url, end: k + 1 };
    }
  }
  return null;
}

const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i;

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Length of a bare URL once trailing punctuation (it belongs to the sentence) and closing
 * brackets with no opener inside the URL are dropped. One pass each way, so it stays linear.
 */
function trimUrlEnd(url: string): number {
  const open: Record<string, number> = { "(": 0, "[": 0, "{": 0 };
  const close: Record<string, number> = { "(": 0, "[": 0, "{": 0 };
  for (const ch of url) {
    if (ch in open) open[ch]++;
    else if (ch in CLOSERS) close[CLOSERS[ch]]++;
  }
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if (".,;:!?*_~'\"".includes(ch)) end--;
    else if (ch in CLOSERS && close[CLOSERS[ch]] > open[CLOSERS[ch]]) {
      close[CLOSERS[ch]]--;
      end--;
    } else break;
  }
  return end;
}

export function parseInline(s: string, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  const deeper = depth + 1 < MAX_DEPTH;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (ch === "\\" && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) {
      text += s[i + 1];
      i++;
      continue;
    }

    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      continue;
    }

    if (ch === "`") {
      const end = codeSpanEnd(s, i);
      if (end < 0) {
        while (s[i + 1] === "`") text += s[i++];
        text += "`";
        continue;
      }
      let n = 0;
      while (s[i + n] === "`") n++;
      let code = s.slice(i + n, end - n).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      flush();
      out.push({ t: "code", v: code });
      i = end - 1;
      continue;
    }

    if (!inLink && (ch === "[" || (ch === "!" && s[i + 1] === "["))) {
      const open = ch === "!" ? i + 1 : i;
      const close = matchBracket(s, open);
      const target = close > 0 ? linkTarget(s, close + 1) : null;
      if (target) {
        const label = s.slice(open + 1, close);
        const href = safeHref(target.url);
        flush();
        const children = deeper ? parseInline(label || target.url, depth + 1, true) : [{ t: "text" as const, v: label }];
        if (!href) {
          // Not a link we may follow: keep the source as written, e.g. arr[i](args).
          text += s.slice(i, open + 1);
          i = open;
          continue;
        }
        out.push({ t: "link", href, c: children });
        i = target.end - 1;
        continue;
      }
    }

    if (!inLink && ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (m) {
        flush();
        out.push({ t: "link", href: m[1], c: [{ t: "text", v: m[1].replace(/^mailto:/i, "") }] });
        i += m[0].length - 1;
        continue;
      }
    }

    if (!inLink && (ch === "h" || ch === "H") && !isWordChar(s[i - 1])) {
      const m = BARE_URL.exec(s.slice(i));
      if (m) {
        const url = m[0].slice(0, trimUrlEnd(m[0]));
        flush();
        out.push({ t: "link", href: url, c: [{ t: "text", v: url }] });
        i += url.length - 1;
        continue;
      }
    }

    if (deeper && (ch === "*" || ch === "_" || ch === "~")) {
      let run = 0;
      while (s[i + run] === ch) run++;
      const canOpen = !isSpace(s[i + run]) && !(ch === "_" && isWordChar(s[i - 1]));
      if (canOpen && ch === "~" && run === 2) {
        const close = findCloser(s, i + 2, "~~");
        if (close > 0) {
          flush();
          out.push({ t: "del", c: parseInline(s.slice(i + 2, close), depth + 1, inLink) });
          i = close + 1;
          continue;
        }
      }
      if (canOpen && ch !== "~" && run >= 3) {
        const close = findCloser(s, i + 3, ch.repeat(3));
        if (close > 0) {
          flush();
          out.push({ t: "strong", c: [{ t: "em", c: parseInline(s.slice(i + 3, close), depth + 2, inLink) }] });
          i = close + 2;
          continue;
        }
      }
      if (canOpen && ch !== "~" && run >= 2) {
        const delim = ch + ch;
        const close = findCloser(s, i + 2, delim);
        if (close > 0) {
          flush();
          out.push({ t: "strong", c: parseInline(s.slice(i + 2, close), depth + 1, inLink) });
          i = close + 1;
          continue;
        }
      }
      if (canOpen && ch !== "~" && run === 1) {
        const close = findCloser(s, i + 1, ch);
        if (close > 0) {
          flush();
          out.push({ t: "em", c: parseInline(s.slice(i + 1, close), depth + 1, inLink) });
          i = close;
          continue;
        }
      }
      text += s.slice(i, i + run);
      i += run - 1;
      continue;
    }

    text += ch;
  }
  flush();
  return out;
}

/**
 * The body as one line of plain text, for list previews: markers dropped, link text kept,
 * code kept as written.
 */
export function markdownToPlainText(src: string): string {
  const parts: string[] = [];
  const inline = (c: Inline[]) => {
    for (const n of c) {
      if (n.t === "text" || n.t === "code") parts.push(n.v);
      else if (n.t === "br") parts.push(" ");
      else inline(n.c);
    }
  };
  const blocks = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === "p" || b.t === "h") inline(b.c);
      else if (b.t === "pre") parts.push(b.v);
      else if (b.t === "quote") blocks(b.c);
      else if (b.t === "list") b.items.forEach((it) => blocks(it));
      else if (b.t === "table") [b.head, ...b.rows].forEach((r) => r.forEach((cell) => { inline(cell); parts.push(" "); }));
      parts.push(" ");
    }
  };
  blocks(parseMarkdown(src));
  return parts.join("").replace(/\s+/g, " ").trim();
}
