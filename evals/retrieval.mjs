#!/usr/bin/env node
// Offline retrieval eval (no LLM, free, CI-friendly): loads a fixed memory corpus into a fresh BAB, sends each
// fixture query through the same MCP bab_search an agent uses, and scores where the relevant memory ranks.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { assertBuilt, postLearning, startBab } from "./lib/bab-server.mjs";
import { McpClient } from "./lib/mcp.mjs";
import { resultIds, retrievalScores } from "./lib/metrics.mjs";
import { EVALS_DIR, FIXTURES_DIR } from "./lib/paths.mjs";
import { mean } from "./lib/stats.mjs";

const { values: opt } = parseArgs({
  options: {
    corpus: { type: "string", default: "colleague" },
    limit: { type: "string", default: "10" },
    "min-recall5": { type: "string", default: "0" },
    "min-mrr": { type: "string", default: "0" },
    out: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (opt.help) {
  console.log(`Usage: node evals/retrieval.mjs [--corpus colleague|handwritten] [--limit N] [--min-recall5 X] [--min-mrr X] [--out DIR]
Exits 1 when recall@5 or MRR (plain search, all queries) falls below the given minimum.`);
  process.exit(0);
}

const read = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8"));
// The filter BAB's MCP instructions suggest before changing a repo; an ablation, since it excludes kind=learning.
const VARIANTS = { plain: {}, "kind-filter": { kind: ["standard", "decision", "practice"] } };

function aggregate(rows) {
  const keys = ["recall@1", "recall@3", "recall@5", "rr"];
  const out = { n: rows.length, zeroResultRate: mean(rows.map((r) => (r.nResults === 0 ? 1 : 0))) };
  for (const k of keys) out[k === "rr" ? "mrr" : k] = mean(rows.map((r) => r[k]));
  return out;
}

async function main() {
  assertBuilt();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.resolve(opt.out ?? path.join(EVALS_DIR, "out", `${stamp}-retrieval`));
  fs.mkdirSync(outDir, { recursive: true });
  const corpus = opt.corpus === "handwritten" ? read("handwritten.json") : read("colleague-learnings.json").learnings;
  const distractors = read("distractors.json").learnings;
  const queries = read("retrieval-queries.json").queries;
  const bab = await startBab({ dataDir: path.join(outDir, "bab-data"), logFile: path.join(outDir, "bab-server.log") });
  const rows = [];
  try {
    for (const l of distractors) await postLearning(bab.origin, { email: "demo.colleague@example.com", name: "Demo Colleague" }, { title: l.title, body: l.body, tags: l.tags });
    const relevant = {};
    for (const l of corpus) {
      const created = await postLearning(bab.origin, { email: "colleague.agent@example.com", name: "Colleague Agent" }, { title: l.title, body: l.body, tags: l.tags });
      (relevant[l.family] ??= new Set()).add(created.id);
    }
    const mcp = await new McpClient(bab.origin, "retrieval.eval@example.com", "Retrieval Eval").init();
    for (const q of queries) {
      for (const [variant, extra] of Object.entries(VARIANTS)) {
        const { text } = await mcp.call("bab_search", { query: q.query, limit: Number(opt.limit), ...extra });
        const ids = resultIds(text);
        const idx = ids.findIndex((id) => relevant[q.family]?.has(id));
        const rank = idx === -1 ? null : idx + 1;
        rows.push({ ...q, variant, rank, nResults: ids.length, ...retrievalScores(rank) });
      }
    }
  } finally {
    await bab.stop();
    fs.rmSync(path.join(outDir, "bab-data"), { recursive: true, force: true });
  }
  const summary = { corpus: opt.corpus, corpusSize: corpus.length, distractors: distractors.length, queries: queries.length, byVariant: {}, byType: {}, byFamily: {} };
  for (const v of Object.keys(VARIANTS)) summary.byVariant[v] = aggregate(rows.filter((r) => r.variant === v));
  const plain = rows.filter((r) => r.variant === "plain");
  for (const t of [...new Set(plain.map((r) => r.type))]) summary.byType[t] = aggregate(plain.filter((r) => r.type === t));
  for (const f of [...new Set(plain.map((r) => r.family))]) summary.byFamily[f] = aggregate(plain.filter((r) => r.family === f));
  const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
  const table = (obj, label) => [
    `| ${label} | n | recall@1 | recall@3 | recall@5 | MRR | zero results |`, "|---|---|---|---|---|---|---|",
    ...Object.entries(obj).map(([k, s]) => `| ${k} | ${s.n} | ${f2(s["recall@1"])} | ${f2(s["recall@3"])} | ${f2(s["recall@5"])} | ${f2(s.mrr)} | ${f2(s.zeroResultRate)} |`),
  ];
  const misses = plain.filter((r) => r.rank === null || r.rank > 5);
  const md = [
    `# BAB retrieval eval (offline, no LLM)`, "",
    `Corpus: ${corpus.length} target memories (${opt.corpus}) + ${distractors.length} distractors. ${queries.length} queries, each run through MCP \`bab_search\` (limit ${opt.limit}).`, "",
    ...table(summary.byVariant, "Search variant"), "",
    "`kind-filter` adds `kind: [standard, decision, practice]`, the filter BAB's MCP instructions suggest before changing a repo. It excludes memories of kind `learning`.", "",
    ...table(summary.byType, "Query type (plain)"), "",
    ...table(summary.byFamily, "Family (plain)"), "",
    `## Misses (plain search, relevant memory not in top 5): ${misses.length}`, "",
    ...misses.map((r) => `- [${r.family}/${r.type}] "${r.query}" -> ${r.rank === null ? (r.nResults ? "not returned" : "no results") : `rank ${r.rank}`}`),
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "retrieval.json"), JSON.stringify({ summary, rows }, null, 2));
  fs.writeFileSync(path.join(outDir, "retrieval.md"), md);
  console.log(md);
  console.log(`wrote ${outDir}/retrieval.md and retrieval.json`);
  const p = summary.byVariant.plain;
  const fails = [];
  if (p["recall@5"] < Number(opt["min-recall5"])) fails.push(`recall@5 ${f2(p["recall@5"])} < ${opt["min-recall5"]}`);
  if (p.mrr < Number(opt["min-mrr"])) fails.push(`MRR ${f2(p.mrr)} < ${opt["min-mrr"]}`);
  if (fails.length) {
    console.error(`retrieval eval below threshold: ${fails.join("; ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
