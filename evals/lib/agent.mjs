// Minimal MCP-capable coding agent loop, identical for every condition.
// Local tools: bash, read_file, write_file, finish. With BAB connected the agent also gets BAB's MCP tools
// (tools/list) and BAB's MCP server instructions, the way MCP clients such as Claude Code surface them.
import fs from "node:fs";
import path from "node:path";
import { McpClient } from "./mcp.mjs";
import { makeProvider, redact } from "./providers.mjs";
import { runBash, workdirFor } from "./sandbox.mjs";

const system = (workdir) => `You are an autonomous coding agent working non-interactively in a git repository at ${workdir} (your bash tool runs there). No human is available to answer questions.
Investigate the problem, make a minimal correct fix in the source code, and verify it by running the project's tests. Do not modify tests or test fixtures.
When the fix is complete and verified, call the \`finish\` tool with a short summary of the root cause and the fix.`;

const LOCAL_TOOLS = [
  ["bash", "Run a bash command in the repository. 120 s timeout. Output is truncated to 10000 chars.",
    { type: "object", properties: { command: { type: "string" } }, required: ["command"] }],
  ["read_file", "Read a text file (path relative to the repository root).",
    { type: "object", properties: { path: { type: "string" } }, required: ["path"] }],
  ["write_file", "Create or overwrite a text file (path relative to the repository root) with the full new content.",
    { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }],
  ["finish", "Call when done. Give a short summary of root cause and fix.",
    { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }],
];

// Verbatim from app/api/hook/route.ts (Stop hook capture nudge); used only when seeding colleague memory.
export const CAPTURE_NUDGE =
  "Big Agentic Brain: this looks like a finished task. If it taught a fact a colleague or their agent could reuse (a gotcha, a house rule, a deploy step, a client's quirk written as the shape without the client's name, a verified answer), post it now with bab_learn without asking, as a learning or practice, one learning per fact, and end with the title and link. If nothing here is reusable beyond this session, reply with exactly: Nothing to record for BAB.";

function resolveInside(ws, p) {
  const rel = String(p).replace(/^\/work\/?/, "").replace(/^\/+/, "");
  const full = path.resolve(ws, rel.startsWith(ws) ? path.relative(ws, rel) : rel);
  if (!full.startsWith(path.resolve(ws) + path.sep)) throw new Error("path outside the repository");
  return full;
}

const SUSPICIOUS = /evals\/tasks|oracle|hidden/;

/**
 * Run one agent session. Returns metrics:
 * { turns, toolCalls, babCalls, usage, finished, summary, stopReason, error, wallS, searches: [{args, text}], reacts: [args], nudged, suspicious }
 */
export async function runAgent({ prompt, ws, providerCfg, bab, sandbox, maxTurns = 40, maxSeconds = 900, logPath, captureNudge = false }) {
  const prov = makeProvider(providerCfg);
  let sys = system(workdirFor(sandbox, ws));
  let mcp = null;
  let babTools = [];
  if (bab) {
    mcp = await new McpClient(bab.origin, bab.identity.email, bab.identity.name).init();
    if (mcp.instructions) sys += `\n\n# MCP server instructions\n## bab (Big Agentic Brain)\n${mcp.instructions}`;
    babTools = await mcp.listTools();
  }
  const tools = [
    ...LOCAL_TOOLS.map(([n, d, s]) => prov.toolSpec(n, d, s)),
    ...babTools.map((t) => prov.toolSpec(t.name, t.description ?? "", t.inputSchema)),
  ];
  const babNames = new Set(babTools.map((t) => t.name));
  const messages = [prov.userMsg(prompt)];
  const m = {
    turns: 0, toolCalls: 0, babCalls: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    finished: false, summary: "", stopReason: "", error: "", searches: [], reacts: [], nudged: false, suspicious: [],
  };
  const t0 = Date.now();
  const log = (ev) => {
    if (logPath) fs.appendFileSync(logPath, redact(JSON.stringify({ t: (Date.now() - t0) / 1000, ...ev })) + "\n");
  };
  log({ ev: "start", system: sys, prompt, tools: [...LOCAL_TOOLS.map((t) => t[0]), ...babNames], model: prov.model, sandbox });
  let nudgePending = captureNudge;
  try {
    for (;;) {
      if (m.turns >= maxTurns) { m.stopReason = "max_turns"; break; }
      if (Date.now() - t0 > maxSeconds * 1000) { m.stopReason = "timeout"; break; }
      const r = await prov.chat(sys, tools, messages);
      m.turns++;
      for (const k of Object.keys(m.usage)) m.usage[k] += r.usage[k] ?? 0;
      log({ ev: "llm", text: r.text, toolCalls: r.toolCalls, usage: r.usage, stop: r.stop });
      messages.push(...r.assistant);
      if (!r.toolCalls.length) {
        if (m.finished) { m.stopReason = "finish"; break; } // reply to the capture nudge
        messages.push(prov.userMsg("Continue. Use the tools; call `finish` when the fix is verified."));
        continue;
      }
      const results = [];
      let doneNow = false;
      for (const c of r.toolCalls) {
        m.toolCalls++;
        const a = c.args ?? {};
        let out = "";
        let isError = false;
        try {
          if (c.name === "bash") {
            if (SUSPICIOUS.test(a.command ?? "")) m.suspicious.push(a.command);
            ({ text: out, isError } = await runBash(sandbox, ws, a.command ?? ""));
          } else if (c.name === "read_file") {
            const s = fs.readFileSync(resolveInside(ws, a.path), "utf8");
            out = s.length > 20_000 ? `${s.slice(0, 20_000)}\n...[truncated]` : s;
          } else if (c.name === "write_file") {
            const p = resolveInside(ws, a.path);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, a.content ?? "");
            out = `wrote ${(a.content ?? "").length} chars to ${a.path}`;
          } else if (c.name === "finish") {
            m.finished = true;
            m.summary = a.summary ?? "";
            out = "ok";
            doneNow = true;
          } else if (babNames.has(c.name)) {
            m.babCalls[c.name] = (m.babCalls[c.name] ?? 0) + 1;
            ({ text: out, isError } = await mcp.call(c.name, a));
            if (c.name === "bab_search") m.searches.push({ args: a, text: out });
            if (c.name === "bab_react") m.reacts.push(a);
            if (out.length > 12_000) out = `${out.slice(0, 12_000)}\n...[truncated]`;
          } else {
            out = `unknown tool ${c.name}`;
            isError = true;
          }
        } catch (e) {
          out = `tool error: ${e.message}`;
          isError = true;
        }
        log({ ev: "tool", name: c.name, args: a, isError, out: out.slice(0, 20_000) });
        results.push({ id: c.id, text: out, isError });
      }
      messages.push(...prov.toolResults(results));
      if (doneNow) {
        if (nudgePending && !m.babCalls.bab_learn) {
          nudgePending = false;
          m.nudged = true;
          prov.appendText(messages, CAPTURE_NUDGE);
          log({ ev: "nudge" });
          continue;
        }
        m.stopReason = "finish";
        break;
      }
    }
  } catch (e) {
    m.error = redact(`${e.name}: ${e.message}`).slice(0, 1000);
    m.stopReason = "error";
  }
  m.wallS = (Date.now() - t0) / 1000;
  log({ ev: "end", ...m, searches: undefined });
  return m;
}
