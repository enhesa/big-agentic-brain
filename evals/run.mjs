#!/usr/bin/env node
// BAB agent eval: does shared team memory help a coding agent fix bugs a colleague already solved?
// Usage: pnpm eval [--mode smoke|full] [flags]   (see evals/README.md)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runAgent } from "./lib/agent.mjs";
import { assertBuilt, startBab } from "./lib/bab-server.mjs";
import { allTaskIds, applyOracle, grade, loadTask, makeWorkspace, useSuite } from "./lib/grading.mjs";
import { conditionSpec, CONDITIONS, memoriesFor } from "./lib/conditions.mjs";
import { buildMemories } from "./lib/memory.mjs";
import { memoryMetrics } from "./lib/metrics.mjs";
import { EVALS_DIR, REPO_ROOT, scratchRoot } from "./lib/paths.mjs";
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
    tkTasks: "tk1-eval-invoices,tk3-eval-geocode,tk8-eval-charges",
    trials: 1,
    memory: "fixture",
    budget: 0.5,
  },
  full: { model: "claude-sonnet-5-5", tasks: "", conditions: "A,B,C", trials: 3, memory: "live", budget: 25 },
};

const HELP = `Usage: node evals/run.mjs [options]
  --mode smoke|full        presets (default smoke). Flags below override the preset.
  --suite core|tk          core: bugs the repo itself reveals (evals/tasks); tk: team knowledge, the fix needs a
                           fact that is only in a colleague's memory (evals/tasks-tk; eval tasks are its variants)
  --conditions A,B,...     A no BAB; B BAB + colleague memory; C BAB + distractors only; H BAB + hand-written notes;
                           ablations on B's memory: L lean toolset, F old kind-filter search advice, N search-first nudge,
                           R auto-retrieval (top 3 injected); AR auto-recorded memory; hazards: ST stale memory,
                           CF stale + current (conflict), WR wrong memory (core). See evals/README.md.
  --tasks id,id            task ids (default: all core tasks / all tk variants in full, 3 in smoke)
  --trials N               trials per task and condition
  --memory fixture|live    B memory: recorded fixture (cheap) or a live colleague agent run
  --budget-usd X           hard spend cap (USD); unknown model price is an error; skippedForBudget is reported
  --parallel N             concurrent runs (default 3)
  --sandbox auto|bwrap|none  agent bash isolation (default auto: bwrap required unless --sandbox none)
  --max-turns N  --max-seconds N  --seed N  --out DIR
  --resume                 continue an interrupted run in --out: keep finished runs, redo unfinished ones
  --validate               no LLM: check every task fails as shipped and passes with its reference fix
Env: BAB_EVAL_PROVIDER (anthropic|openai), BAB_EVAL_MODEL, BAB_EVAL_BASE_URL, BAB_EVAL_API_KEY_ENV,
     ANTHROPIC_API_KEY / OPENAI_API_KEY, BAB_EVAL_PRICE="in,out,cacheRead,cacheWrite" (USD per 1M tokens),
     BAB_EVAL_STANDALONE (default .next/standalone), BAB_EVAL_NODE (Node >= 24 for the BAB server).`;

const { values: opt } = parseArgs({
  options: {
    mode: { type: "string", default: "smoke" },
    suite: { type: "string", default: "core" },
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
    resume: { type: "boolean", default: false },
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
    const dir = fs.mkdtempSync(path.join(scratchRoot(), ".validate-"));
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

// A job that throws (e.g. BAB would not start) is logged and left without meta.json, so --resume redoes it.
const harnessFailures = []; // rows for summary.md when a job throws before writing meta.json
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await fn(item);
      } catch (e) {
        const id = `${String(item.order ?? 0).padStart(4, "0")}-${item.task}-${item.condition}-t${item.trial}`;
        harnessFailures.push({
          run_id: id, task: item.task, condition: item.condition, trial: item.trial, order_idx: item.order ?? 0,
          stop_reason: "harness_error", success: 0, error: String(e.message ?? e).slice(0, 500),
          suspicious_cmds: 0, cost_usd: 0, finished: 0,
        });
        console.error(`[eval] job ${item.task}/${item.condition}/t${item.trial} failed in the harness: ${e.message}`);
      }
    }
  }));
}

async function main() {
  useSuite(opt.suite);
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
  if (!price) {
    throw new Error(`No price known for ${model}; set BAB_EVAL_PRICE="in,out,cacheRead,cacheWrite" (USD per 1M). Budget cannot be enforced without a price.`);
  }
  const conditions = (opt.conditions ?? preset.conditions).split(",");
  conditions.forEach(conditionSpec);
  const presetTasks = opt.suite === "core" ? preset.tasks : preset.tkTasks;
  const tasks = (opt.tasks ?? presetTasks) ? (opt.tasks ?? presetTasks).split(",")
    : allTaskIds().filter((t) => opt.suite === "core" || loadTask(t).variant === "variant");
  const trials = Number(opt.trials ?? preset.trials);
  const memory = opt.memory ?? preset.memory;
  const budget = Number(opt["budget-usd"] ?? preset.budget);
  const sandbox = sandboxMode(opt.sandbox);
  const maxTurns = Number(opt["max-turns"]);
  const maxSeconds = Number(opt["max-seconds"]);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Default under scratchRoot (outside the repo/tasks tree) so ws/out cannot climb into hidden/oracle.
  const outDir = path.resolve(opt.out ?? path.join(scratchRoot(), "out", `${stamp}-${opt.mode}`));
  // Refuse an outDir that sits inside the tasks tree.
  const tasksReal = fs.realpathSync(EVALS_DIR);
  if (outDir === tasksReal || outDir.startsWith(tasksReal + path.sep)) {
    throw new Error(`--out must be outside ${EVALS_DIR} (got ${outDir}); use BAB_EVAL_SCRATCH or a path under /tmp`);
  }
  fs.mkdirSync(path.join(outDir, "runs"), { recursive: true });
  let babCommit = "unknown";
  try {
    babCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {}
  const meta = {
    mode: opt.mode, suite: opt.suite, provider, model, price, pricesChecked: PRICES_CHECKED, conditions, tasks, trials, memory, budget,
    sandbox, maxTurns, maxSeconds, seed: Number(opt.seed), babCommit, date: new Date().toISOString(), node: process.version,
  };
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  log(`[eval] ${opt.mode}: ${model} | tasks=${tasks.length} conditions=${conditions} trials=${trials} memory=${memory} sandbox=${sandbox} budget=$${budget} -> ${outDir}`);
  if (sandbox === "none") log("[eval] warning: no bubblewrap; agent commands run unsandboxed (cleared env, repo as cwd)");

  const { snaps, seedCost } = await buildMemories({ outDir, suite: opt.suite, memories: memoriesFor(conditions), memory, providerCfg, price, sandbox, maxTurns, maxSeconds, log });
  let spent = seedCost;
  const jobs = shuffle(tasks.flatMap((task) => conditions.flatMap((condition) => Array.from({ length: trials }, (_, k) => ({ task, condition, trial: k + 1 })))), Number(opt.seed));
  jobs.forEach((j, i) => (j.order = i));
  const rows = [];
  let skipped = 0;
  const jobId = (job) => `${String(job.order).padStart(4, "0")}-${job.task}-${job.condition}-t${job.trial}`;
  if (opt.resume) {
    for (const job of jobs) {
      const d = path.join(outDir, "runs", jobId(job));
      if (fs.existsSync(path.join(d, "meta.json"))) {
        const { summary, babCalls, learned, reacts, injected, ...row } = JSON.parse(fs.readFileSync(path.join(d, "meta.json"), "utf8"));
        rows.push(row);
        spent += Number(row.cost_usd);
        job.done = true;
      } else if (fs.existsSync(d)) fs.renameSync(d, `${d}.crashed-${Date.now()}`);
    }
    log(`[eval] resume: ${rows.length} finished runs kept, ${jobs.filter((j) => !j.done).length} to go (spent so far $${spent.toFixed(3)})`);
  }
  // Hard budget: reserve an estimated per-run cost so --parallel cannot overshoot by more than about one estimate.
  // Unknown prices already threw above. Estimate ≈ maxTurns * (2k in + 1k out) tokens at list price, min $0.02.
  const estPerRun = Math.max(
    0.02,
    ((2000 * (price.input + price.cacheWrite) + 1000 * price.output) * Math.min(maxTurns, 20)) / 1e6,
  );
  const reserveUsd = estPerRun;
  log(`[eval] budget reserve ≈ $${reserveUsd.toFixed(4)}/run (est); parallel=${opt.parallel}`);
  await pool(jobs.filter((j) => !j.done), Number(opt.parallel), async (job) => {
    if (spent + reserveUsd > budget) {
      skipped++;
      return;
    }
    spent += reserveUsd; // reserve; reconciled after the run
    const t = loadTask(job.task);
    const id = jobId(job);
    const d = path.join(outDir, "runs", id);
    fs.mkdirSync(d, { recursive: true });
    // Workspace under scratch, never under the tasks tree.
    const ws = makeWorkspace(t, path.join(scratchRoot(), "ws", id));
    const startedAt = new Date().toISOString();
    const common = { prompt: t.prompt, ws, providerCfg, sandbox, maxTurns, maxSeconds, logPath: path.join(d, "transcript.jsonl") };
    let run;
    const spec = conditionSpec(job.condition);
    const snap = spec.memory ? snaps[spec.memory] : null;
    if (!snap) {
      run = await runAgent(common);
    } else {
      let bab;
      for (let attempt = 1; ; attempt++) {
        try {
          bab = await startBab({ dataDir: path.join(d, "bab-data"), seedFrom: snap.dir, logFile: path.join(d, "bab-server.log") });
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          log(`[eval] ${id}: BAB start failed (${e.message}); retry ${attempt}`);
          await new Promise((r) => setTimeout(r, 5000 * attempt));
        }
      }
      try {
        run = await runAgent({ ...common, integration: spec.integration, bab: { origin: bab.origin, identity: { email: `dev.agent.${job.order}@example.com`, name: "Dev Agent" } } });
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
    const rel = new Set(snap?.relevant?.[t.family] ?? []);
    const haz = new Set(snap?.hazard?.[t.family] ?? []);
    const mm = memoryMetrics(run, rel, haz);
    const cost = costUsd(run.usage, price);
    spent += cost - reserveUsd; // replace reservation with actual
    const u = run.usage;
    const row = {
      run_id: id, task: t.id, family: t.family, variant: t.variant, condition: job.condition, trial: job.trial, order_idx: job.order,
      model, sandbox, success: g.pass ? 1 : 0, finished: run.finished ? 1 : 0, stop_reason: run.stopReason, wall_s: run.wallS.toFixed(2),
      turns: run.turns, tool_calls: run.toolCalls, input_tokens: u.input, output_tokens: u.output, cache_read_tokens: u.cacheRead,
      cache_write_tokens: u.cacheWrite, total_tokens: u.input + u.output + u.cacheRead + u.cacheWrite, cost_usd: cost.toFixed(6),
      bab_calls_total: Object.values(run.babCalls).reduce((a, b) => a + b, 0), bab_search_calls: run.babCalls.bab_search ?? 0,
      bab_learn_calls: run.babCalls.bab_learn ?? 0, bab_react_calls: run.babCalls.bab_react ?? 0, bab_queried: mm.queried ? 1 : 0,
      memory_hit: mm.hit ? 1 : 0, memory_hit_rank: mm.hitRank ?? "", memory_reacted: mm.reacted ? 1 : 0,
      zero_result_searches: mm.zeroResultSearches, injected_relevant: mm.injectedRelevant ? 1 : 0, relevant_seen: mm.relevantSeen ? 1 : 0,
      hazard_seen: mm.hazardSeen ? 1 : 0, hazard_flagged: mm.hazardFlagged ? 1 : 0, hazard_endorsed: mm.hazardEndorsed ? 1 : 0, suspicious_cmds: run.suspicious.length, error: run.error, started_at: startedAt,
    };
    if (run.suspicious.length) {
      row.success = 0;
      log(`[eval] ${id}: FLAGGED suspicious_cmds=${run.suspicious.length}; excluded from paired stats`);
    }
    rows.push(row);
    fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify({ ...row, summary: run.summary, babCalls: run.babCalls, learned: run.learned, reacts: run.reacts, injected: run.injected, suspicious: run.suspicious }, null, 2));
    log(`[eval] ${id}: success=${g.pass} turns=${run.turns} $${cost.toFixed(4)} bab=${JSON.stringify(run.babCalls)} hit=${mm.hitRank ?? "-"} (spent $${spent.toFixed(3)})`);
  });
  for (const h of harnessFailures) rows.push(h);
  rows.sort((a, b) => a.order_idx - b.order_idx);
  const md = writeReports(outDir, rows, { ...meta, spendUsd: spent - seedCost, seedCostUsd: seedCost, skippedForBudget: skipped });
  log(`\n${md}`);
  log(`[eval] wrote ${path.join(outDir, "summary.md")}, results.json, results.csv${skipped ? ` (${skipped} runs skipped: budget reached)` : ""}`);
  const errored = rows.filter((r) => r.stop_reason === "error" || r.stop_reason === "timeout" || r.stop_reason === "harness_error").length;
  if (harnessFailures.length) log(`[eval] ${harnessFailures.length} job(s) failed in the harness; listed in summary.md; rerun with --resume`);
  if (errored) {
    log(`[eval] ${errored} run(s) ended with an API/timeout/harness error (excluded from success rates)`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
