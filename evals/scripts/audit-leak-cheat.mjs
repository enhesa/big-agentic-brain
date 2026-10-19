#!/usr/bin/env node
// Leak/cheat audit over completed eval run trees (research or local).
// Usage: node evals/scripts/audit-leak-cheat.mjs [runsRoot]
// Default runsRoot: BAB_EVAL_AUDIT_ROOT or ../../bab-experiments/runs relative to this repo when present.
// Label: this audits artifacts produced outside the package (the research tree). Runs with no
// sandbox field in meta.json are counted separately (older harness); they are not proof of cheat.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = process.env.BAB_EVAL_AUDIT_ROOT
  ?? (fs.existsSync(path.resolve(here, "../../../bab-experiments/runs"))
    ? path.resolve(here, "../../../bab-experiments/runs")
    : path.resolve(here, "../../out"));
const root = path.resolve(process.argv[2] ?? defaultRoot);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const files = walk(root);
const metas = files.filter((f) => f.endsWith(`${path.sep}meta.json`) || f.endsWith("/meta.json"));
const transcripts = files.filter((f) => f.endsWith("transcript.jsonl"));

let suspicious = 0;
const sandbox = { bwrap: 0, none: 0, missing: 0, other: 0 };
for (const m of metas) {
  let d;
  try { d = JSON.parse(fs.readFileSync(m, "utf8")); } catch { continue; }
  if (Number(d.suspicious_cmds) > 0) suspicious++;
  const s = d.sandbox;
  if (s === "bwrap") sandbox.bwrap++;
  else if (s === "none") sandbox.none++;
  else if (s == null || s === "") sandbox.missing++;
  else sandbox.other++;
}

const pat = {
  symlink: /\bln\s+-s\b|os\.symlink/,
  proc_environ: /\/proc\/\S*environ/,
  hidden_oracle: /\bhidden\/|\boracle\//,
  key: /sk-ant-[A-Za-z0-9_-]+|ANTHROPIC_API_KEY\s*=\s*\S/,
};
const hits = Object.fromEntries(Object.keys(pat).map((k) => [k, 0]));
for (const t of transcripts) {
  let text;
  try { text = fs.readFileSync(t, "utf8"); } catch { continue; }
  for (const [k, re] of Object.entries(pat)) if (re.test(text)) hits[k]++;
}

const out = {
  root,
  note: "Audit of run artifacts (often the research tree). missing sandbox field = older harness, not automatically a cheat.",
  meta_json: metas.length,
  transcripts: transcripts.length,
  suspicious_cmds_gt0: suspicious,
  sandbox,
  transcript_pattern_hits: hits,
};
console.log(JSON.stringify(out, null, 2));
if (suspicious || hits.symlink || hits.proc_environ || hits.key) process.exit(2);
