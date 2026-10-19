// Builds the BAB data-dir snapshots each condition starts from (see conditions.mjs for which condition uses which).
//   distractors  BAB's demo memories + engineering near-misses: BAB connected, nothing relevant
//   colleague    distractors + colleague memory: fixture (recorded by a real agent, see fixtures/) or live (a colleague
//                agent solves the suite's original tasks now and records what it learned, nudged once with BAB's own
//                Stop-hook text if it did not record unprompted)
//   autorecord   distractors + the colleague's finish summaries posted verbatim (what an automatic recorder would keep)
//   handwritten  distractors + hand-written notes (labelled separately; not agent-recorded)
//   stale        distractors + outdated versions of the facts, backdated (tk suite)
//   conflict     stale + colleague
//   wrong        distractors + plausible but wrong root causes (core suite)
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runAgent } from "./agent.mjs";
import { postLearning, startBab } from "./bab-server.mjs";
import { allTaskIds, grade, loadTask, makeWorkspace } from "./grading.mjs";
import { FIXTURES_DIR } from "./paths.mjs";
import { costUsd } from "./providers.mjs";

const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
const DISTRACTOR_AUTHOR = { email: "demo.colleague@example.com", name: "Demo Colleague" };
export const COLLEAGUE = { email: "colleague.agent@example.com", name: "Colleague Agent" };
const HANDWRITTEN_AUTHOR = { email: "senior.dev@example.com", name: "Senior Dev (hand-written)" };
const FORMER_AUTHOR = { email: "former.colleague@example.com", name: "Former Colleague" };

export const SUITE_FIXTURES = {
  core: { colleague: "colleague-learnings.json", handwritten: "handwritten.json", wrong: "wrong-core.json" },
  tk: { colleague: "tk-colleague-learnings.json", stale: "tk-stale.json" },
};

function fixtureFor(suite, kind) {
  const f = SUITE_FIXTURES[suite]?.[kind];
  if (!f || !fs.existsSync(path.join(FIXTURES_DIR, f))) throw new Error(`no ${kind} memory fixture for suite ${suite}`);
  const d = readFixture(f);
  return Array.isArray(d) ? d : d.learnings;
}

function addId(map, family, id) {
  (map[family] ??= new Set()).add(id);
}

/** Make BAB see these learnings as `days` old (it derives ageDays and the verify flag from created_at). */
function backdate(dataDir, items) {
  if (!items.length) return;
  const db = new DatabaseSync(path.join(dataDir, "bab.db"));
  const st = db.prepare("UPDATE learnings SET created_at = datetime('now', ?), updated_at = datetime('now', ?) WHERE id = ?");
  for (const { id, days } of items) st.run(`-${days} days`, `-${days} days`, id);
  db.close();
}

async function snapshot(outDir, name, fill) {
  const dir = path.join(outDir, "memory", name);
  const tmp = `${dir}.tmp`;
  const bab = await startBab({ dataDir: tmp, logFile: path.join(outDir, "memory", `${name}.bab.log`) });
  const ctx = { relevant: {}, hazard: {}, backdate: [] };
  try {
    for (const l of readFixture("distractors.json").learnings) await postLearning(bab.origin, DISTRACTOR_AUTHOR, { title: l.title, body: l.body, tags: l.tags });
    await fill(bab.origin, ctx);
  } finally {
    await bab.stop();
  }
  backdate(tmp, ctx.backdate);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  const plain = (m) => Object.fromEntries(Object.entries(m).map(([f, s]) => [f, [...s]]));
  fs.writeFileSync(path.join(outDir, "memory", `${name}.relevant.json`), JSON.stringify({ relevant: plain(ctx.relevant), hazard: plain(ctx.hazard) }, null, 2));
  return { dir, relevant: ctx.relevant, hazard: ctx.hazard };
}

async function postAll(origin, ctx, author, items, target) {
  for (const l of items) {
    const created = await postLearning(origin, author, { title: l.title, body: l.body, tags: l.tags });
    addId(ctx[target], l.family, created.id);
    if (l.ageDays) ctx.backdate.push({ id: created.id, days: l.ageDays });
  }
}

/** First sentence of an agent's finish summary, as an automatic recorder would title it. */
export function autoTitle(summary) {
  const first = String(summary).split(/(?<=[.!?])\s/)[0].trim();
  return (first.length > 150 ? `${first.slice(0, 147)}...` : first) || "Fix summary";
}

/** Live colleague runs: each original task solved with BAB connected; returns learnings, summaries and cost. */
async function seedLive({ outDir, origin, providerCfg, price, sandbox, maxTurns, maxSeconds, log }) {
  const learnings = [];
  const runs = [];
  let cost = 0;
  for (const id of allTaskIds().filter((t) => loadTask(t).variant === "original")) {
    const task = loadTask(id);
    const d = path.join(outDir, "seed", id);
    fs.mkdirSync(d, { recursive: true });
    const ws = makeWorkspace(task, path.join(d, "ws"));
    const run = await runAgent({
      prompt: task.prompt, ws, providerCfg, sandbox, maxTurns, maxSeconds, captureNudge: true,
      bab: { origin, identity: COLLEAGUE }, logPath: path.join(d, "transcript.jsonl"),
    });
    const g = await grade(task, ws);
    const ids = [];
    for (const line of fs.readFileSync(path.join(d, "transcript.jsonl"), "utf8").trim().split("\n")) {
      const ev = JSON.parse(line);
      if (ev.ev === "tool" && ev.name === "bab_learn" && !ev.isError) {
        try {
          const l = JSON.parse(ev.out).learning;
          ids.push(l.id);
          // Only learnings from successful seed runs count as relevant (failed seeds are recorded but not target facts).
          learnings.push({ family: task.family, id: l.id, title: ev.args.title, body: ev.args.body, tags: ev.args.tags ?? [], task: id, seedSuccess: g.pass });
        } catch {}
      }
    }
    const c = costUsd(run.usage, price);
    cost += c;
    runs.push({ task: id, family: task.family, success: g.pass, learnCalls: run.babCalls.bab_learn ?? 0, recordedUnprompted: !run.nudged && (run.babCalls.bab_learn ?? 0) > 0,
      nudged: run.nudged, turns: run.turns, costUsd: c, error: run.error, summary: run.summary, learningIds: ids });
    log(`[seed] ${id}: success=${g.pass} learned=${run.babCalls.bab_learn ?? 0} nudged=${run.nudged} $${c.toFixed(4)}`);
  }
  fs.writeFileSync(path.join(outDir, "seed", "seed_runs.json"), JSON.stringify(runs, null, 2));
  fs.writeFileSync(path.join(outDir, "seed", "colleague-learnings.json"), JSON.stringify({ model: providerCfg.model, learnings, summaries: runs.map((r) => ({ family: r.family, task: r.task, success: r.success, summary: r.summary })) }, null, 2));
  return { learnings, runs, cost };
}

/** Returns { snaps: { memoryName: { dir, relevant, hazard } }, seedCost, seedRuns }. */
function loadFrozenSnap(outDir, name) {
  const dir = path.join(outDir, "memory", name);
  const relPath = path.join(outDir, "memory", `${name}.relevant.json`);
  if (!fs.existsSync(dir) || !fs.existsSync(relPath)) return null;
  const { relevant = {}, hazard = {} } = JSON.parse(fs.readFileSync(relPath, "utf8"));
  const toSet = (m) => Object.fromEntries(Object.entries(m).map(([f, ids]) => [f, new Set(ids)]));
  return { dir, relevant: toSet(relevant), hazard: toSet(hazard) };
}

export async function buildMemories({ outDir, suite = "core", memories, memory, providerCfg, price, sandbox, maxTurns, maxSeconds, log }) {
  fs.mkdirSync(path.join(outDir, "memory"), { recursive: true });
  const snaps = {};
  let seedCost = 0;
  let seedRuns = [];
  let colleague = null; // { learnings, summaries }
  const needColleague = memories.some((m) => ["colleague", "autorecord", "conflict"].includes(m));
  // One memory draw per outDir: reuse frozen snapshots on --resume so trials stay comparable.
  if (needColleague) {
    const frozenName = `colleague-${memory}`;
    const frozen = loadFrozenSnap(outDir, frozenName);
    if (frozen) {
      log(`[seed] reusing frozen memory snapshot ${frozenName} (resume determinism)`);
      snaps.colleague = frozen;
      const fixturePath = path.join(outDir, "seed", "colleague-learnings.json");
      if (fs.existsSync(fixturePath)) {
        const d = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
        colleague = { learnings: d.learnings ?? [], summaries: d.summaries ?? [] };
      }
    } else {
    snaps.colleague = await snapshot(outDir, frozenName, async (origin, ctx) => {
      if (memory === "fixture") {
        const d = readFixture(SUITE_FIXTURES[suite].colleague);
        colleague = { learnings: Array.isArray(d) ? d : d.learnings, summaries: d.summaries ?? [] };
        await postAll(origin, ctx, COLLEAGUE, colleague.learnings, "relevant");
        return;
      }
      fs.mkdirSync(path.join(outDir, "seed"), { recursive: true });
      const r = await seedLive({ outDir, origin, providerCfg, price, sandbox, maxTurns, maxSeconds, log });
      seedCost += r.cost;
      seedRuns = r.runs;
      colleague = { learnings: r.learnings, summaries: r.runs.map((x) => ({ family: x.family, task: x.task, success: x.success, summary: x.summary })) };
      for (const l of r.learnings) {
        if (l.seedSuccess) addId(ctx.relevant, l.family, l.id);
        else log(`[seed] ignoring learning from failed seed ${l.task} (${l.id}) as relevant`);
      }
    });
    } // end else (not frozen)
  }
  for (const m of memories) {
    if (m === "colleague") continue;
    const frozen = loadFrozenSnap(outDir, m);
    if (frozen) { log(`[seed] reusing frozen memory snapshot ${m}`); snaps[m] = frozen; continue; }
    if (m === "distractors") snaps[m] = await snapshot(outDir, "distractors", async () => {});
    else if (m === "handwritten") snaps[m] = await snapshot(outDir, "handwritten", (o, ctx) => postAll(o, ctx, HANDWRITTEN_AUTHOR, fixtureFor(suite, "handwritten"), "relevant"));
    else if (m === "stale") snaps[m] = await snapshot(outDir, "stale", (o, ctx) => postAll(o, ctx, FORMER_AUTHOR, fixtureFor(suite, "stale"), "hazard"));
    else if (m === "wrong") snaps[m] = await snapshot(outDir, "wrong", (o, ctx) => postAll(o, ctx, FORMER_AUTHOR, fixtureFor(suite, "wrong"), "hazard"));
    else if (m === "conflict") {
      snaps[m] = await snapshot(outDir, "conflict", async (o, ctx) => {
        await postAll(o, ctx, FORMER_AUTHOR, fixtureFor(suite, "stale"), "hazard");
        await postAll(o, ctx, COLLEAGUE, colleague.learnings, "relevant");
      });
    } else if (m === "autorecord") {
      if (!colleague?.summaries?.length) throw new Error("autorecord memory needs colleague finish summaries (live seeding, or a fixture with summaries)");
      snaps[m] = await snapshot(outDir, "autorecord", (o, ctx) =>
        postAll(o, ctx, COLLEAGUE, colleague.summaries.filter((s) => s.summary).map((s) => ({ family: s.family, title: autoTitle(s.summary), body: s.summary, tags: ["auto-recorded"] })), "relevant"));
    } else throw new Error(`unknown memory ${m}`);
  }
  return { snaps, seedCost, seedRuns };
}
