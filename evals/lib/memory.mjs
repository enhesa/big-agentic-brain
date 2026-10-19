// Builds the BAB data-dir snapshots each condition starts from.
//   C  distractors only (BAB's demo memories + engineering near-misses): BAB connected, nothing relevant
//   B  distractors + colleague memory: fixture (recorded by a real agent, see fixtures/) or live (a colleague agent
//      solves the original tasks now and records what it learned, nudged once with BAB's own Stop-hook text)
//   H  distractors + hand-written notes (labelled separately; not agent-recorded)
import fs from "node:fs";
import path from "node:path";
import { runAgent } from "./agent.mjs";
import { postLearning, startBab } from "./bab-server.mjs";
import { allTaskIds, grade, loadTask, makeWorkspace } from "./grading.mjs";
import { FIXTURES_DIR } from "./paths.mjs";
import { costUsd } from "./providers.mjs";

const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
const DISTRACTOR_AUTHOR = { email: "demo.colleague@example.com", name: "Demo Colleague" };
export const COLLEAGUE = { email: "colleague.agent@example.com", name: "Colleague Agent" };
const HANDWRITTEN_AUTHOR = { email: "senior.dev@example.com", name: "Senior Dev (hand-written)" };

async function seedDistractors(origin) {
  for (const l of readFixture("distractors.json").learnings) await postLearning(origin, DISTRACTOR_AUTHOR, { title: l.title, body: l.body, tags: l.tags });
}

async function snapshot(outDir, name, fill) {
  const dir = path.join(outDir, "memory", name);
  const tmp = `${dir}.tmp`;
  const bab = await startBab({ dataDir: tmp, logFile: path.join(outDir, "memory", `${name}.bab.log`) });
  let relevant;
  try {
    await seedDistractors(bab.origin);
    relevant = await fill(bab.origin);
  } finally {
    await bab.stop();
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  const plain = Object.fromEntries(Object.entries(relevant ?? {}).map(([f, s]) => [f, [...s]]));
  fs.writeFileSync(path.join(outDir, "memory", `${name}.relevant.json`), JSON.stringify(plain, null, 2));
  return { dir, relevant: relevant ?? {} };
}

function addId(map, family, id) {
  (map[family] ??= new Set()).add(id);
}

/** Returns { C?, B?, H? } -> { dir, relevant: { family: Set(ids) } } plus seed cost. */
export async function buildMemories({ outDir, conditions, memory, providerCfg, price, sandbox, maxTurns, maxSeconds, log }) {
  fs.mkdirSync(path.join(outDir, "memory"), { recursive: true });
  const snaps = {};
  let seedCost = 0;
  const seedRuns = [];
  if (conditions.includes("C")) snaps.C = await snapshot(outDir, "C-distractors", async () => ({}));
  if (conditions.includes("H")) {
    snaps.H = await snapshot(outDir, "H-handwritten", async (origin) => {
      const rel = {};
      for (const n of readFixture("handwritten.json")) addId(rel, n.family, (await postLearning(origin, HANDWRITTEN_AUTHOR, { title: n.title, body: n.body, tags: n.tags })).id);
      return rel;
    });
  }
  if (conditions.includes("B")) {
    snaps.B = await snapshot(outDir, `B-colleague-${memory}`, async (origin) => {
      const rel = {};
      if (memory === "fixture") {
        for (const l of readFixture("colleague-learnings.json").learnings) addId(rel, l.family, (await postLearning(origin, COLLEAGUE, { title: l.title, body: l.body, tags: l.tags })).id);
        return rel;
      }
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
        for (const line of fs.readFileSync(path.join(d, "transcript.jsonl"), "utf8").trim().split("\n")) {
          const ev = JSON.parse(line);
          if (ev.ev === "tool" && ev.name === "bab_learn" && !ev.isError) {
            try {
              addId(rel, task.family, JSON.parse(ev.out).learning.id);
            } catch {}
          }
        }
        const cost = costUsd(run.usage, price);
        seedCost += cost;
        seedRuns.push({ task: id, success: g.pass, learnCalls: run.babCalls.bab_learn ?? 0, nudged: run.nudged, turns: run.turns, costUsd: cost, error: run.error });
        log(`[seed] ${id}: success=${g.pass} learned=${run.babCalls.bab_learn ?? 0} nudged=${run.nudged} $${cost.toFixed(4)}`);
      }
      return rel;
    });
  }
  if (seedRuns.length) fs.writeFileSync(path.join(outDir, "seed", "seed_runs.json"), JSON.stringify(seedRuns, null, 2));
  return { snaps, seedCost, seedRuns };
}
