#!/usr/bin/env node
// BAB agent eval: does shared team memory help a coding agent fix bugs a colleague already solved?
// Usage: pnpm eval [--mode smoke|full] [flags]   (see evals/README.md)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runAgent } from "./lib/agent.mjs";
import { assertBuilt, startBab } from "./lib/bab-server.mjs";
import { allTaskIds, applyOracle, grade, loadTask, makeWorkspace } from "./lib/grading.mjs";
import { buildMemories } from "./lib/memory.mjs";
import { memoryMetrics } from "./lib/metrics.mjs";
import { EVALS_DIR, REPO_ROOT } from "./lib/paths.mjs";
import { priceFor, PRICES_CHECKED } from "./lib/prices.mjs";
import { costUsd } from "./lib/providers.mjs";
import { writeReports } from "./lib/report.mjs";
import { rng } from "./lib/stats.mjs";
import { sandboxMode } from "./lib/sandbox.mjs";

const MODES = {
  smoke: {
    model: "claude-haiku-5-5",
    tasks: "f1-var-pricelist,f4-orig-env-bool,f6-var-overdue-filter",
    conditions: "A,B",
    trials: 1,
    memory: "fixture",
    budget: 0.5,
  },
  full: { model: "claude-sonnet-5-5", tasks: "", conditions: "A,B,C", trials: 3, memory: "live", budget: 25 },
};

const HELP = `Usage: node evals/run.mjs [options]
  --mode smoke|full        presets (default smoke). Flags below override the preset.
  --conditions A,B,C,H     A no BAB; B BAB + colleague memory; C BAB + distractors only; H BAB + hand-written notes
  --tasks id,id            task ids under evals/tasks (default: all in full, 3 in smoke)
  --trials N               trials per task and condition
  --memory fixture|live    B memory: recorded fixture (cheap) or a live colleague agent run
  --budget-usd X           stop starting new runs once spend reaches X
  --parallel N             concurrent runs (default 3)
  --sandbox auto|bwrap|none  agent bash isolation (default auto: bubblewrap when usable)
  --max-turns N  --max-seconds N  --seed N  --out DIR
  --validate               no LLM: check every task fails as shipped and passes with its reference fix
Env: BAB_EVAL_PROVIDER (anthropic|openai), BAB_EVAL_MODEL, BAB_EVAL_BASE_URL, BAB_EVAL_API_KEY_ENV,
     ANTHROPIC_API_KEY / OPENAI_API_KEY, BAB_EVAL_PRICE="in,out,cacheRead,cacheWrite" (USD per 1M tokens),
     BAB_EVAL_STANDALONE (default .next/standalone), BAB_EVAL_NODE (Node >= 24 for the BAB server).`;

const { values: opt } = parseArgs({
  options: {
    mode: { type: "string", default: "smoke" },
    conditions: { type: "string" },
    tasks: { type: "string" },
    trials: { type: "string" },
    memory: { type: "string" },
    "budget-usd": { type: "string" },
    parallel: { type: "string", default: "3" },
    sandbox: { type: "string", default: "auto" },
    "max-turns": { type: "string", default: "40" },
    "max-seconds": { type: "string", default: "900" },
    seed: { type: "string", default: "20261019" },
    out: { type: "string" },
    validate: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (opt.help) {
  console.log(HELP);
  process.exit(0);
}

const log = (s) => console.log(s);

async function validate() {
  let ok = true;
  for (const id of allTaskIds()) {
    const t = loadTask(id);
    const dir = fs.mkdtempSync(path.join(EVALS_DIR, ".validate-"));
    try {
      const ws = makeWorkspace(t, path.join(dir, "ws"));
      const before = await grade(t, ws);
      applyOracle(t, ws);
      const after = await grade(t, ws);
      const good = !before.pass && after.pass;
      ok &&= good;
      log(`${good ? "ok " : "BAD"} ${id.padEnd(28)} shipped=${before.pass ? "pass" : "fail"} reference=${after.pass ? "pass" : "fail"}`);
      if (!good) log(after.output.slice(-1500));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return ok;
}

function shuffle(xs, seed) {
  const r = rng(seed);
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function main() {
  if (opt.validate) process.exit((await validate()) ? 0 : 1);
  const preset = MODES[opt.mode];
  if (!preset) throw new Error(`--mode must be smoke or full`);
  assertBuilt();
  const provider = process.env.BAB_EVAL_PROVIDER ?? "anthropic";
  const model = process.env.BAB_EVAL_MODEL ?? preset.model;
  const providerCfg = { provider, model, baseUrl: process.env.BAB_EVAL_BASE_URL, keyEnv: process.env.BAB_EVAL_API_KEY_ENV };
  const keyEnv = providerCfg.keyEnv ?? (provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
  if (!process.env[keyEnv]) throw new Error(`Set ${keyEnv} (the key is read from the environment and never written to disk).`);
  const price = priceFor(model);
  if (!price) log(`warning: no price known for ${model}; set BAB_EVAL_PRICE to get costs (budget cap cannot be enforced)`);
  const conditions = (opt.conditions ?? preset.conditions).split(",");
  const tasks = (opt.tasks ?? preset.tasks) ? (opt.tasks ?? preset.tasks).split(",") : allTaskIds();
  const trials = Number(opt.trials ?? preset.trials);
  const memory = opt.memory ?? preset.memory;
  const budget = Number(opt["budget-usd"] ?? preset.budget);
  const sandbox = sandboxMode(opt.sandbox);
  const maxTurns = Number(opt["max-turns"]);
  const maxSeconds = Number(opt["max-seconds"]);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.resolve(opt.out ?? path.join(EVALS_DIR, "out", `${stamp}-${opt.mode}`));
  fs.mkdirSync(path.join(outDir, "runs"), { recursive: true });
  let babCommit = "unknown";
  try {
    babCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {}
  const meta = {
    mode: opt.mode, provider, model, price, pricesChecked: PRICES_CHECKED, conditions, tasks, trials, memory, budget,
    sandbox, maxTurns, maxSeconds, seed: Number(opt.seed), babCommit, date: new Date().toISOString(), node: process.version,
  };
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  log(`[eval] ${opt.mode}: ${model} | tasks=${tasks.length} conditions=${conditions} trials=${trials} memory=${memory} sandbox=${sandbox} budget=$${budget} -> ${outDir}`);
  if (sandbox === "none") log("[eval] warning: no bubblewrap; agent commands run unsandboxed (cleared env, repo as cwd)");

  const { snaps, seedCost } = await buildMemories({ outDir, conditions, memory, providerCfg, price, sandbox, maxTurns, maxSeconds, log });
  let spent = seedCost;
  const jobs = shuffle(tasks.flatMap((task) => conditions.flatMap((condition) => Array.from({ length: trials }, (_, k) => ({ task, condition, trial: k + 1 })))), Number(opt.seed));
  jobs.forEach((j, i) => (j.order = i));
  const rows = [];
  let skipped = 0;
  await pool(jobs, Number(opt.parallel), async (job) => {
    if (spent >= budget) {
      skipped++;
      return;
    }
    const t = loadTask(job.task);
    const id = `${String(job.order).padStart(4, "0")}-${t.id}-${job.condition}-t${job.trial}`;
    const d = path.join(outDir, "runs", id);
    fs.mkdirSync(d, { recursive: true });
    const ws = makeWorkspace(t, path.join(d, "ws"));
    const startedAt = new Date().toISOString();
    const common = { prompt: t.prompt, ws, providerCfg, sandbox, maxTurns, maxSeconds, logPath: path.join(d, "transcript.jsonl") };
    let run;
    if (job.condition === "A") {
      run = await runAgent(common);
    } else {
      const bab = await startBab({ dataDir: path.join(d, "bab-data"), seedFrom: snaps[job.condition].dir, logFile: path.join(d, "bab-server.log") });
      try {
        run = await runAgent({ ...common, bab: { origin: bab.origin, identity: { email: `dev.agent.${job.order}@example.com`, name: "Dev Agent" } } });
      } finally {
        await bab.stop();
        fs.rmSync(path.join(d, "bab-data"), { recursive: true, force: true });
      }
    }
    const g = await grade(t, ws);
    fs.writeFileSync(path.join(d, "grade.txt"), g.output);
    try {
      fs.writeFileSync(path.join(d, "diff.patch"), execFileSync("git", ["-C", ws, "diff"], { encoding: "utf8" }));
    } catch {}
    fs.rmSync(ws, { recursive: true, force: true });
    const rel = new Set(snaps[job.condition]?.relevant?.[t.family] ?? []);
    const mm = memoryMetrics(run, rel);
    const cost = costUsd(run.usage, price);
    spent += cost;
    const u = run.usage;
    const row = {
      run_id: id, task: t.id, family: t.family, variant: t.variant, condition: job.condition, trial: job.trial, order_idx: job.order,
      model, sandbox, success: g.pass ? 1 : 0, finished: run.finished ? 1 : 0, stop_reason: run.stopReason, wall_s: run.wallS.toFixed(2),
      turns: run.turns, tool_calls: run.toolCalls, input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cacheRead,
      cache_write_tokens: u.cacheWrite, total_tokens: u.input + u.output + u.cacheRead + u.cacheWrite, cost_usd: cost.toFixed(6),
      bab_calls_total: Object.values(run.babCalls).reduce((a, b) => a + b, 0), bab_search_calls: run.babCalls.bab_search ?? 0,
      bab_learn_calls: run.babCalls.bab_learn ?? 0, bab_react_calls: run.babCalls.bab_react ?? 0, bab_queried: mm.queried ? 1 : 0,
      memory_hit: mm.hit ? 1 : 0, memory_hit_rank: mm.hitRank ?? "", memory_reacted: mm.reacted ? 1 : 0,
      zero_result_searches: mm.zeroResultSearches, suspicious_cmds: run.suspicious.length, error: run.error, started_at: startedAt,
    };
    rows.push(row);
    fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify({ ...row, summary: run.summary, babCalls: run.babCalls }, null, 2));
    log(`[eval] ${id}: success=${g.pass} turns=${run.turns} $${cost.toFixed(4)} bab=${JSON.stringify(run.babCalls)} hit=${mm.hitRank ?? "-"} (spent $${spent.toFixed(3)})`);
  });
  rows.sort((a, b) => a.order_idx - b.order_idx);
  const md = writeReports(outDir, rows, { ...meta, spendUsd: spent - seedCost, seedCostUsd: seedCost, skippedForBudget: skipped });
  log(`\n${md}`);
  log(`[eval] wrote ${path.join(outDir, "summary.md")}, results.json, results.csv${skipped ? ` (${skipped} runs skipped: budget reached)` : ""}`);
  const errored = rows.filter((r) => r.stop_reason === "error").length;
  if (errored) {
    log(`[eval] ${errored} run(s) ended with an API/harness error`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
