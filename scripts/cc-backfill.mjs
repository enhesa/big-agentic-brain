#!/usr/bin/env node
// Backfills a Command Center work log from past agent sessions, in two steps.
//
//   draft   reads session transcripts (JSONL) on this machine, splits them into work blocks and
//           drafts one `worked` line per block. It writes a draft file for the person to review.
//           It uploads nothing.
//   upload  sends the reviewed draft lines (include: true) to a single-use backfill link that the
//           person's agent minted with bab_command_center action=backfill_link.
//
// Transcript text never leaves this machine except as the prompt to the drafting model (when one
// is configured), and never lands in the draft files, the console or the upload. Only the drafted
// line does. Lines that look like secrets are flagged and left out until the person reviews them.
//
// Node built-ins only. The pure functions are exported for tests; main() runs only when this
// file is invoked directly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const USAGE = `Usage:
  node scripts/cc-backfill.mjs draft --out <draft.json> [options]
  node scripts/cc-backfill.mjs upload --draft <draft.json> --url <link> [--url <link> ...] [--from <n>] [--dry-run]

draft options:
  --out <file.json>       draft to write; also writes <file>.md and <file>.map-template.json
  --projects-dir <dir>    transcripts folder, reads <dir>/*/*.jsonl (default: ~/.claude/projects)
  --map <file.json>       mapping rules { "rules": [ { "initiative", "title", "key", "cwd", "repo", "branch", "keys" } ] }
  --since <date>          only blocks starting at or after this date or ISO time (a date is UTC midnight)
  --until <date>          only blocks starting before the end of this date, or before this ISO time
  --settle-hours <n>      skip blocks that ended less than n hours ago (default 2)
  --machine <name>        machine name sent with each entry: 1 to 20 of A-Z a-z 0-9 . _ -
                          (default: this host name, reduced and cut to 20)
  --concurrency <n>       drafting requests at once, 1 to 4 (default 2)
  --no-llm                write a template line per block instead of asking a model

  Without --no-llm, draft needs BAB_BACKFILL_BASE_URL, BAB_BACKFILL_MODEL and BAB_BACKFILL_API_KEY_ENV
  (the name of the variable that holds the API key). It posts to <base>/v1/messages.

upload options:
  --draft <file.json>     the reviewed draft; only entries with include: true and a worked line are sent
  --url <link>            a backfill link (https, or http on loopback). One upload per link; repeat
                          --url to send more batches
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
const RULE_MATCH_FIELDS = ["cwd", "repo", "branch", "keys"];
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

/** Reads <dir>/*\/*.jsonl (one level) and returns events grouped by session. */
export function readTranscripts(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new CliError(`projects dir not found: ${dir}`);
  const sessions = new Map();
  let files = 0;
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subDir = path.join(dir, sub.name);
    for (const f of fs.readdirSync(subDir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      files++;
      const raw = fs.readFileSync(path.join(subDir, f.name), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const e = parseLine(line);
        if (!e) continue;
        if (!sessions.has(e.session)) sessions.set(e.session, []);
        sessions.get(e.session).push(e);
      }
    }
  }
  return { sessions, files };
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
export function collectBlocks(sessions, { now, settleHours = 2, since, until }) {
  const settleMs = settleHours * 60 * 60 * 1000;
  const out = [];
  for (const events of sessions.values()) {
    for (const b of splitBlocks(events)) {
      if (now - b.endMs < settleMs) continue;
      if (since !== undefined && b.startMs < since) continue;
      if (until !== undefined && b.startMs >= until) continue;
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
    if (!RULE_MATCH_FIELDS.some((f) => r[f] !== undefined)) throw new CliError(`${at}: give at least one of cwd, repo, branch, keys`);
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
    return { ...r, index: i, branchRe, cwdRe: r.cwd !== undefined && /[*?]/.test(r.cwd) ? globToRe(r.cwd) : undefined };
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

/** The first rule whose given match fields all match, or null. */
export function matchRule(block, rules) {
  const cwd = block.cwd.replace(/\\/g, "/");
  let keys;
  for (const r of rules) {
    const hit = [];
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

/** Distinct repos, branches and keys among unmapped blocks, so the person can write rules. No text. */
export function mapTemplate(unmapped) {
  const repos = new Set();
  const branches = new Set();
  const keys = new Set();
  for (const b of unmapped) {
    if (b.repo) repos.add(b.repo);
    if (b.branch) branches.add(b.branch);
    for (const k of keysOf(b)) keys.add(k);
  }
  return {
    note: "Distinct repos, branches and keys of unmapped blocks. Add rules, then pass this file as --map.",
    repos: [...repos].sort(),
    branches: [...branches].sort(),
    keys: [...keys].sort(),
    rules: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Drafting

/** The prompt for one block: a capped excerpt plus repo and branch. */
export function buildPrompt(block) {
  const excerpt = block.text.slice(0, EXCERPT_CHARS);
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

const SECRET_CHECKS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY/, "private key"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, "email"],
  [/\b[0-9a-f]{32,}\b/i, "long hex run"],
  // No - or _ in the class: long dashed branch names are not secrets.
  [/[A-Za-z0-9+/]{40,}={0,2}/, "long base64 run"],
  [/\b[\w-]*key\s*[=:]/i, "key="],
  [/token/i, "token"],
  [/pass(word|wd)?\s*[=:]|password/i, "password"],
];

/** A reason when a line looks like it holds a secret, else null. */
export function flagLine(line) {
  for (const [re, reason] of SECRET_CHECKS) if (re.test(line)) return reason;
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

/** The request for one prompt. The key is read from the named variable at call time. */
export function buildLlmRequest(prompt, settings, env) {
  return {
    url: settings.url,
    init: {
      method: "POST",
      headers: { "x-api-key": env[settings.keyVar], "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: settings.model, max_tokens: 100, messages: [{ role: "user", content: prompt }] }),
    },
  };
}

/** The default provider: a Messages API compatible endpoint. Errors name the status only. */
export function makeLlmProvider(env, fetchImpl) {
  const settings = llmSettings(env);
  return async (prompt) => {
    const { url, init } = buildLlmRequest(prompt, settings, env);
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
    const text = body?.content?.[0]?.text;
    if (typeof text !== "string") throw new Error("model answer has no content[0].text");
    return text;
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

/** Builds the draft object. `provider` is null for --no-llm. */
export async function buildDraft(blocks, { rules = [], provider = null, machine, now, concurrency = 2 }) {
  const unmapped = [];
  const entries = await mapLimit(blocks, Math.max(1, Math.min(4, concurrency)), async (b) => {
    const m = matchRule(b, rules);
    if (!m) unmapped.push(b);
    let worked = "";
    let error;
    if (provider) {
      try {
        worked = postProcess(await provider(buildPrompt(b)));
        if (!worked) error = "model returned an empty line";
      } catch (e) {
        error = e instanceof Error ? e.message : "model request failed";
      }
    } else {
      worked = templateLine(b);
    }
    const flagged = worked ? flagLine(worked) : null;
    const entry = { id: b.id, initiative: m ? m.rule.initiative : "unassigned" };
    if (m?.rule.title) entry.title = m.rule.title;
    if (m?.rule.key) entry.key = m.rule.key;
    Object.assign(entry, {
      worked,
      size: sizeOf(b.minutes),
      at: new Date(b.endMs).toISOString(),
      session: b.session.slice(0, SESSION_MAX),
      machine,
      include: Boolean(worked) && !flagged && !error,
      mappedBy: m ? m.mappedBy : "none",
      repo: b.repo,
      branch: b.branch,
      turns: b.turns,
      minutes: b.minutes,
    });
    if (flagged) entry.flagged = flagged;
    if (error) entry.error = error;
    return entry;
  });
  return {
    draft: { v: 1, kind: DRAFT_KIND, generatedAt: new Date(now).toISOString(), entries },
    template: mapTemplate(unmapped),
  };
}

function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(CONTROL_RE, " ");
}

/** A readable table of the draft. */
export function draftMarkdown(draft) {
  const rows = draft.entries.map((e) => {
    const inc = e.include ? "yes" : `no${e.flagged ? ` (flagged: ${e.flagged})` : e.error ? ` (error: ${e.error})` : ""}`;
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

/** Splits entries into request bodies of at most 2000 entries and 1 MB each. */
export function batchEntries(entries, { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
  const overhead = Buffer.byteLength(JSON.stringify({ v: 1, entries: [] }));
  const batches = [];
  let cur = [];
  let bytes = overhead;
  for (const e of entries) {
    const own = Buffer.byteLength(JSON.stringify(e));
    if (overhead + own > maxBytes) throw new CliError(`entry ${e.id} alone is over ${maxBytes} bytes`);
    // A comma separates entries after the first.
    if (cur.length && (cur.length >= maxEntries || bytes + own + 1 > maxBytes)) {
      batches.push(cur);
      cur = [];
      bytes = overhead;
    }
    bytes += own + (cur.length ? 1 : 0);
    cur.push(e);
  }
  if (cur.length) batches.push(cur);
  return batches;
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
  const valued = new Set(["--out", "--projects-dir", "--map", "--since", "--until", "--settle-hours", "--machine", "--concurrency", "--draft", "--url", "--from"]);
  const bare = new Set(["--no-llm", "--dry-run"]);
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

async function runDraft(flags, deps) {
  const { stdout } = deps;
  if (!flags.out) throw new CliError("draft needs --out <file.json>");
  if (flags.url.length || flags.draft || flags["dry-run"] || flags.from) throw new CliError("--url, --draft, --from and --dry-run are for upload");
  const settleHours = intFlag(flags["settle-hours"], "--settle-hours", 0, 24 * 365, 2);
  const concurrency = Math.floor(intFlag(flags.concurrency, "--concurrency", 1, 4, 2));
  const since = flags.since !== undefined ? parseBound(flags.since, "--since") : undefined;
  const until = flags.until !== undefined ? parseBound(flags.until, "--until", true) : undefined;
  if (flags.machine !== undefined && !MACHINE_RE.test(flags.machine)) {
    throw new CliError(`--machine must be 1 to ${MACHINE_MAX} characters of A-Z a-z 0-9 . _ -`);
  }
  const machine = flags.machine ?? reduceMachine(deps.hostname());
  if (!machine) throw new CliError("this host name has none of A-Z a-z 0-9 . _ -; pass --machine");
  let rules = [];
  if (flags.map) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(flags.map, "utf8"));
    } catch {
      throw new CliError(`cannot read the map file as JSON: ${flags.map}`);
    }
    rules = validateMap(raw);
  }
  // Settings first: a missing variable fails before any transcript is read.
  const provider = flags["no-llm"] ? null : (deps.provider ?? makeLlmProvider(deps.env, deps.fetch));
  const dir = flags["projects-dir"] ?? defaultProjectsDir();
  const { sessions, files } = readTranscripts(dir);
  const blocks = collectBlocks(sessions, { now: deps.now(), settleHours, since, until });
  const { draft, template } = await buildDraft(blocks, { rules, provider, machine, now: deps.now(), concurrency });
  const p = outputPaths(flags.out);
  fs.mkdirSync(path.dirname(path.resolve(p.json)), { recursive: true });
  fs.writeFileSync(p.json, `${JSON.stringify(draft, null, 2)}\n`);
  fs.writeFileSync(p.md, draftMarkdown(draft));
  fs.writeFileSync(p.template, `${JSON.stringify(template, null, 2)}\n`);
  const included = draft.entries.filter((e) => e.include).length;
  const flagged = draft.entries.filter((e) => e.flagged).length;
  const errors = draft.entries.filter((e) => e.error).length;
  const unassigned = draft.entries.filter((e) => e.initiative === "unassigned").length;
  stdout(`${files} transcript files, ${sessions.size} sessions, ${draft.entries.length} blocks drafted.`);
  stdout(`${included} included, ${flagged} flagged, ${errors} drafting errors, ${unassigned} unassigned.`);
  stdout(`Draft: ${p.json}`);
  stdout(`Table: ${p.md}`);
  stdout(`Map template: ${p.template}`);
  stdout("Nothing was uploaded. Review the draft, then run upload with a backfill link.");
  return 0;
}

function printAnswer(stdout, body) {
  const n = (v) => (typeof v === "number" ? v : 0);
  const refused = Array.isArray(body?.refused) ? body.refused : [];
  const created = Array.isArray(body?.created) ? body.created : [];
  const reassigned = Array.isArray(body?.reassigned) ? body.reassigned : [];
  stdout(`accepted ${n(body?.accepted)}, duplicate ${n(body?.duplicate)}, refused ${refused.length}, created ${created.length}, reassigned to unassigned ${reassigned.length}`);
  for (const r of refused) stdout(`  refused #${r?.index} ${r?.id}: ${r?.reason}`);
  if (created.length) stdout(`  created initiatives: ${created.join(", ")}`);
}

async function runUpload(flags, deps) {
  const { stdout, stderr } = deps;
  if (!flags.draft) throw new CliError("upload needs --draft <file.json>");
  if (flags.out || flags.map || flags["no-llm"]) throw new CliError("--out, --map and --no-llm are for draft");
  if (!flags["dry-run"] && !flags.url.length) throw new CliError("upload needs --url <link> (or --dry-run)");
  for (const u of flags.url) checkUploadUrl(u);
  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(flags.draft, "utf8"));
  } catch {
    throw new CliError(`cannot read the draft as JSON: ${flags.draft}`);
  }
  const all = uploadEntries(draft);
  const from = Math.floor(intFlag(flags.from, "--from", 0, Number.MAX_SAFE_INTEGER, 0));
  const entries = all.slice(from);
  if (!entries.length) {
    stdout(`Nothing to send: ${all.length} sendable entries, starting at ${from}.`);
    return 0;
  }
  const batches = batchEntries(entries);
  if (flags["dry-run"]) {
    const bytes = batches.map((b) => Buffer.byteLength(JSON.stringify({ v: 1, entries: b })));
    stdout(`Dry run: ${entries.length} entries in ${batches.length} batch(es) of ${bytes.join(", ")} bytes. Nothing sent.`);
    for (const e of entries.slice(0, 3)) stdout(`  ${e.at} ${e.initiative}: ${e.worked}`);
    return 0;
  }
  let sent = 0;
  let failed = false;
  for (let i = 0; i < batches.length && i < flags.url.length; i++) {
    const url = flags.url[i];
    const masked = maskUrl(url);
    const body = JSON.stringify({ v: 1, entries: batches[i] });
    stdout(`Uploading ${batches[i].length} entries to ${masked}`);
    let res;
    try {
      res = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
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
