// The Command Center LLM suites: `pnpm eval --suite cc` (behaviour: the skill text is loaded) and
// `pnpm eval --suite cc-trigger` (only the skill's frontmatter description is shown; the agent must
// decide to load it). Each run gets a fresh BAB, a person with no Command Center yet (the first
// publish creates it), and an agent bound to a device, then plays one scenario from cc-scenarios.mjs.
// `--dry-run` swaps the LLM for each scenario's ideal script (no key, no cost) to prove the graders.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertBuilt } from "./bab-server.mjs";
import { ccAgent, ccPerson, fakeSecret, otherDevice, skillText, splitSkill, startCcBab } from "./cc.mjs";
import { badScripts, goodScripts, readState, SCENARIOS, snapshot, stepKind, triggerChecks, workResult } from "./cc-scenarios.mjs";
import { REPO_ROOT, scratchRoot } from "./paths.mjs";
import { priceFor, PRICES_CHECKED } from "./prices.mjs";
import { costUsd, makeProvider, redact } from "./providers.mjs";
import { wilson } from "./stats.mjs";

const MAX_CALLS_PER_TURN = 12;

export const CC_SYSTEM = `You are a coding agent in an interactive session with a person. You cannot edit files here: carry out each step of the task with the \`work\` tool, which does the step and returns the result. When you need a decision from the person, ask it in your reply and end your turn. End every turn with a short reply to the person.`;

const WORK_TOOL = ["work", "Carry out one step of the task (for example 'write the exporter'). Returns what happened.",
  { type: "object", properties: { step: { type: "string" } }, required: ["step"] }];
const SKILL_TOOL = (desc) => ["skill", `Load an installed skill by name before you act on it. Installed skills:\n- command-center: ${desc}`,
  { type: "object", properties: { name: { type: "string" } }, required: ["name"] }];

/** A provider that replays a scenario's ideal script: one step per chat call, a text step ends the turn. */
class Scripted {
  constructor(script, vars) {
    this.model = "scripted";
    this.script = script;
    this.vars = vars;
    this.turn = 0;
    this.step = 0;
    this.n = 0;
  }
  toolSpec(name, description, schema) {
    return { name, description, schema };
  }
  userMsg(text) {
    return { role: "user", text };
  }
  toolResults(results) {
    this.last = results.at(-1);
    return [];
  }
  nextTurn(turn) {
    this.turn = turn;
    this.step = 0;
  }
  async chat() {
    const steps = this.script[this.turn] ?? [];
    let s = steps[this.step++] ?? { text: "Done." };
    if (typeof s === "function") s = s({ last: this.last ?? { text: "", isError: false } });
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    if (s.text !== undefined) return { text: fillVars(s.text, this.vars), toolCalls: [], usage, stop: "end_turn", assistant: [] };
    return { text: "", toolCalls: [{ id: `s${++this.n}`, name: s.tool, args: fillVars(s.args, this.vars) }], usage, stop: "tool_use", assistant: [] };
  }
}

function fillVars(v, vars) {
  if (typeof v === "string") return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (Array.isArray(v)) return v.map((x) => fillVars(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillVars(x, vars)]));
  return v;
}

/** Plays one scenario once. Returns { checks, usage, events, error }. */
export async function runScenario({ scenario, suite, providerCfg, dir, dryRun, script }) {
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "transcript.jsonl");
  const t0 = Date.now();
  const secret = fakeSecret();
  const log = (ev) => fs.appendFileSync(logPath, redact(JSON.stringify({ t: (Date.now() - t0) / 1000, ...ev }).split(secret).join("[TEST-SECRET]")) + "\n");
  // A loaded runner can be slow to boot Next: the same 3 tries as run.mjs.
  let bab;
  for (let attempt = 1; ; attempt++) {
    try {
      bab = await startCcBab(dir);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  const events = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let error = "";
  let checks = [];
  try {
    const person = ccPerson(1);
    const x = { origin: bab.origin, person, secret, now: new Date(Date.now() - 60_000).toISOString() };
    const vars = { origin: x.origin, secret, now: x.now };
    const mcp = await ccAgent(bab.origin, person, "Eval laptop");
    x.other = await ccAgent(bab.origin, otherDevice(person), "Eval VM");
    if (scenario.setup) await scenario.setup(x);
    // In the trigger suite the ideal agent loads the skill first, unless asked to leave it alone.
    const ideal = script ?? (suite === "cc-trigger" && scenario.context !== "off"
      ? [[{ tool: "skill", args: { name: "command-center" } }, ...scenario.ideal[0]], ...scenario.ideal.slice(1)]
      : scenario.ideal);
    const prov = dryRun ? new Scripted(ideal, vars) : makeProvider(providerCfg);
    const skill = splitSkill(await skillText(bab.origin));
    // The harness clock, so the agent can fill health.checkedAt (a real session knows the date).
    let sys = `${CC_SYSTEM}\n\nCurrent time (UTC): ${x.now}.`;
    if (mcp.instructions) sys += `\n\n# MCP server instructions\n## bab (Big Agentic Brain)\n${mcp.instructions}`;
    if (suite === "cc") sys += `\n\n# Skill: command-center (loaded)\n${skill.body}`;
    const babTools = await mcp.listTools();
    const local = [WORK_TOOL, ...(suite === "cc-trigger" ? [SKILL_TOOL(skill.meta.description ?? "")] : [])];
    const tools = [...local.map(([n, d, s]) => prov.toolSpec(n, d, s)), ...babTools.map((t) => prov.toolSpec(t.name, t.description ?? "", t.inputSchema))];
    const babNames = new Set(babTools.map((t) => t.name));
    log({ ev: "start", scenario: scenario.id, suite, system: sys, tools: [...local.map((t) => t[0]), ...babNames], model: prov.model });
    const messages = [];
    const byTurn = [];
    let firstPublishSeen = false;
    for (let turn = 0; turn < scenario.turns.length; turn++) {
      const spec = scenario.turns[turn];
      if (spec.before) await spec.before(x);
      if (prov.nextTurn) prov.nextTurn(turn);
      const user = fillVars(spec.user, vars);
      // After a capped turn the last message is tool results; add the text to it instead of a second user message.
      if (messages.at(-1)?.role === "user" && prov.appendText) prov.appendText(messages, user);
      else messages.push(prov.userMsg(user));
      log({ ev: "user", turn, text: user });
      for (let calls = 0; ; calls++) {
        if (calls >= MAX_CALLS_PER_TURN) {
          events.push({ turn, type: "text", text: "" });
          log({ ev: "cap", turn });
          break;
        }
        const r = await prov.chat(sys, tools, messages, { timeoutMs: 300_000 });
        for (const k of Object.keys(usage)) usage[k] += r.usage[k] ?? 0;
        log({ ev: "llm", turn, text: r.text, toolCalls: r.toolCalls, usage: r.usage, stop: r.stop });
        messages.push(...r.assistant);
        if (!r.toolCalls.length) {
          events.push({ turn, type: "text", text: r.text ?? "" });
          break;
        }
        if (r.text) events.push({ turn, type: "text", text: r.text });
        const results = [];
        for (const call of r.toolCalls) {
          const a = call.args ?? {};
          let out = "";
          let isError = false;
          let kind;
          if (call.name === "work") {
            kind = stepKind(a.step);
            out = workResult(scenario, a);
          }
          else if (call.name === "skill") {
            out = /command-center/.test(a.name ?? "") ? skill.body : `No skill named ${a.name}.`;
            isError = !/command-center/.test(a.name ?? "");
          } else if (babNames.has(call.name)) {
            if (call.name === "bab_command_center" && a.action === "publish" && !firstPublishSeen) {
              firstPublishSeen = true;
              if (scenario.beforeFirstPublish) await scenario.beforeFirstPublish(x);
            }
            ({ text: out, isError } = await mcp.call(call.name, a));
            if (out.length > 12_000) out = `${out.slice(0, 12_000)}\n...[truncated]`;
          } else {
            out = `unknown tool ${call.name}`;
            isError = true;
          }
          events.push({ turn, type: "tool", name: call.name, args: a, isError, out, kind });
          log({ ev: "tool", turn, name: call.name, args: a, isError, out: out.slice(0, 20_000), ...(kind ? { kind } : {}) });
          results.push({ id: call.id, text: out, isError });
        }
        messages.push(...prov.toolResults(results));
      }
      byTurn.push(await snapshot(x));
    }
    const state = await readState(x, byTurn);
    checks = [...scenario.grade(events, state, x), ...(suite === "cc-trigger" ? triggerChecks(scenario, events) : [])];
  } catch (e) {
    error = redact(`${e.name}: ${e.message}`).slice(0, 1000);
  } finally {
    await bab.stop();
    fs.rmSync(path.join(dir, "bab-data"), { recursive: true, force: true });
  }
  log({ ev: "end", checks, usage, error });
  return { checks, usage, events, error };
}

/** `pnpm eval --suite cc|cc-trigger [--dry-run] [--tasks ids] [--trials N] [--budget-usd X] [--out DIR]`. */
export async function runCcSuite(opt) {
  const suite = opt.suite;
  const dryRun = Boolean(opt["dry-run"]);
  assertBuilt();
  const scenarios = SCENARIOS.filter((s) => s.suites.includes(suite) && (!opt.tasks || opt.tasks.split(",").includes(s.id)));
  if (!scenarios.length) throw new Error(`no ${suite} scenario matches --tasks ${opt.tasks}`);
  const provider = process.env.BAB_EVAL_PROVIDER ?? "anthropic";
  const model = dryRun ? "scripted" : process.env.BAB_EVAL_MODEL ?? "claude-haiku-5-5";
  const providerCfg = { provider, model, baseUrl: process.env.BAB_EVAL_BASE_URL, keyEnv: process.env.BAB_EVAL_API_KEY_ENV };
  let price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!dryRun) {
    const keyEnv = providerCfg.keyEnv ?? (provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
    if (!process.env[keyEnv]) throw new Error(`Set ${keyEnv} (the key is read from the environment and never written to disk), or pass --dry-run.`);
    price = priceFor(model);
    if (!price) throw new Error(`No price known for ${model}; set BAB_EVAL_PRICE="in,out,cacheRead,cacheWrite" (USD per 1M).`);
  }
  const trials = Number(opt.trials ?? (dryRun ? 1 : 2));
  const budget = Number(opt["budget-usd"] ?? 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.resolve(opt.out ?? path.join(scratchRoot(), "out", `${stamp}-${suite}${dryRun ? "-dry" : ""}`));
  fs.mkdirSync(path.join(outDir, "runs"), { recursive: true });
  let babCommit = "unknown";
  try {
    babCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {}
  const meta = { suite, dryRun, provider: dryRun ? "scripted" : provider, model, price, pricesChecked: PRICES_CHECKED, scenarios: scenarios.map((s) => s.id), trials, budget, babCommit, date: new Date().toISOString(), node: process.version };
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  console.log(`[eval] ${suite}${dryRun ? " (dry run, ideal scripts)" : ""}: ${model} | scenarios=${scenarios.length} trials=${trials} budget=$${budget} -> ${outDir}`);
  // A rough reserve per run so a run never starts once the cap is near: about 6 calls a turn of 12k tokens.
  const reserve = dryRun ? 0 : Math.max(0.02, (3 * 6 * (12_000 * price.input + 500 * price.output)) / 1e6);
  let spent = 0;
  let skipped = 0;
  const rows = [];
  for (let trial = 1; trial <= trials; trial++) {
    for (const scenario of scenarios) {
      if (spent + reserve > budget) {
        skipped++;
        continue;
      }
      const id = `${scenario.id}-t${trial}`;
      const r = await runScenario({ scenario, suite, providerCfg, dir: path.join(outDir, "runs", id), dryRun });
      const cost = costUsd(r.usage, price);
      spent += cost;
      const scored = r.checks.filter((c) => !c.pending);
      const pass = !r.error && scored.length > 0 && scored.every((c) => c.ok);
      rows.push({ id, scenario: scenario.id, trial, pass, error: r.error, cost, checks: r.checks });
      fs.writeFileSync(path.join(outDir, "runs", id, "grade.json"), JSON.stringify({ pass, error: r.error, cost, checks: r.checks }, null, 2));
      const failed = r.checks.filter((c) => !c.ok && !c.pending).map((c) => c.name);
      console.log(`[eval] ${id}: ${pass ? "pass" : "FAIL"}${r.error ? ` error=${r.error}` : ""}${failed.length ? ` (${failed.join("; ")})` : ""} $${cost.toFixed(4)} (spent $${spent.toFixed(3)})`);
    }
  }
  // Dry run only: other careful scripts must pass and bad scripts must fail, so the graders are
  // neither tied to the ideal script's order nor vacuous.
  const selfTest = [];
  const altGood = [];
  if (dryRun) {
    for (const scenario of scenarios) {
      for (const [name, good] of goodScripts(scenario)) {
        const id = `${scenario.id}-good-${name}`;
        const r = await runScenario({ scenario, suite, providerCfg, dir: path.join(outDir, "runs", id), dryRun, script: suite === "cc-trigger" ? [[{ tool: "skill", args: { name: "command-center" } }, ...good[0]], ...good.slice(1)] : good });
        const failed = r.checks.filter((c) => !c.ok && !c.pending).map((c) => c.name);
        const pass = !r.error && r.checks.some((c) => !c.pending) && failed.length === 0;
        altGood.push({ scenario: scenario.id, name, pass, failed, error: r.error });
        console.log(`[eval] ${id}: ${pass ? "pass" : "FAIL"}${r.error ? ` error=${r.error}` : ""}${failed.length ? ` (${failed.join("; ")})` : ""}`);
      }
      for (const [name, bad] of badScripts(scenario)) {
        const id = `${scenario.id}-bad-${name}`;
        const r = await runScenario({ scenario, suite, providerCfg, dir: path.join(outDir, "runs", id), dryRun, script: bad });
        const failed = r.checks.filter((c) => !c.ok && !c.pending).map((c) => c.name);
        const caught = Boolean(r.error) || failed.length > 0;
        selfTest.push({ scenario: scenario.id, name, caught, failed, error: r.error });
        console.log(`[eval] ${id}: ${caught ? "caught" : "NOT CAUGHT"}${failed.length ? ` (${failed.join("; ")})` : ""}`);
      }
    }
  }
  let md = ccSummary(rows, { ...meta, spent, skipped });
  if (altGood.length) {
    md += ["", "## Grader self-test (each other careful script must pass)", "", "| Scenario | Careful script | Result |", "|---|---|---|",
      ...altGood.map((t) => `| ${t.scenario} | ${t.name} | ${t.pass ? "pass" : `FAIL: ${t.failed.join("; ") || t.error}`} |`)].join("\n") + "\n";
  }
  if (selfTest.length) {
    md += ["", "## Grader self-test (each bad script must fail a check)", "", "| Scenario | Bad script | Caught by |", "|---|---|---|",
      ...selfTest.map((t) => `| ${t.scenario} | ${t.name} | ${t.caught ? t.failed.join("; ") || t.error : "NOT CAUGHT"} |`)].join("\n") + "\n";
  }
  fs.writeFileSync(path.join(outDir, "summary.md"), md);
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ meta: { ...meta, spent, skipped }, rows }, null, 2));
  console.log(`\n${md}`);
  console.log(`[eval] wrote ${path.join(outDir, "summary.md")} and results.json`);
  const errored = rows.filter((r) => r.error).length;
  if (errored) process.exit(2);
  // A dry run proves the graders: every ideal and other careful script must pass, every bad one fail.
  if (dryRun && (rows.some((r) => !r.pass) || altGood.some((t) => !t.pass) || selfTest.some((t) => !t.caught))) process.exit(1);
}

export function ccSummary(rows, meta) {
  const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : "n/a");
  const lines = [
    `# Command Center ${meta.suite === "cc-trigger" ? "trigger" : "behaviour"} eval${meta.dryRun ? " (dry run: ideal scripts, no LLM)" : ""}`,
    "",
    `Model: ${meta.model}. Trials per scenario: ${meta.trials}. Spend: $${meta.spent.toFixed(3)} of $${meta.budget}.${meta.skipped ? ` ${meta.skipped} runs skipped: budget reached.` : ""} BAB ${meta.babCommit}.`,
    "",
    "| Scenario | Runs | Pass rate (95% CI) | Errors |",
    "|---|---|---|---|",
  ];
  const ids = [...new Set(rows.map((r) => r.scenario))];
  for (const s of ids) {
    const rs = rows.filter((r) => r.scenario === s);
    const k = rs.filter((r) => r.pass).length;
    const [, lo, hi] = wilson(k, rs.length);
    lines.push(`| ${s} | ${rs.length} | ${pct(k, rs.length)} (${Math.round(lo * 100)}-${Math.round(hi * 100)}%) | ${rs.filter((r) => r.error).length} |`);
  }
  const all = rows.filter((r) => r.pass).length;
  lines.push(`| **all** | ${rows.length} | ${pct(all, rows.length)} | ${rows.filter((r) => r.error).length} |`, "", "## Checks", "", "| Scenario | Check | Pass rate |", "|---|---|---|");
  for (const s of ids) {
    const rs = rows.filter((r) => r.scenario === s);
    const names = [...new Set(rs.flatMap((r) => r.checks.map((c) => c.name)))];
    for (const n of names) {
      const cs = rs.map((r) => r.checks.find((c) => c.name === n)).filter(Boolean);
      const pending = cs.some((c) => c.pending) ? " (not scored)" : "";
      lines.push(`| ${s} | ${n}${pending} | ${pct(cs.filter((c) => c.ok).length, cs.length)} |`);
    }
  }
  const errs = rows.filter((r) => r.error);
  if (errs.length) lines.push("", "## Errors", "", ...errs.map((r) => `- ${r.id}: ${r.error}`));
  return lines.join("\n") + "\n";
}
