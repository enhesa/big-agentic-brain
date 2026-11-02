#!/usr/bin/env node
// Command Center contract eval (no LLM, free, deterministic, CI-friendly): replays the MCP calls of a
// typical agent session (fixtures/cc-session.json) against a fresh BAB with Command Center on for a
// test identity, and checks the tool schema, every answer and the stored state after each step.
// Catches drift between the skill, the slim MCP schema and the server.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { assertBuilt } from "./lib/bab-server.mjs";
import { ccAgent, ccPerson, fakeSecret, getRecord, otherDevice, parseJson, setSwitch, startCcBab } from "./lib/cc.mjs";
import { FIXTURES_DIR, scratchRoot } from "./lib/paths.mjs";

const { values: opt } = parseArgs({
  options: {
    fixture: { type: "string", default: path.join(FIXTURES_DIR, "cc-session.json") },
    out: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (opt.help) {
  console.log(`Usage: node evals/cc-contract.mjs [--fixture FILE] [--out DIR]
Replays a recorded Command Center session over MCP against a fresh BAB (run \`pnpm build\` first).
Exits 1 when any check fails.`);
  process.exit(0);
}

/** Reads a dotted path such as "tasks.0.startedAt". */
function at(obj, p) {
  return p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Whether `actual` holds everything in `expected`. Arrays of objects with an id match by id, others by index. */
function subset(actual, expected) {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((e, i) => {
      const a = e && typeof e === "object" && "id" in e ? actual.find((x) => x?.id === e.id) : actual[i];
      return subset(a, e);
    });
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, v]) => subset(actual[k], v));
}

/** One [path, op, value] check against an object. Returns null when it holds, else what was seen. */
function check(obj, [p, op, want]) {
  const got = at(obj, p);
  const ok =
    op === "eq" ? got === want
    : op === "len" ? Array.isArray(got) && got.length === want
    : op === "set" ? got !== undefined && got !== null
    : op === "unset" ? got === undefined || got === null
    : op === "match" ? typeof got === "string" && new RegExp(want).test(got)
    : (() => { throw new Error(`unknown op ${op}`); })();
  return ok ? null : `${p} ${op}${want === undefined ? "" : ` ${JSON.stringify(want)}`}, got ${JSON.stringify(got)}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function main() {
  assertBuilt();
  const fixture = JSON.parse(fs.readFileSync(opt.fixture, "utf8"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.resolve(opt.out ?? path.join(scratchRoot(), "out", `${stamp}-cc-contract`));
  fs.mkdirSync(outDir, { recursive: true });
  const bab = await startCcBab(outDir);
  const results = [];
  const fail = (step, msg) => results.push({ step, ok: false, msg });
  const pass = (step, msg = "") => results.push({ step, ok: true, msg });
  try {
    const person = ccPerson(1);
    const now = new Date(Date.now() - 60_000).toISOString();
    const secret = fakeSecret();
    const agents = { agent: await ccAgent(bab.origin, person, "Eval laptop") };
    const second = otherDevice(person);
    agents.second = await ccAgent(bab.origin, second, "Eval VM");

    // The slim schema agents see: only action, id and record, with every action in the enum.
    const tool = (await agents.agent.listTools()).find((t) => t.name === "bab_command_center");
    const props = Object.keys(tool?.inputSchema?.properties ?? {}).sort();
    const actions = tool?.inputSchema?.properties?.action?.enum ?? [];
    const wantActions = ["publish", "list", "clear_question", "comment", "health", "remove"];
    if (!tool) fail("tool schema", "bab_command_center is not in tools/list");
    else if (props.join(",") !== "action,id,record") fail("tool schema", `properties are ${props.join(",")}, want action,id,record`);
    else if (!wantActions.every((a) => actions.includes(a))) fail("tool schema", `action enum ${actions.join(",")} misses one of ${wantActions.join(",")}`);
    else if (tool.inputSchema.properties.record?.type !== "object") fail("tool schema", "record is not declared as an object");
    else pass("tool schema");

    const fill = async (v) => {
      if (typeof v === "string") {
        const m = /^\{\{seq(-1)?:([a-z0-9-]+)\}\}$/.exec(v);
        if (m) return ((await getRecord(bab.origin, person, m[2]))?.seq ?? 0) - (m[1] ? 1 : 0);
        return v.replaceAll("{{origin}}", bab.origin).replaceAll("{{now}}", now).replaceAll("{{secret}}", secret);
      }
      if (Array.isArray(v)) return Promise.all(v.map(fill));
      if (v && typeof v === "object") return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await fill(x)])));
      return v;
    };

    for (const step of fixture.steps) {
      if (step.switch) {
        try {
          await setSwitch(bab.origin, person, step.switch === "on");
          pass(step.name);
        } catch (e) {
          fail(step.name, e.message);
        }
        continue;
      }
      const errs = [];
      const args = await fill(step.call);
      const { text, isError } = await agents[step.as ?? "agent"].call("bab_command_center", args);
      if (text.includes(secret)) errs.push("the answer echoes the secret");
      const e = step.expect ?? {};
      if (e.error) {
        const re = new RegExp(e.error.replaceAll("{{origin}}", escapeRe(bab.origin)));
        if (!isError) errs.push(`want an error matching /${e.error}/, got success: ${text.slice(0, 200)}`);
        else if (!re.test(text)) errs.push(`error does not match /${e.error}/: ${text.slice(0, 300)}`);
      } else if (isError) {
        errs.push(`unexpected error: ${text.slice(0, 300)}`);
      } else {
        const body = parseJson(text);
        if (e.answer && !subset(body, await fill(e.answer))) errs.push(`answer lacks ${JSON.stringify(e.answer)}: ${text.slice(0, 300)}`);
        for (const c of e.answerChecks ?? []) {
          const why = check(body, await fill(c));
          if (why) errs.push(`answer: ${why}`);
        }
      }
      for (const [id, checks] of Object.entries(e.state ?? {})) {
        const rec = await getRecord(bab.origin, person, id);
        if (!rec) {
          errs.push(`no stored record '${id}'`);
          continue;
        }
        if (JSON.stringify(rec).includes(secret)) errs.push(`stored record '${id}' holds the secret`);
        for (const c of checks) {
          const why = check(rec, await fill(c));
          if (why) errs.push(`${id}: ${why}`);
        }
      }
      if (errs.length) fail(step.name, errs.join("; "));
      else pass(step.name);
    }

    // Not gating: what an MCP agent gets with a 409. The REST answer carries `current`; the MCP text
    // is only the sentence, so an agent must call list (seq only) to merge.
    const probe = await agents.second.call("bab_command_center", {
      action: "publish",
      id: "billing-export",
      record: { v: 1, title: "Billing export probe", expectSeq: 1 },
    });
    results.push({
      step: "note: a 409 over MCP carries the current record",
      ok: true,
      note: true,
      msg: probe.isError && /"current"|"tasks"/.test(probe.text) ? "yes" : "no: the MCP answer is the sentence only, so the agent cannot see what to merge",
    });
  } finally {
    await bab.stop();
    fs.rmSync(path.join(outDir, "bab-data"), { recursive: true, force: true });
  }
  const gating = results.filter((r) => !r.note);
  const failed = gating.filter((r) => !r.ok);
  const md = [
    "# Command Center contract eval (no LLM)",
    "",
    `${gating.length - failed.length} of ${gating.length} checks passed.`,
    "",
    "| Step | Result |",
    "|---|---|",
    ...results.map((r) => `| ${r.step} | ${r.note ? `note: ${r.msg}` : r.ok ? "pass" : `FAIL: ${r.msg.replaceAll("|", "\\|")}`} |`),
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "cc-contract.md"), md);
  fs.writeFileSync(path.join(outDir, "cc-contract.json"), JSON.stringify({ results }, null, 2));
  console.log(md);
  console.log(`wrote ${path.join(outDir, "cc-contract.md")}`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
