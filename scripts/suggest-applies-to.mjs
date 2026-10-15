#!/usr/bin/env node
// Proposes "applies to" labels for existing memories, with simple keyword rules.
//
// It NEVER writes to a database. It reads an exported list of memories and writes a JSON file of
// suggestions for the owner to review. Nothing is applied until the owner approves.
//
// The vocabulary and aliases live in lib/applies-to.ts (the source of truth). The keyword rules
// below repeat only the labels, because a .mjs script cannot import that TypeScript file; keep
// the LABELS list in step with it.
//
// Usage:
//   node scripts/suggest-applies-to.mjs <memories.json> [--out <suggestions.json>] [--all]
//
// Input: a JSON array of memories, or an object with a `results` array (what GET /api/learnings
// returns). Each memory needs id, title, body and tags (a list, or a JSON string as stored).
// A memory that already has labels (appliesTo list, or applies_to JSON string) is skipped.
//
// Export, either of:
//   - from a copy of the nightly snapshot (never the live file), with the sqlite3 CLI:
//       sqlite3 -json snapshot.db "SELECT id, title, body, tags, applies_to FROM learnings
//                                  WHERE status = 'active'" > memories.json
//   - from the API, one page at a time (a text search returns at most 20, a listing 50).
//
// Output (default: suggestions.json next to the input): [{ id, title, suggested, matchedOn, note? }]
//   suggested  the labels proposed, [] when none or when the memory looks general
//   matchedOn  { label: [the words that matched] }, so the owner can see why
// Only memories with at least one match are written, plus those marked general; --all lists every
// memory. A memory that matches more than MAX_LABELS labels is cross-cutting: it gets
// suggested [] and a note, not a long list.
//
// Review the file, then apply what you agree with through bab_learn corrections or a reviewed
// SQL update. This script does not do either.

import fs from "node:fs";
import path from "node:path";

const MAX_LABELS = 3;

// label -> keywords (regular expression sources, matched case-insensitively). Word boundaries keep
// "go" from matching "going" and "java" from matching "javascript".
const LABELS = {
  dotnet: ["(?<![\\w])\\.net\\b", "\\bdotnet\\b", "\\bc#", "\\bcsharp\\b", "\\.csproj\\b", "\\.sln\\b", "\\bnuget\\b", "\\basp\\.?net\\b", "\\bentity framework\\b", "\\befcore\\b", "\\bxunit\\b", "\\bmstest\\b"],
  node: ["\\bnode\\.?js\\b","\\bnpm\\b", "\\bpnpm\\b", "\\byarn\\b", "package\\.json", "\\bnext\\.js\\b"],
  typescript: ["\\btypescript\\b", "\\btsconfig\\b", "\\.tsx?\\b"],
  python: ["\\bpython3?\\b", "\\bpip\\b", "\\bpyproject\\b", "\\bpytest\\b", "requirements\\.txt", "\\bpoetry\\b"],
  angular: ["\\bangular\\b", "\\bngrx\\b", "\\bangular\\.json\\b"],
  react: ["\\breact\\b", "\\bjsx\\b"],
  java: ["\\bjava\\b", "\\bmaven\\b", "\\bgradle\\b", "\\bspring boot\\b"],
  go: ["\\bgolang\\b", "go\\.mod\\b", "\\bgoroutines?\\b"],
  sql: ["\\bsql\\b", "\\bt-sql\\b", "\\bmssql\\b", "\\bsql server\\b"],
  postgres: ["\\bpostgres(ql)?\\b", "\\bpsql\\b", "\\bnpgsql\\b"],
  sqlite: ["\\bsqlite\\b", "node:sqlite"],
  elasticsearch: ["\\belasticsearch\\b", "\\bopensearch\\b", "\\bkibana\\b"],
  kafka: ["\\bkafka\\b"],
  docker: ["\\bdocker(file)?\\b", "\\bcontainer image\\b", "\\bacr\\b"],
  helm: ["\\bhelm\\b", "values-(dev|qa|acc|prod)\\.yaml"],
  terraform: ["\\bterraform\\b", "\\btfstate\\b"],
  aks: ["\\baks\\b", "\\bkubectl\\b", "\\bk8s\\b", "\\bkubernetes\\b", "\\bargocd\\b", "\\bkeda\\b"],
  azure: ["\\bazure\\b", "\\baz cli\\b", "\\bazure devops\\b", "\\bapp configuration\\b"],
  aws: ["\\baws\\b", "\\bs3 bucket\\b", "\\bec2\\b"],
  windows: ["\\bwindows\\b", "\\bpowershell\\b", "\\bwsl\\b"],
  linux: ["\\blinux\\b", "\\bubuntu\\b", "\\bdebian\\b", "\\balpine\\b"],
  macos: ["\\bmacos\\b", "\\bmac os\\b", "\\bhomebrew\\b"],
};

const RULES = Object.entries(LABELS).map(([label, sources]) => ({
  label,
  patterns: sources.map((s) => new RegExp(s, "i")),
}));

/** The labels a memory text suggests, and which words matched. Pure; exported for the test. */
export function suggest(text) {
  const matchedOn = {};
  for (const { label, patterns } of RULES) {
    const hits = [];
    for (const p of patterns) {
      const m = p.exec(text);
      if (m) hits.push(m[0].toLowerCase());
    }
    if (hits.length > 0) matchedOn[label] = [...new Set(hits)];
  }
  const labels = Object.keys(matchedOn);
  if (labels.length > MAX_LABELS) {
    return { suggested: [], matchedOn, note: `matches ${labels.length} labels, probably general: left empty` };
  }
  return { suggested: labels, matchedOn };
}

function tagsOf(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function alreadyLabelled(memory) {
  const raw = memory.appliesTo ?? memory.applies_to;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw === "string") return tagsOf(raw).length > 0;
  return false;
}

/** Suggestions for a list of memories. Pure; exported for the test. */
export function suggestAll(memories, { all = false } = {}) {
  const out = [];
  for (const m of memories) {
    if (!m || typeof m.id !== "string" || alreadyLabelled(m)) continue;
    const text = [m.title, m.body, ...tagsOf(m.tags)].filter((s) => typeof s === "string").join("\n");
    const result = suggest(text);
    if (all || result.suggested.length > 0 || result.note) {
      out.push({ id: m.id, title: m.title ?? "", ...result });
    }
  }
  return out;
}

function main(argv) {
  const args = argv.slice(2);
  const all = args.includes("--all");
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const input = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
  if (!input || (outIdx >= 0 && !out)) {
    console.error("Usage: node scripts/suggest-applies-to.mjs <memories.json> [--out <suggestions.json>] [--all]");
    process.exit(2);
  }
  const parsed = JSON.parse(fs.readFileSync(input, "utf8"));
  const memories = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : null;
  if (!memories) {
    console.error("The input must be a JSON array of memories, or an object with a results array.");
    process.exit(2);
  }
  const suggestions = suggestAll(memories, { all });
  const target = out ?? path.join(path.dirname(path.resolve(input)), "suggestions.json");
  fs.writeFileSync(target, `${JSON.stringify(suggestions, null, 2)}\n`);
  const withLabels = suggestions.filter((s) => s.suggested.length > 0).length;
  console.log(`${memories.length} memories read, ${withLabels} with suggested labels, written to ${target}`);
  console.log("Nothing was applied. Review the file, then apply what you agree with.");
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
