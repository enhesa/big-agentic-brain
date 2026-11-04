#!/usr/bin/env node
// Backfills a Command Center work log from past agent sessions, in two steps.
//
//   draft   reads session transcripts (JSONL) on this machine, splits them into work blocks and
//           drafts one `worked` line per block. It writes a draft file for the person to review.
//           It uploads nothing.
//   sync    reads the sessions active in the last days and drafts one `current` initiative record
//           per session or group of sessions (title, plan tasks, open blocked question), so a fresh
//           Command Center page shows what is going on now. It uploads nothing.
//   upload  sends the reviewed draft lines and current records (include: true) to a single-use
//           backfill link that the person's agent minted with bab_command_center action=backfill_link.
//
// Transcript text never leaves this machine except as the prompt to the drafting model (when one
// is configured), and then only as a capped excerpt with secret-shaped strings, email addresses
// and backfill links masked (maskExcerpt). It never lands in the draft files, the console or the
// upload. Only the drafted line does. Lines that look like secrets are flagged and left out until
// the person reviews them.
//
// Node built-ins only. The pure functions are exported for tests; main() runs only when this
// file is invoked directly.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const USAGE = `Usage:
  node scripts/cc-backfill.mjs draft --out <draft.json> [options]
  node scripts/cc-backfill.mjs sync --out <draft.json> [--projects-dir <dir>] [--map <file.json>] [--days <n>] [--max <n>]
  node scripts/cc-backfill.mjs upload --draft <draft.json> [--url <link> ...] [--from <n>] [--dry-run]

draft options:
  --out <file.json>       draft to write; also writes <file>.md and <file>.map-template.json
  --projects-dir <dir>    transcripts folder, reads <dir>/*/*.jsonl (default: ~/.claude/projects)
  --map <file.json>       mapping rules { "rules": [ { "initiative", "title", "key", "sessionId", "titleMatch",
                          "cwd", "repo", "branch", "keys" } ] }. A rule matches when all its given fields
                          match. Precedence: rules with sessionId, then titleMatch (session title,
                          case-insensitive substring, or /regex/), then cwd/repo/branch, then keys only;
                          file order within each
  --map-from-sync <sync.json>
                          a reviewed sync draft: a block no --map rule matched goes to the initiative
                          its session got there (records with include: true only), else by its
                          session title. Run sync with a long --days and --max 100 for this
  --retry-errors          read the draft at --out and draft again only its entries with an error;
                          every other entry stays as it is (not with --since, --until, --settle-hours)
  --since <date>          only blocks starting at or after this date or ISO time (a date is UTC midnight)
  --until <date>          only blocks starting before the end of this date, or before this ISO time
  --settle-hours <n>      skip blocks that ended less than n hours ago (default 2)
  --machine <name>        machine name sent with each entry: 1 to 20 of A-Z a-z 0-9 . _ -
                          (default: this host name, reduced and cut to 20)
  --concurrency <n>       drafting requests at once, 1 to 4 (default 2)
  --no-llm                write a template line per block instead of asking a model

  Without --no-llm, draft needs BAB_BACKFILL_BASE_URL, BAB_BACKFILL_MODEL and BAB_BACKFILL_API_KEY_ENV
  (the name of the variable that holds the API key). It posts to <base>/v1/messages.

sync options (the current state of recent sessions as initiatives, for a fresh Command Center page):
  --out <file.json>       draft to write, with "current" records; also writes <file>.md
  --projects-dir <dir>    as for draft
  --map <file.json>       as for draft; a matching rule names the initiative, and a rule with
                          initiative "unassigned" leaves its sessions out
  --days <n>              sessions active in the last n days, 1 to 365 (default 14)
  --max <n>               include at most n initiatives, the most recent, 1 to 100 (default 20;
                          the server creates at most 20 new initiatives per upload)

  Per session: its last plan (update_plan or TodoWrite), its open blocked question (the last
  wrap_up, if no later user turn answered it), its title, repo and branch. A plan reads finished
  only when the last wrap_up recap starts with "Done"; the wrap_up's own check-off is ignored.
  Sessions with the same title count once (the most recent). Sessions sharing a ticket key (in
  branch or title), or the same repo and non-trunk branch, are one initiative; its id is the slug
  of its title. Every record is listed; only ones with a plan are include: true. Text is masked;
  a record with masked or secret-shaped text is flagged and set include: false.

upload options:
  --draft <file.json>     the reviewed draft; only entries with include: true and a worked line are sent,
                          and current records with include: true (with the first link, --from 0 only)
  --url <link>            a backfill link (https, or http on loopback). One upload per link; repeat
                          --url to send more batches. Without --url, the link is read from
                          BAB_BACKFILL_LINK, which keeps it off the command line
  --from <n>              skip the first n sendable entries (to continue after an earlier upload)
  --dry-run               print counts and the first 3 lines, send nothing`;

export const MAX_ENTRIES = 2000;
export const MAX_BYTES = 1024 * 1024;
export const GAP_MS = 30 * 60 * 1000;
export const EXCERPT_CHARS = 4000;
export const WORKED_MAX = 200;
export const TITLE_MAX = 120;
export const MACHINE_MAX = 20; // the server's source.machine limit
export const SESSION_MAX = 60; // the server's source.session limit
// The server's publish limits for a `current` record.
export const MAX_CURRENT = 100;
export const AREA_MAX = 40;
export const CC_MAX_TASKS = 50;
export const TASK_TEXT_MAX = 120;
export const CC_MAX_QUESTIONS = 5;
export const QUESTION_TEXT_MAX = 500;
export const CC_MAX_OPTIONS = 4;
export const OPTION_MAX = 60;
const TASK_STATUSES = ["pending", "in_progress", "done"];
// Routes, and the server's own initiative for unmapped work: never a derived initiative id.
const RESERVED_IDS = ["export", "backfill", "unassigned"];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const KEY_FIND_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,100}$/;
const MACHINE_RE = /^[A-Za-z0-9._-]{1,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;
const DRAFT_KIND = "bab-cc-backfill-draft";
const UPLOAD_FIELDS = ["id", "initiative", "title", "key", "worked", "size", "at", "session", "machine"];
const RULE_MATCH_FIELDS = ["sessionId", "titleMatch", "cwd", "repo", "branch", "keys"];
const RULE_FIELDS = ["initiative", "title", "key", ...RULE_MATCH_FIELDS];

/** A usage or input error: printed as is, exit code 2. Never holds a secret value. */
export class CliError extends Error {}

// ---------------------------------------------------------------------------------------------
// Transcripts

/** The text a message carries: a string, or the `text` blocks of an array. Nothing else. */
function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Turns one JSONL line into an event, or null to skip it. An event has { session, ms, role, text,
 * cwd, branch }; `text` is "" for activity that counts for timing but not as a turn (a tool result,
 * a command wrapper, an assistant line with only tool calls).
 */
export function parseLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  if (o.type !== "user" && o.type !== "assistant") return null;
  if (o.isSidechain === true) return null;
  if (typeof o.sessionId !== "string" || !SESSION_RE.test(o.sessionId)) return null;
  if (typeof o.timestamp !== "string") return null;
  const ms = Date.parse(o.timestamp);
  if (!Number.isFinite(ms)) return null;
  let text = messageText(o.message?.content).trim();
  if (o.type === "user" && (o.toolUseResult !== undefined || text.startsWith("<"))) text = "";
  return {
    session: o.sessionId,
    ms,
    role: o.type,
    text,
    cwd: typeof o.cwd === "string" ? o.cwd : "",
    branch: typeof o.gitBranch === "string" ? o.gitBranch : "",
  };
}

/** The default transcripts folder. Only a path; nothing is read here. */
export function defaultProjectsDir() {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Calls `onFile(lines)` for each <dir>/*\/*.jsonl (one level) with its non-blank lines, and
 * returns the number of files.
 */
function walkTranscripts(dir, onFile) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new CliError(`projects dir not found: ${dir}`);
  let files = 0;
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subDir = path.join(dir, sub.name);
    for (const f of fs.readdirSync(subDir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      files++;
      const raw = fs.readFileSync(path.join(subDir, f.name), "utf8");
      onFile(raw.split(/\r?\n/).filter((l) => l.trim()));
    }
  }
  return files;
}

/**
 * Reads <dir>/*\/*.jsonl (one level) and returns events grouped by session, plus each session's
 * title as sync reads it (the last custom title, else the last AI title; in memory only).
 */
export function readTranscripts(dir) {
  const sessions = new Map();
  const named = new Map();
  const files = walkTranscripts(dir, (lines) => {
    for (const line of lines) {
      const e = parseLine(line);
      if (e) {
        if (!sessions.has(e.session)) sessions.set(e.session, []);
        sessions.get(e.session).push(e);
        continue;
      }
      if (!line.includes("-title")) continue;
      const t = parseSyncLine(line);
      if (t?.role !== "title") continue;
      if (!named.has(t.session)) named.set(t.session, { custom: "", ai: "" });
      named.get(t.session)[t.title.source] = t.title.text;
    }
  });
  const titles = new Map([...named].map(([s, n]) => [s, n.custom || n.ai]));
  return { sessions, files, titles };
}

/** Splits one session's events into blocks at gaps over 30 minutes. Drops blocks without a user and an assistant turn. */
export function splitBlocks(events) {
  const sorted = [...events].sort((a, b) => a.ms - b.ms);
  const groups = [];
  let cur = [];
  for (const e of sorted) {
    if (cur.length && e.ms - cur[cur.length - 1].ms > GAP_MS) {
      groups.push(cur);
      cur = [];
    }
    cur.push(e);
  }
  if (cur.length) groups.push(cur);
  const blocks = [];
  for (const g of groups) {
    const userTurns = g.filter((e) => e.role === "user" && e.text).length;
    const assistantTurns = g.filter((e) => e.role === "assistant" && e.text).length;
    if (!userTurns || !assistantTurns) continue;
    const last = (field) => [...g].reverse().find((e) => e[field])?.[field] ?? "";
    const startMs = g[0].ms;
    const endMs = g[g.length - 1].ms;
    blocks.push({
      id: `${g[0].session}:${startMs}`,
      session: g[0].session,
      startMs,
      endMs,
      minutes: Math.round((endMs - startMs) / 60000),
      turns: userTurns + assistantTurns,
      cwd: last("cwd"),
      branch: last("branch"),
      repo: repoOf(last("cwd")),
      // Kept in memory only, for the prompt and key matching. Never written anywhere.
      text: g.filter((e) => e.text).map((e) => `${e.role === "user" ? "User" : "Assistant"}: ${e.text}`).join("\n"),
    });
  }
  return blocks;
}

function repoOf(cwd) {
  if (!cwd) return "";
  const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "";
}

/** small under 30 minutes, medium under 2 hours, else large. */
export function sizeOf(minutes) {
  if (minutes < 30) return "small";
  if (minutes < 120) return "medium";
  return "large";
}

/** Parses --since / --until. A bare date is UTC midnight; for --until it means the end of that day. */
export function parseBound(value, flag, endOfDay = false) {
  if (DATE_RE.test(value)) {
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(ms)) throw new CliError(`${flag} must be a date YYYY-MM-DD or an ISO time`);
    return endOfDay ? ms + 24 * 60 * 60 * 1000 : ms;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new CliError(`${flag} must be a date YYYY-MM-DD or an ISO time`);
  return ms;
}

/**
 * All blocks from all sessions, filtered by the settle window and since/until, sorted by start.
 * @param {Map<string, any[]>} sessions
 * @param {{ now: number, settleHours?: number, since?: number, until?: number }} opts
 */
export function collectBlocks(sessions, { now, settleHours = 2, since, until, titles }) {
  const settleMs = settleHours * 60 * 60 * 1000;
  const out = [];
  for (const events of sessions.values()) {
    for (const b of splitBlocks(events)) {
      if (now - b.endMs < settleMs) continue;
      if (since !== undefined && b.startMs < since) continue;
      if (until !== undefined && b.startMs >= until) continue;
      // The session title, in memory only: for titleMatch rules and the masked template list.
      b.title = titles?.get(b.session) ?? "";
      out.push(b);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------
// Mapping

/** Checks a mapping file's content. A rule needs an initiative and at least one match field. */
export function validateMap(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.rules)) throw new CliError('map must be { "rules": [ ... ] }');
  return raw.rules.map((r, i) => {
    const at = `map rules[${i}]`;
    if (!r || typeof r !== "object") throw new CliError(`${at} must be an object`);
    for (const k of Object.keys(r)) if (!RULE_FIELDS.includes(k)) throw new CliError(`${at}: unknown field ${k}`);
    if (typeof r.initiative !== "string" || (r.initiative !== "unassigned" && !SLUG_RE.test(r.initiative))) {
      throw new CliError(`${at}: initiative must be a slug (a-z, 0-9, -) or "unassigned"`);
    }
    if (r.title !== undefined && (typeof r.title !== "string" || !r.title.trim() || r.title.length > TITLE_MAX)) {
      throw new CliError(`${at}: title must be text of 1 to ${TITLE_MAX} characters`);
    }
    if (r.key !== undefined && (typeof r.key !== "string" || !KEY_RE.test(r.key))) throw new CliError(`${at}: key must look like KEY-1`);
    if (!RULE_MATCH_FIELDS.some((f) => r[f] !== undefined)) throw new CliError(`${at}: give at least one of ${RULE_MATCH_FIELDS.join(", ")}`);
    let sessionIds;
    if (r.sessionId !== undefined) {
      const list = Array.isArray(r.sessionId) ? r.sessionId : [r.sessionId];
      if (!list.length || list.some((s) => typeof s !== "string" || !SESSION_RE.test(s))) {
        throw new CliError(`${at}: sessionId must be a session id or a non-empty list of them`);
      }
      sessionIds = new Set(list.map((s) => s.slice(0, SESSION_MAX)));
    }
    let titleRe;
    if (r.titleMatch !== undefined) {
      if (typeof r.titleMatch !== "string" || !r.titleMatch.trim()) throw new CliError(`${at}: titleMatch must be a non-empty string`);
      if (/^\/.+\/[a-z]+$/s.test(r.titleMatch)) throw new CliError(`${at}: titleMatch /.../ takes no flags (it is always case-insensitive)`);
      const m = /^\/(.+)\/$/s.exec(r.titleMatch);
      if (m) {
        try {
          titleRe = new RegExp(m[1], "i");
        } catch {
          throw new CliError(`${at}: titleMatch /.../ is not a valid regular expression`);
        }
      }
    }
    for (const f of ["cwd", "repo", "branch"]) {
      if (r[f] !== undefined && (typeof r[f] !== "string" || !r[f])) throw new CliError(`${at}: ${f} must be a non-empty string`);
    }
    let branchRe;
    if (r.branch !== undefined) {
      try {
        branchRe = new RegExp(r.branch);
      } catch {
        throw new CliError(`${at}: branch is not a valid regular expression`);
      }
    }
    if (r.keys !== undefined && (!Array.isArray(r.keys) || !r.keys.length || r.keys.some((k) => typeof k !== "string" || !KEY_RE.test(k)))) {
      throw new CliError(`${at}: keys must be a non-empty list of keys like KEY-1`);
    }
    const tier = sessionIds ? 0 : r.titleMatch !== undefined ? 1 : r.cwd !== undefined || r.repo !== undefined || r.branch !== undefined ? 2 : 3;
    return { ...r, index: i, tier, sessionIds, titleRe, branchRe, cwdRe: r.cwd !== undefined && /[*?]/.test(r.cwd) ? globToRe(r.cwd) : undefined };
  });
}

function globToRe(glob) {
  const norm = glob.replace(/\\/g, "/");
  let src = "";
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === "*") {
      if (norm[i + 1] === "*") {
        src += ".*";
        i++;
      } else src += "[^/]*";
    } else if (c === "?") src += "[^/]";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`, "i");
}

/** The keys (KEY-1 style) found in a block's branch and text. */
export function keysOf(block) {
  return new Set([...(block.branch.match(KEY_FIND_RE) ?? []), ...(block.text.match(KEY_FIND_RE) ?? [])]);
}

/** A rule list sorted by precedence, cached per list (validateMap's lists are never changed). */
const ORDERED_RULES = new WeakMap();

/**
 * The rule for a block (or a sync session state), or null. A rule matches when all its given
 * fields match. Rules are tried by precedence, then in file order: rules with sessionId, then
 * with titleMatch, then with cwd, repo or branch, then keys-only rules. `block` has { session,
 * title, cwd, repo, branch, text }; title and text stay in memory only.
 */
export function matchRule(block, rules) {
  const cwd = String(block.cwd ?? "").replace(/\\/g, "/");
  const title = String(block.title ?? "");
  const session = String(block.session ?? "").slice(0, SESSION_MAX);
  let keys;
  let ordered = ORDERED_RULES.get(rules);
  if (!ordered) {
    ordered = [...rules].sort((a, b) => (a.tier ?? 2) - (b.tier ?? 2) || a.index - b.index);
    ORDERED_RULES.set(rules, ordered);
  }
  for (const r of ordered) {
    const hit = [];
    if (r.sessionIds !== undefined) {
      if (!r.sessionIds.has(session)) continue;
      hit.push("sessionId");
    }
    if (r.titleMatch !== undefined) {
      const ok = r.titleRe ? r.titleRe.test(title) : title.toLowerCase().includes(r.titleMatch.toLowerCase());
      if (!title || !ok) continue;
      hit.push("titleMatch");
    }
    if (r.cwd !== undefined) {
      const ok = r.cwdRe ? r.cwdRe.test(cwd) : cwd.toLowerCase().includes(r.cwd.replace(/\\/g, "/").toLowerCase());
      if (!ok) continue;
      hit.push("cwd");
    }
    if (r.repo !== undefined) {
      if (block.repo !== r.repo) continue;
      hit.push("repo");
    }
    if (r.branch !== undefined) {
      if (!r.branchRe.test(block.branch)) continue;
      hit.push("branch");
    }
    if (r.keys !== undefined) {
      keys ??= keysOf(block);
      if (!r.keys.some((k) => keys.has(k))) continue;
      hit.push("keys");
    }
    return { rule: r, mappedBy: `rule ${r.index + 1} (${hit.join(", ")})` };
  }
  return null;
}

/**
 * Distinct repos, branches and branch keys among unmapped blocks, so the person can write rules.
 * Keys come from branch names only, never from transcript text: the template is a file on disk.
 */
export function mapTemplate(unmapped) {
  const repos = new Set();
  const branches = new Set();
  const keys = new Set();
  const titles = new Set();
  for (const b of unmapped) {
    if (b.repo) repos.add(b.repo);
    if (b.branch) branches.add(b.branch);
    for (const k of b.branch.match(KEY_FIND_RE) ?? []) keys.add(k);
    // Session titles, masked as sync masks them; one that was masked or looks like a secret is left out.
    if (b.title && titles.size < TEMPLATE_TITLES_MAX) {
      const t = maskFieldInfo(b.title, TITLE_MAX);
      if (t.text && !t.cut && !flagField(t.text)) titles.add(t.text);
    }
  }
  return {
    note: "Distinct repos, branches, the keys in those branch names and the masked session titles, of unmapped blocks. Add rules (titleMatch is a case-insensitive substring, or /regex/), then pass this file as --map.",
    repos: [...repos].sort(),
    branches: [...branches].sort(),
    keys: [...keys].sort(),
    titles: [...titles].sort(),
    rules: [],
  };
}

const TEMPLATE_TITLES_MAX = 500;

// ---------------------------------------------------------------------------------------------
// Drafting

/** The prompt for one block: a masked, capped excerpt plus repo and branch. */
export function buildPrompt(block) {
  // The raw text is cut to 4x the excerpt first (bounds the masking time; a partial word at that
  // cut is dropped), then masked, then cut to the excerpt: a secret across the second cut is still
  // masked whole.
  const excerpt = maskExcerpt(cutRaw(String(block.text ?? ""), 4 * EXCERPT_CHARS).text).slice(0, EXCERPT_CHARS);
  return [
    "Summarise the work done in this agent session excerpt as one plain line for a work log.",
    `At most ${WORKED_MAX} characters. No secrets, tokens, names of people, hostnames, URLs or customer data.`,
    "Reply with the line only.",
    "",
    `Repo: ${block.repo || "unknown"}`,
    `Branch: ${block.branch || "unknown"}`,
    "",
    "Excerpt:",
    excerpt,
  ].join("\n");
}

/** First line only, trimmed, control characters removed, cut to 200 characters. */
export function postProcess(s) {
  const first = String(s ?? "").split(/\r?\n|\r|\u2028|\u2029|\u0085/).find((l) => l.trim()) ?? "";
  return first.replace(CONTROL_RE, "").trim().slice(0, WORKED_MAX).trim();
}

/** The line used with --no-llm. Holds no transcript text. */
export function templateLine(block) {
  return postProcess(`Worked in ${block.repo || "unknown repo"} on ${block.branch || "unknown branch"} (${block.turns} turns)`);
}

// Every pattern here and in MASKS runs in linear time on any input: a run of a class is only tried
// from its start (a negative lookbehind on the class) or with a bounded length, so a long run
// without a match (e.g. "a".repeat(80000), "a-".repeat(40000)) is scanned once, not once per position.
// The email local part: only from the start of a run of its class.
const EMAIL_SRC = String.raw`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,20}\.[A-Za-z]{2,24}`;
// Not a letter A-Z a-z, but a letter: a lookalike or accented letter next to @ or : can hide an
// email address or a key: value from the ASCII patterns.
const NON_ASCII_LETTER = String.raw`[^\P{L}\x00-\x7F]`;

const SECRET_CHECKS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY/, "private key"],
  [new RegExp(EMAIL_SRC), "email"],
  [/\b[0-9a-f]{32,}\b/i, "long hex run"],
  // No - or _ in the class: long dashed branch names are not secrets.
  [/[A-Za-z0-9+/]{40,}={0,2}/, "long base64 run"],
  // Any "key" with = or : after it (the old `\b[\w-]*key` matched the same lines, in quadratic time).
  [/key\s*[=:]/i, "key="],
  [/token/i, "token"],
  [/pass(word|wd)?\s*[=:]|password/i, "password"],
  // A well-known token prefix with its value split by a space, e.g. ghp_ABCDEFGHIJ KLMNOPQRSTUV.
  [/(?<![A-Za-z0-9_-])(?:gh[pousr]_|github_pat_|xox[abprs]-|sk-|AKIA|npm_)[A-Za-z0-9_-]{6,}\s+[A-Za-z0-9_-]{6,}/, "split token"],
  [/\b(?:pw|pwd|pass(?:code|phrase)?|secret)\s+(?:is|was)\s+\S/i, "password"],
  [new RegExp(`${NON_ASCII_LETTER}[@:]|[@:]${NON_ASCII_LETTER}`, "u"), "non-ASCII next to @ or :"],
];

// A quoted value: at most 500 characters, closing quote optional, so an unclosed quote is still
// masked and never scanned to the end of a long line.
const VALUE_SRC = String.raw`("[^"\n]{0,500}"?|'[^'\n]{0,500}'?|[^\s,;"']+)`;

/**
 * What maskExcerpt replaces, in order, each with [redacted:<kind>]. Broader than SECRET_CHECKS:
 * whole private key blocks, backfill links, bearer tokens, well-known token prefixes, and the value
 * (not the name) of key, token, secret and password assignments, and of "password is X" prose.
 * The bare words "token" and "password" stay, since prose needs them.
 */
const MASKS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-{5}[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-{5}|$)/g, "private key"],
  [/(?:https?:\/\/[^\s/]+)?\/api\/command-center\/backfill\/[0-9a-f]{64}/gi, "backfill link"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "bearer token"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{36})|(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "token"],
  [new RegExp(String.raw`(?<![\w-])([\w-]*(?:key|token|secret|passw(?:or)?d|pwd))(["']?\s*[=:]\s*)${VALUE_SRC}`, "gi"), "assignment", "$1$2"],
  [new RegExp(String.raw`\b(pw|pwd|pass(?:word|wd|code|phrase)?|secret)(\s+(?:is|was)\s+)${VALUE_SRC}`, "gi"), "assignment", "$1$2"],
  [new RegExp(EMAIL_SRC, "g"), "email"],
  [/\b[0-9a-f]{32,}\b/gi, "long hex run"],
  [/[A-Za-z0-9+/]{40,}={0,2}/g, "long base64 run"],
];

/** NFKC (fullwidth and other compatibility forms become ASCII) and no format characters (zero-width, bidi). */
function normalizeText(text) {
  return String(text ?? "").normalize("NFKC").replace(/\p{Cf}/gu, "");
}

/**
 * The first `max` characters of raw text, with a partial last word dropped (it may be the start of
 * a secret, too short to be recognised), and whether it was cut. Linear.
 */
function cutRaw(text, max) {
  if (text.length <= max) return { text, cut: false };
  let s = text.slice(0, max);
  if (!/\s/.test(text[max])) {
    let i = s.length - 1;
    while (i >= 0 && !/\s/.test(s[i])) i--;
    if (i >= 0) s = s.slice(0, i);
  }
  return { text: s, cut: true };
}

/** The block text, normalised, with secret-shaped strings, email addresses and backfill links masked. */
export function maskExcerpt(text) {
  let s = normalizeText(text);
  for (const [re, kind, keep = ""] of MASKS) s = s.replace(re, `${keep}[redacted:${kind}]`);
  return s;
}

/** A reason when a line looks like it holds a secret, else null. The line is normalised first. */
export function flagLine(line) {
  const s = normalizeText(line);
  for (const [re, reason] of SECRET_CHECKS) if (re.test(s)) return reason;
  return null;
}

/** Reduces a host name to [A-Za-z0-9._-], at most 20 characters (the server's machine limit). */
export function reduceMachine(name) {
  return String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, MACHINE_MAX);
}

function checkEndpoint(raw, what) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new CliError(`${what} is not a valid URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && loopback) return u;
  throw new CliError(`${what} must be https (http only on localhost)`);
}

/**
 * Reads the drafting settings from the environment. Fails naming the missing variable; never
 * puts a value in the message.
 */
export function llmSettings(env) {
  for (const name of ["BAB_BACKFILL_BASE_URL", "BAB_BACKFILL_MODEL", "BAB_BACKFILL_API_KEY_ENV"]) {
    if (!env[name]) throw new CliError(`${name} is not set. Set it, or pass --no-llm.`);
  }
  const keyVar = env.BAB_BACKFILL_API_KEY_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyVar)) throw new CliError("BAB_BACKFILL_API_KEY_ENV must be a variable name");
  if (!env[keyVar]) throw new CliError(`${keyVar} (named by BAB_BACKFILL_API_KEY_ENV) is not set.`);
  const base = checkEndpoint(env.BAB_BACKFILL_BASE_URL, "BAB_BACKFILL_BASE_URL");
  return { url: `${base.href.replace(/\/+$/, "")}/v1/messages`, model: env.BAB_BACKFILL_MODEL, keyVar };
}

// The answer is one line of at most 200 characters (about 60 tokens), but a model that thinks first
// spends output tokens on its thinking block: room for both, and more on the one retry.
export const MAX_TOKENS = 1024;
export const RETRY_MAX_TOKENS = 4096;

/** The request for one prompt. The key is read from the named variable at call time. */
export function buildLlmRequest(prompt, settings, env, maxTokens = MAX_TOKENS) {
  return {
    url: settings.url,
    init: {
      method: "POST",
      // A redirect could carry the key and the excerpt to another host: refuse it.
      redirect: "error",
      headers: { "x-api-key": env[settings.keyVar], "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: settings.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    },
  };
}

/**
 * A model answer with no usable text. `empty` is true for an answer with no content or only blank
 * text (a skip, not retried); false for an answer with no text block at all (e.g. only a thinking
 * block when max_tokens ran out), which is retried once. The message names the stop reason and
 * the block types only, never any text of the prompt or the answer.
 */
export class ModelAnswerError extends Error {
  constructor(empty, stopReason, blockTypes) {
    const why = `stop_reason: ${stopReason || "none"}; blocks: ${blockTypes.length ? blockTypes.join(", ") : "none"}`;
    super(empty ? `model returned an empty answer (${why})` : `model answer has no text block (${why})`);
    this.empty = empty;
  }
}

/** A value from the model's answer reduced to a short name: a-z, 0-9 and _ only, at most 30. */
function answerName(v) {
  return typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30) : "";
}

/**
 * The text of a Messages API answer: the first block of type "text" with non-blank text (thinking
 * and other blocks are skipped). Throws ModelAnswerError when there is none.
 */
export function answerText(body) {
  const hasContent = Array.isArray(body?.content);
  const content = hasContent ? body.content : [];
  const stopReason = answerName(body?.stop_reason);
  const types = [...new Set(content.map((b) => answerName(b?.type) || "unknown"))].slice(0, 10);
  const texts = content.filter((b) => b && b.type === "text" && typeof b.text === "string");
  const block = texts.find((b) => b.text.trim());
  if (block) return block.text;
  // No content list at all is not an answer: an error (retried). An empty list is an empty answer
  // only when the model ended its turn; one cut short (max_tokens, refusal, ...) is retried too.
  const finished = ["", "end_turn", "stop_sequence"].includes(stopReason);
  throw new ModelAnswerError(hasContent && (texts.length > 0 || (!content.length && finished)), stopReason, types);
}

/**
 * The default provider: a Messages API compatible endpoint. Errors name the status only.
 * `opts.retry` asks for the larger output budget.
 */
export function makeLlmProvider(env, fetchImpl) {
  const settings = llmSettings(env);
  return async (prompt, opts = {}) => {
    const { url, init } = buildLlmRequest(prompt, settings, env, opts.retry ? RETRY_MAX_TOKENS : MAX_TOKENS);
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch {
      throw new Error("model request failed (network)");
    }
    if (!res.ok) throw new Error(`model request failed: HTTP ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error("model answer is not JSON");
    }
    return answerText(body);
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The initiative for a block: a --map rule (by precedence), else the initiative its session got
 * in the sync draft (--map-from-sync), else none. Returns { initiative, title?, key?, mappedBy } or null.
 */
export function mapBlock(b, rules = [], syncMap = null) {
  const m = matchRule(b, rules);
  if (m) {
    const out = { initiative: m.rule.initiative, mappedBy: m.mappedBy };
    if (m.rule.title) out.title = m.rule.title;
    if (m.rule.key) out.key = m.rule.key;
    return out;
  }
  let s = syncMap?.bySession.get(b.session.slice(0, SESSION_MAX));
  let how = "";
  if (!s && syncMap && b.title) {
    s = syncMap.byTitle.get(titleKey(b.title));
    how = " (title)";
  }
  if (s) {
    const out = { initiative: s.id, mappedBy: `sync ${s.id}${how}` };
    if (s.title) out.title = s.title;
    if (s.key) out.key = s.key;
    return out;
  }
  return null;
}

/**
 * The drafted line for one block: { worked, error?, skipped? }. A model answer without a text
 * block is asked once more (with a larger output budget); an empty answer is a skip, not an error.
 */
async function draftLine(b, provider) {
  if (!provider) return { worked: templateLine(b) };
  const prompt = buildPrompt(b);
  for (let attempt = 0; ; attempt++) {
    try {
      const worked = postProcess(await provider(prompt, { retry: attempt > 0 }));
      if (!worked) return { worked: "", skipped: "model returned an empty line" };
      return { worked };
    } catch (e) {
      if (e instanceof ModelAnswerError) {
        if (e.empty) return { worked: "", skipped: e.message };
        if (attempt === 0) continue;
        return { worked: "", error: `${e.message}, also on retry` };
      }
      return { worked: "", error: e instanceof Error ? e.message : "model request failed" };
    }
  }
}

/** Sets an entry's line fields from a drafted line; include only for a clean, unflagged line. */
function applyLine(entry, line) {
  const flagged = line.worked ? flagLine(line.worked) : null;
  entry.worked = line.worked;
  entry.include = Boolean(line.worked) && !flagged && !line.error && !line.skipped;
  if (flagged) entry.flagged = flagged;
  if (line.error) entry.error = line.error;
  if (line.skipped) entry.skipped = line.skipped;
  return entry;
}

/** A full draft entry for a block, in the draft file's field order. */
function blockEntry(b, m, line, machine) {
  const entry = { id: b.id, initiative: m ? m.initiative : "unassigned" };
  if (m?.title) entry.title = m.title;
  if (m?.key) entry.key = m.key;
  Object.assign(entry, {
    worked: "",
    size: sizeOf(b.minutes),
    at: new Date(b.endMs).toISOString(),
    session: b.session.slice(0, SESSION_MAX),
    machine,
    include: false,
    mappedBy: m ? m.mappedBy : "none",
    repo: b.repo,
    branch: b.branch,
    turns: b.turns,
    minutes: b.minutes,
  });
  return applyLine(entry, line);
}

/** Builds the draft object. `provider` is null for --no-llm. `syncMap` comes from --map-from-sync. */
export async function buildDraft(blocks, { rules = [], syncMap = null, provider = null, machine, now, concurrency = 2 }) {
  const unmapped = [];
  const entries = await mapLimit(blocks, Math.max(1, Math.min(4, concurrency)), async (b) => {
    const m = mapBlock(b, rules, syncMap);
    if (!m) unmapped.push(b);
    return blockEntry(b, m, await draftLine(b, provider), machine);
  });
  return {
    draft: { v: 1, kind: DRAFT_KIND, generatedAt: new Date(now).toISOString(), entries },
    template: mapTemplate(unmapped),
  };
}

/** Checks that `raw` is a log draft this tool wrote (or the person edited). */
function checkDraft(raw, what) {
  if (!raw || typeof raw !== "object" || raw.v !== 1 || raw.kind !== DRAFT_KIND || !Array.isArray(raw.entries)) {
    throw new CliError(`${what} must be { v: 1, kind: "${DRAFT_KIND}", entries: [...] }`);
  }
  for (const [i, e] of raw.entries.entries()) {
    if (!e || typeof e !== "object" || typeof e.id !== "string") throw new CliError(`${what}: entries[${i}] needs an id`);
  }
  return raw;
}

/**
 * Redoes only the entries of an existing draft that have an `error`: each is drafted again from its
 * block (found by id) and mapped again with the current rules. Every other entry, included, edited,
 * flagged or skipped, stays exactly as it is, in its place. An errored entry whose block is gone
 * stays too. Returns { draft, template, retried, missing }.
 */
export async function retryDraft(existing, blocks, { rules = [], syncMap = null, provider = null, machine, now, concurrency = 2 }) {
  checkDraft(existing, "the draft");
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const todo = [];
  let missing = 0;
  existing.entries.forEach((e, i) => {
    // An entry the person fixed by hand (a line, or include: true) stays, even with its error left in.
    if (!e.error || e.worked || e.include === true) return;
    const b = byId.get(e.id);
    if (b) todo.push({ i, b });
    else missing++;
  });
  const entries = [...existing.entries];
  await mapLimit(todo, Math.max(1, Math.min(4, concurrency)), async ({ i, b }) => {
    entries[i] = blockEntry(b, mapBlock(b, rules, syncMap), await draftLine(b, provider), entries[i].machine ?? machine);
  });
  const unmapped = entries.filter((e) => e.initiative === "unassigned").map((e) => byId.get(e.id)).filter(Boolean);
  return {
    draft: { ...existing, generatedAt: new Date(now).toISOString(), entries },
    template: mapTemplate(unmapped),
    retried: todo.length,
    missing,
  };
}

/** A title compared as sync's dedupe compares it: masked, then its whole slug. "" for no title. */
function titleKey(title) {
  return title ? titleSlug(maskField(title, TITLE_MAX), Infinity) : "";
}

/**
 * The map from a sync draft (--map-from-sync): each session of a record with include: true goes
 * to that record's id, with its title and key (`bySession`). Sync keeps one session per title, so
 * a session it dropped as a same-titled one is found by its title (`byTitle`, compared as a slug).
 * Records left out are skipped, so their work stays unassigned rather than creating initiatives
 * the person did not choose.
 */
export function syncSessionMap(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== 1 || raw.kind !== DRAFT_KIND || !Array.isArray(raw.current)) {
    throw new CliError(`the sync draft must be { v: 1, kind: "${DRAFT_KIND}", current: [...] } (from the sync mode)`);
  }
  const map = new Map();
  const byTitle = new Map();
  for (const [i, r] of raw.current.entries()) {
    const at = `sync draft current[${i}]`;
    if (!r || typeof r !== "object") throw new CliError(`${at} must be an object`);
    if (r.include !== true) continue;
    if (typeof r.id !== "string" || !SLUG_RE.test(r.id) || RESERVED_IDS.includes(r.id)) throw new CliError(`${at}: id must be a slug (a-z, 0-9, -), not a reserved one`);
    if (!Array.isArray(r.sessions)) throw new CliError(`${at}: sessions must be a list`);
    const title = typeof r.title === "string" && r.title.trim() && r.title.length <= TITLE_MAX ? r.title : undefined;
    const key = typeof r.key === "string" && KEY_RE.test(r.key) ? r.key : undefined;
    for (const s of r.sessions) {
      if (typeof s !== "string" || !SESSION_RE.test(s)) throw new CliError(`${at}: sessions must be session ids`);
      const id = s.slice(0, SESSION_MAX);
      // The first record wins: the sync draft lists each session once, but an edited one may not.
      if (!map.has(id)) map.set(id, { id: r.id, title, key });
    }
    const t = titleKey(title);
    if (t && !byTitle.has(t)) byTitle.set(t, { id: r.id, title, key });
  }
  return { bySession: map, byTitle };
}

/** Text for a table cell or list item: Markdown syntax and HTML escaped, so it shows as written. */
function cell(s) {
  return String(s ?? "").replace(/[\\|<>[\]`*]/g, "\\$&").replace(CONTROL_RE, " ");
}

/** A readable table of the draft. */
export function draftMarkdown(draft) {
  const rows = draft.entries.map((e) => {
    const inc = e.include ? "yes" : `no${e.flagged ? ` (flagged: ${e.flagged})` : e.error ? ` (error: ${e.error})` : e.skipped ? ` (skipped: ${e.skipped})` : ""}`;
    return `| ${e.at.slice(0, 16).replace("T", " ")} | ${cell(e.initiative)} | ${cell(e.worked)} | ${e.size} | ${cell(inc)} |`;
  });
  return [
    "# Command Center backfill draft",
    "",
    `Generated ${draft.generatedAt}. ${draft.entries.length} blocks. Edit the .json file (worked, initiative, include), then run upload.`,
    "",
    "| date (UTC) | initiative | worked | size | include |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** <out> without a trailing .json, so x.json gives x.md and x.map-template.json. */
export function outputPaths(out) {
  const base = out.replace(/\.json$/i, "");
  return { json: out, md: `${base}.md`, template: `${base}.map-template.json` };
}

// ---------------------------------------------------------------------------------------------
// Sync: the latest state of recent sessions as `current` initiative records

/**
 * A user line the person typed, as the agent-board app counts it: not meta, not a compact
 * summary, not a task notification or peer message, not a tool result, not a command wrapper.
 */
function isRealUser(o) {
  if (o.type !== "user" || o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return false;
  if (o.turnOrigin === "task_notification" || o.turnOrigin === "peer" || o.promptSource === "system") return false;
  if (o.toolUseResult !== undefined) return false;
  const c = o.message?.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === "tool_result")) return false;
  const t = messageText(c).trimStart();
  return Boolean(t) && !t.startsWith("<");
}

/**
 * Turns one JSONL line into a sync event, or null. Events: { session, ms, role: "title", title:
 * { source, text } } for custom-title / ai-title lines (ms NaN), or { session, ms, role, realUser,
 * cwd, branch, tools: [{ name, input }] } for user and assistant lines. No message text is kept;
 * tool inputs are kept in memory only for the plan, todo and wrap_up tools.
 */
export function parseSyncLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (typeof o.sessionId !== "string" || !SESSION_RE.test(o.sessionId)) return null;
  if (o.type === "custom-title" || o.type === "ai-title") {
    const t = o.type === "custom-title" ? o.customTitle : o.aiTitle;
    if (typeof t !== "string" || !t.trim()) return null;
    return { session: o.sessionId, ms: NaN, role: "title", title: { source: o.type === "custom-title" ? "custom" : "ai", text: t } };
  }
  if (o.type !== "user" && o.type !== "assistant") return null;
  if (o.isSidechain === true) return null;
  const ms = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(ms)) return null;
  const tools = [];
  const content = o.message?.content;
  if (o.type === "assistant" && Array.isArray(content)) {
    for (const b of content) {
      if (!b || b.type !== "tool_use" || typeof b.name !== "string") continue;
      if (!b.name.endsWith("update_plan") && !b.name.endsWith("wrap_up") && b.name !== "TodoWrite") continue;
      tools.push({ name: b.name, input: b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {} });
    }
  }
  return {
    session: o.sessionId,
    ms,
    role: o.type,
    realUser: isRealUser(o),
    cwd: typeof o.cwd === "string" ? o.cwd : "",
    branch: typeof o.gitBranch === "string" ? o.gitBranch : "",
    tools,
  };
}

/** Reads <dir>/*\/*.jsonl (one level) into sync events by session. A title line takes the time of the line before it. */
export function readSyncTranscripts(dir) {
  const sessions = new Map();
  const files = walkTranscripts(dir, (lines) => {
    let lastMs = 0;
    for (const line of lines) {
      const e = parseSyncLine(line);
      if (!e) continue;
      if (e.role === "title") e.ms = lastMs;
      else lastMs = e.ms;
      if (!sessions.has(e.session)) sessions.set(e.session, []);
      sessions.get(e.session).push(e);
    }
  });
  return { sessions, files };
}

function planStatus(s) {
  if (s === "completed" || s === "done") return "done";
  if (s === "in_progress") return "in_progress";
  return "pending";
}

function planItems(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => (x && typeof x === "object" ? { text: typeof x.content === "string" ? x.content : typeof x.text === "string" ? x.text : "", status: planStatus(x.status) } : null))
    .filter((x) => x && x.text.trim())
    .slice(0, CC_MAX_TASKS);
}

/**
 * One update_plan call on a plan (statuses pending, in_progress, done), as the plan tool defines
 * it: `items` replaces the list; `done: [n]` (1-based) completes those; `advance` completes the
 * in_progress step and starts the first pending one; `start: n` puts n in progress and any other
 * in_progress step back to pending. Returns the new plan, or `items` unchanged.
 */
export function applyPlanOp(items, input) {
  if (!input || typeof input !== "object") return items;
  if (Array.isArray(input.items)) return planItems(input.items);
  if (!items) return items; // an increment with no list to apply it to
  const out = items.map((x) => ({ ...x }));
  if (Array.isArray(input.done)) {
    for (const n of input.done) {
      const t = out[Number(n) - 1];
      if (t) t.status = "done";
    }
  }
  if (input.advance === true) {
    const cur = out.findIndex((x) => x.status === "in_progress");
    if (cur >= 0) out[cur].status = "done";
    const next = out.findIndex((x) => x.status === "pending");
    if (next >= 0) out[next].status = "in_progress";
  }
  if (input.start != null && Number.isFinite(Number(input.start))) {
    const i = Number(input.start) - 1;
    if (out[i]) {
      out.forEach((x, k) => {
        if (k !== i && x.status === "in_progress") x.status = "pending";
      });
      out[i].status = "in_progress";
    }
  }
  return out;
}

// A recap that says the work is finished, as the agent-board dashboard reads it (the `done` word of
// its delivery rule, on the trimmed recap): "Done: ...", "Done.", "done -". Not "Donetsk".
const DONE_RECAP_RE = /^done(?![a-z])/i;

/**
 * The latest state of one session: its last plan (update_plan or TodoWrite, whichever came last),
 * its open blocked question (the last wrap_up, blocked, with an ask, and no real user turn after
 * it), its title (custom over ai), repo and branch. `rawTitle` stays in memory for key and rule
 * matching only.
 *
 * The desktop app's wrap_up checks off the whole update_plan list at the end of every turn, so a
 * wrap_up says nothing about progress. A plan from update_plan reads finished (every step done)
 * only when the last wrap_up came after the last plan call and its recap starts with "Done"
 * (DONE_RECAP_RE); otherwise its steps keep the statuses of the last explicit plan call. A
 * TodoWrite list keeps the statuses it was written with. The recap itself is never kept.
 */
export function sessionState(events) {
  const sorted = [...events].sort((a, b) => a.ms - b.ms);
  let plan = null;
  let planFrom = "";
  let planSeq = -1;
  let lastWrap = null;
  let seq = 0;
  let wrap = null;
  let custom = "";
  let ai = "";
  let cwd = "";
  let branch = "";
  let firstMs = Infinity;
  let lastMs = -Infinity;
  let userTurns = 0;
  for (const e of sorted) {
    if (e.role === "title") {
      if (e.title.source === "custom") custom = e.title.text;
      else ai = e.title.text;
      continue;
    }
    firstMs = Math.min(firstMs, e.ms);
    lastMs = Math.max(lastMs, e.ms);
    if (e.cwd) cwd = e.cwd;
    if (e.branch) branch = e.branch;
    if (e.realUser) {
      userTurns++;
      if (wrap) wrap.answered = true;
    }
    for (const t of e.tools ?? []) {
      seq++;
      if (t.name === "TodoWrite") {
        if (Array.isArray(t.input.todos)) {
          plan = planItems(t.input.todos);
          planFrom = "todo";
          planSeq = seq;
        }
      } else if (t.name.endsWith("update_plan")) {
        const next = applyPlanOp(plan, t.input);
        if (next !== plan) {
          if (Array.isArray(t.input.items)) planFrom = "plan";
          plan = next;
          planSeq = seq;
        }
      } else if (t.name.endsWith("wrap_up")) {
        lastWrap = { seq, done: typeof t.input.recap === "string" && DONE_RECAP_RE.test(t.input.recap.trim()) };
        const actions = Array.isArray(t.input.actions) ? t.input.actions : [];
        wrap = {
          ms: e.ms,
          blocked: t.input.blocked === true,
          ask: typeof t.input.ask === "string" ? t.input.ask : "",
          options: actions.map((a) => (a && typeof a === "object" ? a.label || a.action : "")).filter((s) => typeof s === "string" && s.trim()),
          answered: false,
        };
      }
    }
  }
  const finished = Boolean(plan?.length && planFrom === "plan" && lastWrap?.done && lastWrap.seq > planSeq);
  if (finished) plan = plan.map((x) => ({ ...x, status: "done" }));
  const question = wrap && wrap.blocked && !wrap.answered && wrap.ask.trim() ? { ms: wrap.ms, ask: wrap.ask, options: wrap.options } : null;
  const session = sorted[0]?.session ?? "";
  return { session, firstMs, lastMs, cwd, repo: repoOf(cwd), branch, rawTitle: custom || ai, plan, finished, question, userTurns };
}

/** The states of sessions last active in the `days` before `now`, skipping ones with no turn, plan or question. */
export function collectSessionStates(sessions, { now, days = 14 }) {
  const from = now - days * 24 * 60 * 60 * 1000;
  const out = [];
  for (const events of sessions.values()) {
    const s = sessionState(events);
    if (!Number.isFinite(s.lastMs) || s.lastMs < from) continue;
    if (!s.userTurns && !s.plan?.length && !s.question) continue;
    out.push(s);
  }
  return out.sort((a, b) => b.lastMs - a.lastMs || a.session.localeCompare(b.session));
}

// Host names end in one of these (a public suffix or a private network one). Dotted names with
// another last label stay: repo names like org.service.api, .NET namespaces, file.test.ts.
const HOST_TLDS = "com|net|org|io|dev|app|cloud|ai|co|info|biz|eu|be|nl|de|fr|uk|ch|lu|es|pl|se|dk|fi|ie|pt|cz|jp|cn|au|nz|br|sg|hk|ca|us|local|localdomain|internal|intranet|lan|corp|home|svc|arpa";
const PATH_CHARS = "[^\\s\"'`<>|]";
// Absolute paths and links: only the repo name and branch may say where work happened.
const SYNC_MASKS = [
  // Any scheme, credentials included (ssh://u:p@host, ftp://...). The scheme is bounded, not
  // anchored by \b: linear on "a.".repeat(n).
  [/[a-z][a-z0-9+.-]{0,30}:\/\/\S+/gi, "link"],
  // A Windows path (drive or UNC), also across up to 4 spaces when a later word has a backslash
  // again (C:\Program Files (x86)\App\x.exe).
  [new RegExp(String.raw`(?:\b[A-Za-z]:[\\/]|\\\\[^\s\\]+\\)${PATH_CHARS}*(?:(?: [^\s"'${"`"}<>|\\]{1,60}){0,4} [^\s"'${"`"}<>|\\]{0,60}\\${PATH_CHARS}*)*`, "g"), "path"],
  [new RegExp(String.raw`(?:~[\\/]|(?<![\w.~-])\/(?:[A-Za-z]|home|Users|Volumes|root|tmp|var|etc|opt|mnt|srv|private|workspace|workspaces)\/)${PATH_CHARS}*`, "g"), "path"],
  // A bare host name of 3 or more labels, e.g. api.dev.internal.example.com.
  [new RegExp(String.raw`(?<![a-z0-9.-])(?:[a-z0-9-]{1,63}\.){2,}(?:${HOST_TLDS})(?![a-z0-9-])`, "gi"), "host"],
];
// Long digit runs (phone, card, account numbers) the server refuses; stricter than its checks.
const LONG_NUMBER_RE = /\d(?:[\s().+-]*\d){8,}/;
// Also a marker cut short by the field limit, which has lost its closing bracket.
const MARKER_RE = /\[redacted:([^\]]*)/;

/**
 * One line of text for a record field, and whether the raw text was cut: the raw text is cut to 4x
 * max first (bounds the masking time), then normalised and masked like an excerpt, plus links,
 * paths and host names; control characters and runs of space are folded; then it is cut to max.
 */
export function maskFieldInfo(text, max) {
  const raw = cutRaw(String(text ?? ""), 4 * max);
  let s = maskExcerpt(raw.text);
  for (const [re, kind] of SYNC_MASKS) s = s.replace(re, `[redacted:${kind}]`);
  return { text: s.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim().slice(0, max).trim(), cut: raw.cut };
}

/** maskFieldInfo's text only. */
export function maskField(text, max) {
  return maskFieldInfo(text, max).text;
}

/** A reason when masked field text must be reviewed before upload, else null. */
export function flagField(masked) {
  const m = masked.match(MARKER_RE);
  if (m) return `masked ${m[1] || "text"}`;
  if (LONG_NUMBER_RE.test(masked)) return "long number";
  return flagLine(masked);
}

function shortHash(s, n = 6) {
  return createHash("sha256").update(s).digest("hex").slice(0, n);
}

/** A slug for an initiative or item id: a-z, 0-9 and -, at most 40, never a reserved route. A cut or reserved one gets a hash of the source. */
export function syncSlug(raw) {
  const s = String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s && s.length <= 40 && !RESERVED_IDS.includes(s) && SLUG_RE.test(s)) return s;
  const head = (s || "cc").slice(0, 33).replace(/-+$/, "") || "cc";
  return `${head}-${shortHash(String(raw ?? ""))}`;
}

const TRUNK_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk", "head"]);

/**
 * Groups session states into initiatives. A --map rule wins (its initiative; "unassigned" leaves
 * the session out). Other sessions are merged when they share a Jira-style key (from the branch
 * or the title) or the same repo and non-trunk branch; the rest stay one initiative each.
 * Returns { groups: [{ id, label, mappedBy, rule?, keys, states }], left }.
 */
export function groupSessions(states, rules = []) {
  const parent = states.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const ruled = new Map();
  const free = [];
  const keysOfState = states.map((s) => [...new Set([...(s.branch.match(KEY_FIND_RE) ?? []), ...(s.rawTitle.match(KEY_FIND_RE) ?? [])])].sort());
  const byKey = new Map();
  const byRb = new Map();
  let left = 0;
  states.forEach((s, i) => {
    // The rule sees the title, never the transcript text.
    const m = matchRule({ session: s.session, title: s.rawTitle, cwd: s.cwd, repo: s.repo, branch: s.branch, text: s.rawTitle }, rules);
    if (m && m.rule.initiative === "unassigned") {
      left++;
      return;
    }
    if (m) {
      if (!ruled.has(m.rule.initiative)) ruled.set(m.rule.initiative, { rule: m.rule, mappedBy: m.mappedBy, idx: [] });
      ruled.get(m.rule.initiative).idx.push(i);
      return;
    }
    free.push(i);
    for (const k of keysOfState[i]) {
      if (byKey.has(k)) union(i, byKey.get(k));
      else byKey.set(k, i);
    }
    if (s.repo && s.branch && !TRUNK_BRANCHES.has(s.branch.toLowerCase())) {
      const rb = `${s.repo}\n${s.branch}`;
      if (byRb.has(rb)) union(i, byRb.get(rb));
      else byRb.set(rb, i);
    }
  });
  const groups = [];
  for (const [initiative, g] of [...ruled.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const idx = g.idx;
    groups.push({ id: RESERVED_IDS.includes(initiative) ? syncSlug(initiative) : initiative, label: `rule:${initiative}`, mappedBy: g.mappedBy, rule: g.rule, keys: [...new Set(idx.flatMap((i) => keysOfState[i]))].sort(), states: idx.map((i) => states[i]) });
  }
  const roots = new Map();
  for (const i of free) {
    const r = find(i);
    if (!roots.has(r)) roots.set(r, []);
    roots.get(r).push(i);
  }
  const free_groups = [];
  for (const idx of roots.values()) {
    const keys = [...new Set(idx.flatMap((i) => keysOfState[i]))].sort();
    const first = states[idx[0]];
    let label;
    let mappedBy;
    if (keys.length) {
      label = `key:${keys[0]}`;
      mappedBy = `key ${keys[0]}`;
    } else if (idx.length > 1 || (first.repo && first.branch && !TRUNK_BRANCHES.has(first.branch.toLowerCase()))) {
      label = `rb:${first.repo}\n${first.branch}`;
      mappedBy = "repo+branch";
    } else {
      label = `session:${first.session}`;
      mappedBy = "session";
    }
    // No id yet: buildSyncDraft gives each one the slug of its record's (masked) title.
    free_groups.push({ label, mappedBy, keys, states: idx.map((i) => states[i]) });
  }
  free_groups.sort((a, b) => a.label.localeCompare(b.label));
  groups.push(...free_groups);
  return { groups, left };
}

/**
 * The slug of a title, as an agent makes a publish id from it: lower case, runs of anything but
 * a-z and 0-9 become one -, no - at either end, cut to `max` (40), "" when nothing is left.
 */
export function titleSlug(raw, max = 40) {
  const s = String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "");
}

/** `base`, or base-2, base-3, ... (cut to fit 40) when taken; marks the result as taken. */
function uniqueSlug(base, used) {
  let id = base;
  for (let n = 2; used.has(id) || !SLUG_RE.test(id); n++) {
    const suffix = `-${n}`;
    id = `${titleSlug(base, 40 - suffix.length) || "cc"}${suffix}`;
  }
  used.add(id);
  return id;
}

/**
 * Sessions sharing a title (compared by its whole slug, so case, spacing and punctuation fold, else by the
 * trimmed lower-case text): keeps one per title, a session with a plan over one without, then the
 * most recent. Untitled sessions all stay. Two titles with one slug would otherwise make ids that
 * swap between reruns.
 */
export function dedupeByTitle(states) {
  const order = [...states].sort((a, b) => Number(Boolean(b.plan?.length)) - Number(Boolean(a.plan?.length)) || b.lastMs - a.lastMs || a.session.localeCompare(b.session));
  const seen = new Set();
  const kept = [];
  for (const s of order) {
    const t = titleSlug(s.rawTitle, Infinity) || s.rawTitle.trim().toLowerCase().replace(/\s+/g, " ");
    if (t && seen.has(t)) continue;
    if (t) seen.add(t);
    kept.push(s);
  }
  return { states: kept, dropped: states.length - kept.length };
}

/** One draft record for a group, with review fields; flagged records are left out (include: false) until reviewed. */
export function buildSyncRecord(group) {
  const states = [...group.states].sort((a, b) => b.lastMs - a.lastMs || a.session.localeCompare(b.session));
  const latest = states[0];
  const flags = [];
  const field = (raw, max, where) => {
    const { text: v, cut } = maskFieldInfo(raw, max);
    const f = v ? flagField(v) : null;
    if (f) flags.push(`${where}: ${f}`);
    else if (cut) flags.push(`${where}: cut (over ${4 * max} characters)`);
    return v;
  };
  const key = group.rule?.key ?? group.keys.find((k) => KEY_RE.test(k));
  let title = group.rule?.title ?? "";
  if (!title) {
    const titled = states.find((s) => s.rawTitle.trim());
    if (titled) title = field(titled.rawTitle, TITLE_MAX, "title");
  }
  if (!title) title = field([key, latest.repo, latest.branch].filter(Boolean).join(" "), TITLE_MAX, "title");
  if (!title) title = `Session ${latest.session.slice(0, 8)}`;
  const planned = states.find((s) => s.plan?.length);
  const tasks = [];
  for (const [i, t] of (planned?.plan ?? []).entries()) {
    const text = field(t.text, TASK_TEXT_MAX, `tasks[${tasks.length}]`);
    if (text) tasks.push({ id: `step-${i + 1}`, text, status: t.status });
  }
  const questions = [];
  const asks = states.filter((s) => s.question).sort((a, b) => b.question.ms - a.question.ms);
  for (const s of asks.slice(0, CC_MAX_QUESTIONS)) {
    const at = `questions[${questions.length}]`;
    const text = field(s.question.ask, QUESTION_TEXT_MAX, at);
    if (!text) continue;
    const options = [];
    for (const o of s.question.options) {
      if (options.length >= CC_MAX_OPTIONS) break;
      const v = field(o, OPTION_MAX, `${at}.options`);
      if (v && !options.includes(v)) options.push(v);
    }
    const q = { id: `ask-${shortHash(`${s.session}:${s.question.ms}`, 8)}`, text };
    if (options.length) q.options = options;
    questions.push(q);
  }
  /** @type {Record<string, any>} */
  const record = { id: group.id ?? "", title };
  const area = latest.repo ? maskFieldInfo(latest.repo, AREA_MAX) : { text: "", cut: false };
  if (area.text && !area.cut && !flagField(area.text)) record.area = area.text;
  if (key) record.key = key;
  record.state = "active";
  if (tasks.length) record.tasks = tasks;
  if (questions.length) record.questions = questions;
  const hasPlan = Boolean(planned);
  Object.assign(record, {
    include: hasPlan && !flags.length,
    ...(hasPlan ? {} : { leftOut: "no plan" }),
    mappedBy: group.mappedBy,
    lastActiveAt: new Date(latest.lastMs).toISOString(),
    sessions: states.map((s) => s.session.slice(0, SESSION_MAX)),
    repo: latest.repo,
    branch: latest.branch,
  });
  if (flags.length) record.flagged = flags[0];
  return record;
}

export const SYNC_MAX_DEFAULT = 20;

/**
 * The sync draft: one `current` record per initiative, every one listed for review. Sessions
 * sharing a title are deduped first (dedupeByTitle). A --map rule's initiative is its id; any
 * other record's id is the slug of its title (titleSlug), so a later publish by that session with
 * the same id is the same initiative; a taken or reserved slug gets -2, -3 (most recent first).
 * Only records with a plan are included, at most `max` (the most recent); the rest have
 * include: false and a `leftOut` reason. Included records come first, each part newest first.
 */
export function buildSyncDraft(states, { rules = [], now, max = SYNC_MAX_DEFAULT }) {
  const deduped = dedupeByTitle(states);
  const { groups, left } = groupSessions(deduped.states, rules);
  const records = groups.map(buildSyncRecord);
  const newest = (a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || a.sessions[0].localeCompare(b.sessions[0]);
  const used = new Set(RESERVED_IDS);
  for (const r of records) if (r.id) used.add(r.id);
  for (const r of [...records].sort(newest)) if (!r.id) r.id = uniqueSlug(titleSlug(r.title) || titleSlug(`session ${r.sessions[0]}`) || "cc", used);
  let included = 0;
  let overMax = 0;
  for (const r of [...records].sort(newest)) {
    if (!r.include) continue;
    if (included < max) included++;
    else {
      r.include = false;
      r.leftOut = `over --max ${max}`;
      overMax++;
    }
  }
  records.sort((a, b) => Number(b.include) - Number(a.include) || newest(a, b) || a.id.localeCompare(b.id));
  return {
    draft: { v: 1, kind: DRAFT_KIND, generatedAt: new Date(now).toISOString(), entries: [], current: records },
    left,
    deduped: deduped.dropped,
    noPlan: records.filter((r) => r.leftOut === "no plan").length,
    overMax,
  };
}

/** A readable view of a sync draft. */
export function syncMarkdown(draft) {
  const mark = { done: "[x]", in_progress: "[~]", pending: "[ ]" };
  const lines = [
    "# Command Center sync draft",
    "",
    `Generated ${draft.generatedAt}. ${draft.current.length} initiatives, ${draft.current.filter((r) => r.include === true).length} included. Every record is listed: set include to true or false in the .json file (and edit title, tasks, questions), then run upload. Only include: true records are sent.`,
    "",
  ];
  for (const r of draft.current) {
    const inc = [r.include === true ? "true" : "false", r.leftOut ? `left out (${r.leftOut})` : "", r.flagged ? `flagged: ${r.flagged}` : ""].filter(Boolean).join(", ");
    lines.push(`## ${cell(r.title)}`, "", `id ${cell(r.id)}${r.key ? `, key ${cell(r.key)}` : ""}${r.area ? `, area ${cell(r.area)}` : ""}. Include: ${cell(inc)}. Last active ${r.lastActiveAt.slice(0, 16).replace("T", " ")} UTC.`, "");
    for (const t of r.tasks ?? []) lines.push(`- ${mark[t.status] ?? "[ ]"} ${cell(t.text)}`);
    for (const q of r.questions ?? []) lines.push(`- Question: ${cell(q.text)}${q.options?.length ? ` (options: ${q.options.map(cell).join(" / ")})` : ""}`);
    if (r.tasks?.length || r.questions?.length) lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Upload

/** The sendable entries of a draft, each built from the allowlist only. */
export function uploadEntries(draft) {
  if (!draft || draft.v !== 1 || draft.kind !== DRAFT_KIND || !Array.isArray(draft.entries)) {
    throw new CliError(`the draft must be { v: 1, kind: "${DRAFT_KIND}", entries: [...] }`);
  }
  const out = [];
  for (const e of draft.entries) {
    if (!e || e.include !== true || typeof e.worked !== "string" || !e.worked.trim()) continue;
    if (typeof e.id !== "string" || !ID_RE.test(e.id)) continue;
    const u = {};
    for (const f of UPLOAD_FIELDS) {
      if (e[f] !== undefined && e[f] !== null && e[f] !== "") u[f] = e[f];
    }
    out.push(u);
  }
  return out;
}

function plainText(v, max) {
  return typeof v === "string" && v.trim() !== "" && v.length <= max;
}

/** Why a reviewed `current` record cannot be sent, or null. Mirrors the server's publish limits. */
function currentProblem(r) {
  if (typeof r.id !== "string" || !SLUG_RE.test(r.id) || RESERVED_IDS.includes(r.id)) return `id must be a slug (a-z, 0-9, -), not ${RESERVED_IDS.join(", ")}`;
  if (!plainText(r.title, TITLE_MAX)) return `title must be text of 1 to ${TITLE_MAX} characters`;
  if (r.area != null && r.area !== "" && !plainText(r.area, AREA_MAX)) return `area must be text of at most ${AREA_MAX} characters`;
  if (r.key != null && r.key !== "" && (typeof r.key !== "string" || !KEY_RE.test(r.key))) return "key must look like KEY-1";
  if (r.state != null && r.state !== "active") return 'state must be "active"';
  const tasks = r.tasks ?? [];
  if (!Array.isArray(tasks) || tasks.length > CC_MAX_TASKS) return `tasks must be a list of at most ${CC_MAX_TASKS}`;
  for (const t of tasks) {
    if (!t || typeof t.id !== "string" || !SLUG_RE.test(t.id)) return "a task id must be a slug";
    if (!plainText(t.text, TASK_TEXT_MAX)) return `a task text must be 1 to ${TASK_TEXT_MAX} characters`;
    if (!TASK_STATUSES.includes(t.status)) return `a task status must be ${TASK_STATUSES.join(", ")}`;
  }
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) return "task ids must be unique";
  const questions = r.questions ?? [];
  if (!Array.isArray(questions) || questions.length > CC_MAX_QUESTIONS) return `questions must be a list of at most ${CC_MAX_QUESTIONS}`;
  for (const q of questions) {
    if (!q || typeof q.id !== "string" || !SLUG_RE.test(q.id)) return "a question id must be a slug";
    if (!plainText(q.text, QUESTION_TEXT_MAX)) return `a question text must be 1 to ${QUESTION_TEXT_MAX} characters`;
    const o = q.options ?? [];
    if (!Array.isArray(o) || o.length > CC_MAX_OPTIONS || o.some((x) => !plainText(x, OPTION_MAX))) return `question options must be at most ${CC_MAX_OPTIONS} texts of 1 to ${OPTION_MAX}`;
  }
  if (new Set(questions.map((q) => q.id)).size !== questions.length) return "question ids must be unique";
  return null;
}

/**
 * The sendable `current` records of a sync draft (include: true), each built from the record
 * allowlist only: id, title, area, key, state, tasks { id, text, status }, questions { id, text,
 * options }. Links are never sent. Returns { records, skipped: [{ id, reason }] }.
 */
export function uploadCurrent(draft) {
  if (draft?.current === undefined) return { records: [], skipped: [] };
  if (!Array.isArray(draft.current)) throw new CliError("current in the draft must be a list");
  const records = [];
  const skipped = [];
  const seen = new Set();
  for (const r of draft.current) {
    if (!r || typeof r !== "object" || r.include !== true) continue;
    const problem = currentProblem(r) ?? (seen.has(r.id) ? "id is used twice" : null);
    if (problem) {
      skipped.push({ id: typeof r.id === "string" ? r.id.slice(0, 40) : "?", reason: problem });
      continue;
    }
    seen.add(r.id);
    const u = { id: r.id, title: r.title };
    if (r.area) u.area = r.area;
    if (r.key) u.key = r.key;
    u.state = "active";
    if (r.tasks?.length) u.tasks = r.tasks.map((t) => ({ id: t.id, text: t.text, status: t.status }));
    if (r.questions?.length) u.questions = r.questions.map((q) => (q.options?.length ? { id: q.id, text: q.text, options: [...q.options] } : { id: q.id, text: q.text }));
    records.push(u);
  }
  if (records.length > MAX_CURRENT) throw new CliError(`the draft includes ${records.length} current records; at most ${MAX_CURRENT}. Set include: false on some.`);
  return { records, skipped };
}

/**
 * Splits entries into request bodies of at most 2000 entries and 1 MB each. `current` records,
 * when given, ride in the first body, and count toward its bytes; with no entries that is one
 * body of current records only.
 * @param {any[]} entries
 * @param {{ maxEntries?: number, maxBytes?: number, current?: object[] }} [opts]
 */
export function batchEntries(entries, { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES, current = [] } = {}) {
  const overhead = Buffer.byteLength(JSON.stringify({ v: 1, entries: [] }));
  const firstOverhead = current.length ? Buffer.byteLength(JSON.stringify({ v: 1, entries: [], current })) : overhead;
  if (firstOverhead > maxBytes) throw new CliError(`the current records alone are over ${maxBytes} bytes`);
  const batches = [];
  let cur = [];
  let bytes = firstOverhead;
  for (const e of entries) {
    const own = Buffer.byteLength(JSON.stringify(e));
    if (overhead + own > maxBytes) throw new CliError(`entry ${e.id} alone is over ${maxBytes} bytes`);
    // A comma separates entries after the first.
    if (cur.length && (cur.length >= maxEntries || bytes + own + 1 > maxBytes)) {
      batches.push(cur);
      cur = [];
      bytes = overhead;
    } else if (!cur.length && !batches.length && bytes + own > maxBytes) {
      // The current records leave no room for this entry in the first body.
      batches.push(cur);
      cur = [];
      bytes = overhead;
    }
    bytes += own + (cur.length ? 1 : 0);
    cur.push(e);
  }
  if (cur.length || (current.length && !batches.length)) batches.push(cur);
  return batches;
}

/**
 * The request body for batch i: current records go with the first only.
 * @param {any[]} batch
 * @param {number} i
 * @param {object[]} [current]
 */
export function uploadBody(batch, i, current = []) {
  return i === 0 && current.length ? { v: 1, entries: batch, current } : { v: 1, entries: batch };
}

/** Checks a backfill link: https, or http on loopback. */
export function checkUploadUrl(raw) {
  return checkEndpoint(raw, "--url");
}

/** The link with its token cut after 6 characters. */
export function maskUrl(raw) {
  try {
    const u = new URL(raw);
    const parts = u.pathname.split("/");
    const last = parts.pop() ?? "";
    parts.push(last.length > 6 ? `${last.slice(0, 6)}...` : last);
    return `${u.origin}${parts.join("/")}`;
  } catch {
    return "(invalid url)";
  }
}

// ---------------------------------------------------------------------------------------------
// CLI

function parseArgs(args) {
  const flags = { url: [] };
  const valued = new Set(["--out", "--projects-dir", "--map", "--map-from-sync", "--since", "--until", "--settle-hours", "--machine", "--concurrency", "--draft", "--url", "--from", "--days", "--max"]);
  const bare = new Set(["--no-llm", "--dry-run", "--retry-errors"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (bare.has(a)) flags[a.slice(2)] = true;
    else if (valued.has(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new CliError(`${a} needs a value`);
      if (a === "--url") flags.url.push(v);
      else flags[a.slice(2)] = v;
    } else throw new CliError(`unknown argument: ${a}`);
  }
  return flags;
}

function intFlag(value, flag, min, max, dflt) {
  if (value === undefined) return dflt;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new CliError(`${flag} must be a number from ${min} to ${max}`);
  return n;
}

/**
 * Writes a file readable and writable by its owner only (0600). Refuses a symbolic link at the
 * target (it could point anywhere). The content goes to a new temp file in the same folder, created
 * exclusively (O_EXCL) with mode 0600, which is then renamed over the target: no content is ever
 * written under a looser mode, and an older draft's mode does not carry over.
 */
export function writePrivate(file, content) {
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
  }
  if (st?.isSymbolicLink()) throw new CliError(`refusing to write through a symbolic link: ${file}`);
  if (st && !st.isFile()) throw new CliError(`not a regular file: ${file}`);
  const tmp = path.join(path.dirname(path.resolve(file)), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    try {
      const buf = Buffer.from(content, "utf8");
      for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw e;
  }
  // A no-op on Windows; elsewhere the file is 0600 already (a umask only removes bits).
  fs.chmodSync(file, 0o600);
}

async function runDraft(flags, deps) {
  const { stdout } = deps;
  if (!flags.out) throw new CliError("draft needs --out <file.json>");
  if (flags.url.length || flags.draft || flags["dry-run"] || flags.from) throw new CliError("--url, --draft, --from and --dry-run are for upload");
  if (flags.days !== undefined || flags.max !== undefined) throw new CliError("--days and --max are for sync");
  const settleHours = intFlag(flags["settle-hours"], "--settle-hours", 0, 24 * 365, 2);
  const concurrency = Math.floor(intFlag(flags.concurrency, "--concurrency", 1, 4, 2));
  const since = flags.since !== undefined ? parseBound(flags.since, "--since") : undefined;
  const until = flags.until !== undefined ? parseBound(flags.until, "--until", true) : undefined;
  if (flags.machine !== undefined && !MACHINE_RE.test(flags.machine)) {
    throw new CliError(`--machine must be 1 to ${MACHINE_MAX} characters of A-Z a-z 0-9 . _ -`);
  }
  const machine = flags.machine ?? reduceMachine(deps.hostname());
  if (!machine) throw new CliError("this host name has none of A-Z a-z 0-9 . _ -; pass --machine");
  const retry = Boolean(flags["retry-errors"]);
  if (retry && (since !== undefined || until !== undefined || flags["settle-hours"] !== undefined)) {
    throw new CliError("--retry-errors redoes the errored blocks of the draft at --out; --since, --until and --settle-hours do not apply");
  }
  const rules = readMapRules(flags.map);
  const syncMap = flags["map-from-sync"] ? syncSessionMap(readJson(flags["map-from-sync"], "the sync draft")) : null;
  const existing = retry ? readJson(flags.out, "the draft to retry") : null;
  if (existing) checkDraft(existing, "the draft to retry");
  // Settings first: a missing variable fails before any transcript is read.
  const provider = flags["no-llm"] ? null : (deps.provider ?? makeLlmProvider(deps.env, deps.fetch));
  const dir = flags["projects-dir"] ?? defaultProjectsDir();
  const { sessions, files, titles } = readTranscripts(dir);
  const opts = { rules, syncMap, provider, machine, now: deps.now(), concurrency };
  let draft;
  let template;
  if (existing) {
    // Every block, whatever its age: the draft's own entries decide which ones are redone.
    const blocks = collectBlocks(sessions, { now: deps.now(), settleHours: 0, titles });
    const r = await retryDraft(existing, blocks, opts);
    ({ draft, template } = r);
    stdout(`${r.retried} errored blocks drafted again${r.missing ? `, ${r.missing} errored entries whose block is no longer in the transcripts kept as they were` : ""}; every other entry kept as it was.`);
  } else {
    const blocks = collectBlocks(sessions, { now: deps.now(), settleHours, since, until, titles });
    ({ draft, template } = await buildDraft(blocks, opts));
  }
  const p = outputPaths(flags.out);
  fs.mkdirSync(path.dirname(path.resolve(p.json)), { recursive: true });
  writePrivate(p.json, `${JSON.stringify(draft, null, 2)}\n`);
  writePrivate(p.md, draftMarkdown(draft));
  writePrivate(p.template, `${JSON.stringify(template, null, 2)}\n`);
  const included = draft.entries.filter((e) => e.include).length;
  const flagged = draft.entries.filter((e) => e.flagged).length;
  const errors = draft.entries.filter((e) => e.error).length;
  const skipped = draft.entries.filter((e) => e.skipped).length;
  const unassigned = draft.entries.filter((e) => e.initiative === "unassigned").length;
  stdout(`${files} transcript files, ${sessions.size} sessions, ${draft.entries.length} blocks in the draft.`);
  stdout(`${included} included, ${flagged} flagged, ${errors} drafting errors, ${skipped} skipped (empty answer), ${unassigned} unassigned.`);
  if (errors) stdout(`To draft only the errored blocks again: rerun with --retry-errors and the same --out.`);
  stdout(`Draft: ${p.json}`);
  stdout(`Table: ${p.md}`);
  stdout(`Map template: ${p.template}`);
  stdout("Nothing was uploaded. Review the draft, then run upload with a backfill link.");
  return 0;
}

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new CliError(`cannot read ${what} as JSON: ${file}`);
  }
}

function readMapRules(file) {
  if (!file) return [];
  return validateMap(readJson(file, "the map file"));
}

async function runSync(flags, deps) {
  const { stdout } = deps;
  if (!flags.out) throw new CliError("sync needs --out <file.json>");
  if (flags.url.length || flags.draft || flags["dry-run"] || flags.from) throw new CliError("--url, --draft, --from and --dry-run are for upload");
  for (const f of ["since", "until", "settle-hours", "machine", "concurrency", "no-llm", "retry-errors", "map-from-sync"]) {
    if (flags[f] !== undefined) throw new CliError(`--${f} is for draft`);
  }
  const days = Math.floor(intFlag(flags.days, "--days", 1, 365, 14));
  const max = Math.floor(intFlag(flags.max, "--max", 1, MAX_CURRENT, SYNC_MAX_DEFAULT));
  const rules = readMapRules(flags.map);
  const dir = flags["projects-dir"] ?? defaultProjectsDir();
  const { sessions, files } = readSyncTranscripts(dir);
  const states = collectSessionStates(sessions, { now: deps.now(), days });
  const { draft, left, deduped, noPlan, overMax } = buildSyncDraft(states, { rules, now: deps.now(), max });
  const p = outputPaths(flags.out);
  fs.mkdirSync(path.dirname(path.resolve(p.json)), { recursive: true });
  writePrivate(p.json, `${JSON.stringify(draft, null, 2)}\n`);
  writePrivate(p.md, syncMarkdown(draft));
  const included = draft.current.filter((r) => r.include).length;
  const flagged = draft.current.filter((r) => r.flagged).length;
  const questions = draft.current.reduce((n, r) => n + (r.questions?.length ?? 0), 0);
  stdout(`${files} transcript files, ${states.length} sessions active in the last ${days} days, ${draft.current.length} initiatives.`);
  stdout(`${included} included, ${flagged} flagged, ${questions} open questions.`);
  stdout(`Left out: ${noPlan} with no plan, ${overMax} over --max ${max}${deduped ? `, ${deduped} sessions with the title of another` : ""}${left ? `, ${left} sessions left out by the map` : ""}.`);
  stdout(`Draft: ${p.json}`);
  stdout(`Readable: ${p.md}`);
  stdout("Nothing was uploaded. Review the draft, then run upload with a backfill link.");
  return 0;
}

function printAnswer(stdout, body) {
  const n = (v) => (typeof v === "number" ? v : 0);
  const refused = Array.isArray(body?.refused) ? body.refused : [];
  const created = Array.isArray(body?.created) ? body.created : [];
  const reassigned = Array.isArray(body?.reassigned) ? body.reassigned : [];
  stdout(`accepted ${n(body?.accepted)}, duplicate ${n(body?.duplicate)}, refused ${refused.length}, created ${created.length}, reassigned to unassigned ${reassigned.length}`);
  for (const r of refused) stdout(`  refused #${plain(r?.index)} ${plain(r?.id)}: ${plain(r?.reason)}`);
  if (created.length) stdout(`  created initiatives: ${created.map(plain).join(", ")}`);
  // The server's answer for current records: syncCreated and syncSkipped counts, syncRefused [{ index, id, reason }].
  if (body?.syncCreated !== undefined || body?.syncSkipped !== undefined || body?.syncRefused !== undefined) {
    const syncRefused = Array.isArray(body.syncRefused) ? body.syncRefused : [];
    stdout(`current: created ${n(body.syncCreated)}, skipped ${n(body.syncSkipped)}, refused ${syncRefused.length}`);
    for (const r of syncRefused) stdout(`  current refused #${plain(r?.index)} ${plain(r?.id)}: ${plain(r?.reason)}`);
  }
}

/** A value from the server's answer as one short line: no control characters, at most 200 characters. */
function plain(v) {
  return String(v ?? "").replace(CONTROL_RE, " ").slice(0, 200);
}

async function runUpload(flags, deps) {
  const { stdout, stderr } = deps;
  if (!flags.draft) throw new CliError("upload needs --draft <file.json>");
  if (flags.out || flags.map || flags["no-llm"] || flags.days !== undefined || flags.max !== undefined) throw new CliError("--out, --map, --no-llm, --days and --max are for draft and sync");
  if (flags["retry-errors"] || flags["map-from-sync"]) throw new CliError("--retry-errors and --map-from-sync are for draft");
  // The link from the environment keeps it off the command line (shell history, process lists).
  if (!flags.url.length && deps.env.BAB_BACKFILL_LINK) flags.url.push(deps.env.BAB_BACKFILL_LINK);
  if (!flags["dry-run"] && !flags.url.length) throw new CliError("upload needs --url <link> or BAB_BACKFILL_LINK (or --dry-run)");
  for (const u of flags.url) checkUploadUrl(u);
  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(flags.draft, "utf8"));
  } catch {
    throw new CliError(`cannot read the draft as JSON: ${flags.draft}`);
  }
  const all = uploadEntries(draft);
  const { records, skipped } = uploadCurrent(draft);
  for (const s of skipped) stderr(`  current ${s.id} not sent: ${s.reason}`);
  const from = Math.floor(intFlag(flags.from, "--from", 0, Number.MAX_SAFE_INTEGER, 0));
  const entries = all.slice(from);
  // Current records go with the first upload only; a --from rerun continues the log entries.
  const current = from === 0 ? records : [];
  if (records.length && from > 0) stdout(`${records.length} current records are sent with --from 0 only; not sent now.`);
  if (!entries.length && !current.length) {
    stdout(`Nothing to send: ${all.length} sendable entries, starting at ${from}${records.length ? `, ${records.length} current records` : ""}.`);
    return 0;
  }
  const batches = batchEntries(entries, { current });
  const withCurrent = current.length ? ` and ${current.length} current records` : "";
  if (flags["dry-run"]) {
    const bytes = batches.map((b, i) => Buffer.byteLength(JSON.stringify(uploadBody(b, i, current))));
    stdout(`Dry run: ${entries.length} entries${withCurrent} in ${batches.length} batch(es) of ${bytes.join(", ")} bytes. Nothing sent.`);
    for (const e of entries.slice(0, 3)) stdout(`  ${e.at} ${e.initiative}: ${e.worked}`);
    for (const r of current.slice(0, 3)) stdout(`  current ${r.id}: ${r.title} (${r.tasks?.length ?? 0} tasks, ${r.questions?.length ?? 0} questions)`);
    return 0;
  }
  let sent = 0;
  let failed = false;
  for (let i = 0; i < batches.length && i < flags.url.length; i++) {
    const url = flags.url[i];
    const masked = maskUrl(url);
    const body = JSON.stringify(uploadBody(batches[i], i, current));
    stdout(`Uploading ${batches[i].length} entries${i === 0 ? withCurrent : ""} to ${masked}`);
    let res;
    try {
      // A redirect could carry the entries to another host: refuse it.
      res = await deps.fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body });
    } catch {
      stderr(`upload to ${masked} failed (network). The link may be spent; mint a new one and rerun with --from ${from + sent}.`);
      failed = true;
      break;
    }
    let answer = null;
    try {
      answer = await res.json();
    } catch {
      answer = null;
    }
    if (!res.ok) {
      const msg = typeof answer?.error === "string" ? answer.error.replace(url, masked) : "no details";
      stderr(`upload refused: HTTP ${res.status}: ${msg}`);
      failed = true;
      break;
    }
    printAnswer(stdout, answer);
    sent += batches[i].length;
  }
  const left = entries.length - sent;
  if (left > 0 && !failed) {
    stdout(`${left} entries left. A link is single use: mint a new backfill link and rerun with --from ${from + sent}.`);
  }
  return failed ? 1 : 0;
}

/** Runs the CLI. Returns the exit code. `deps` lets tests inject env, fetch, provider, clock and output. */
export async function run(argv, deps = {}) {
  const d = {
    env: process.env,
    fetch: globalThis.fetch,
    provider: undefined,
    now: () => Date.now(),
    hostname: () => os.hostname(),
    stdout: (s) => process.stdout.write(`${s}\n`),
    stderr: (s) => process.stderr.write(`${s}\n`),
    ...deps,
  };
  const [mode, ...rest] = argv;
  try {
    if (mode === "draft") return await runDraft(parseArgs(rest), d);
    if (mode === "sync") return await runSync(parseArgs(rest), d);
    if (mode === "upload") return await runUpload(parseArgs(rest), d);
    d.stderr(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof CliError) {
      d.stderr(e.message);
      if (/needs|unknown argument/.test(e.message)) d.stderr(USAGE);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`cc-backfill failed: ${e instanceof Error ? e.message : "unknown error"}\n`);
      process.exitCode = 1;
    },
  );
}
