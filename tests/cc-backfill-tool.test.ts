import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  run,
  readTranscripts,
  splitBlocks,
  collectBlocks,
  sizeOf,
  validateMap,
  matchRule,
  buildDraft,
  buildPrompt,
  postProcess,
  flagLine,
  reduceMachine,
  uploadEntries,
  batchEntries,
  maskUrl,
  checkUploadUrl,
  parseBound,
  USAGE,
} from "../scripts/cc-backfill.mjs";

/** scripts/cc-backfill.mjs: drafts worked lines from transcripts in a temp dir, uploads to a fake fetch. Never the network. */

const SCRIPT = path.join(process.cwd(), "scripts", "cc-backfill.mjs");
const NOW = Date.parse("2026-06-15T12:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let dir: string;
let projects: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bab-cc-backfill-"));
  projects = path.join(dir, "projects");
  mkdirSync(projects);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type LineOpts = {
  type?: "user" | "assistant";
  session?: string;
  at: number;
  content?: unknown;
  cwd?: string;
  branch?: string;
  sidechain?: boolean;
  toolUseResult?: unknown;
};

function line(o: LineOpts): string {
  return JSON.stringify({
    type: o.type ?? "user",
    sessionId: o.session ?? "s1",
    timestamp: new Date(o.at).toISOString(),
    cwd: o.cwd ?? "/home/user/work/acme-api",
    gitBranch: o.branch ?? "main",
    isSidechain: o.sidechain ?? false,
    ...(o.toolUseResult !== undefined ? { toolUseResult: o.toolUseResult } : {}),
    message: { role: o.type ?? "user", content: o.content ?? "hello" },
  });
}

function writeTranscript(lines: string[], project = "proj-a", file = "t1.jsonl") {
  const d = path.join(projects, project);
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, file), lines.join("\n") + "\n");
}

/** A user turn then an assistant turn, `minutes` apart, starting at `start`. */
function pair(start: number, minutes = 5, extra: Partial<LineOpts> = {}, userText = "please fix the build", reply = "fixed the build") {
  return [
    line({ ...extra, type: "user", at: start, content: userText }),
    line({ ...extra, type: "assistant", at: start + minutes * MIN, content: [{ type: "text", text: reply }] }),
  ];
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s), now: () => NOW, hostname: () => "acme-box" } };
}

function allFilesText(root: string): string {
  let s = "";
  for (const f of readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, f.name);
    if (f.isDirectory()) {
      if (p === projects) continue;
      s += allFilesText(p);
    } else s += readFileSync(p, "utf8");
  }
  return s;
}

type Entry = Record<string, unknown>;

describe("parsing", () => {
  it("skips bad lines, sidechains, tool results, command wrappers and non-text blocks", () => {
    const t0 = NOW - 10 * HOUR;
    writeTranscript([
      "not json {",
      line({ type: "user", at: t0, content: "real ask" }),
      line({ type: "user", at: t0 + MIN, content: "<command-name>/clear</command-name>" }),
      line({ type: "user", at: t0 + 2 * MIN, content: [{ type: "tool_result", content: "tool output text" }] }),
      line({ type: "user", at: t0 + 3 * MIN, content: [{ type: "text", text: "result as text" }], toolUseResult: { ok: true } }),
      line({ type: "assistant", at: t0 + 4 * MIN, content: [{ type: "thinking", thinking: "hidden thought" }, { type: "tool_use", name: "x", input: { a: "tool input" } }] }),
      line({ type: "assistant", at: t0 + 5 * MIN, content: [{ type: "text", text: "real answer" }] }),
      line({ type: "assistant", at: t0 + 6 * MIN, content: [{ type: "text", text: "side work" }], sidechain: true }),
      JSON.stringify({ type: "summary", summary: "x", sessionId: "s1", timestamp: new Date(t0).toISOString() }),
      JSON.stringify({ type: "user", sessionId: "s1", message: { content: "no timestamp" } }),
    ]);
    const { sessions, files } = readTranscripts(projects);
    expect(files).toBe(1);
    const blocks = splitBlocks(sessions.get("s1"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].turns).toBe(2);
    expect(blocks[0].text).toContain("real ask");
    expect(blocks[0].text).toContain("real answer");
    for (const hidden of ["tool output text", "result as text", "hidden thought", "tool input", "side work", "command-name", "no timestamp"]) {
      expect(blocks[0].text).not.toContain(hidden);
    }
  });

  it("reads only <dir>/*/*.jsonl, one level", () => {
    const t0 = NOW - 10 * HOUR;
    writeTranscript(pair(t0, 5, { session: "top" }), "proj-a", "a.jsonl");
    writeFileSync(path.join(projects, "loose.jsonl"), pair(t0, 5, { session: "loose" }).join("\n"));
    mkdirSync(path.join(projects, "proj-a", "deep"));
    writeFileSync(path.join(projects, "proj-a", "deep", "d.jsonl"), pair(t0, 5, { session: "deep" }).join("\n"));
    writeFileSync(path.join(projects, "proj-a", "notes.txt"), pair(t0, 5, { session: "txt" }).join("\n"));
    const { sessions } = readTranscripts(projects);
    expect([...sessions.keys()]).toEqual(["top"]);
  });
});

describe("blocks", () => {
  it("splits at a gap over 30 minutes, keeps a gap of exactly 30, and drops a block without both roles", () => {
    const t0 = NOW - 20 * HOUR;
    writeTranscript([
      ...pair(t0, 10),
      ...pair(t0 + 40 * MIN, 5), // starts 30 min after the last turn: same block
      ...pair(t0 + 76 * MIN, 5), // 31 min gap: new block
      line({ type: "user", at: t0 + 5 * HOUR, content: "a lone ask" }), // no assistant: dropped
    ]);
    const { sessions } = readTranscripts(projects);
    const blocks = splitBlocks(sessions.get("s1"));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ startMs: t0, endMs: t0 + 45 * MIN, minutes: 45, turns: 4, id: `s1:${t0}` });
    expect(blocks[1]).toMatchObject({ startMs: t0 + 76 * MIN, turns: 2 });
  });

  it("leaves blocks that ended inside the settle window to live logging", () => {
    writeTranscript([...pair(NOW - 5 * HOUR, 5, { session: "old" }), ...pair(NOW - 90 * MIN, 5, { session: "fresh" })]);
    const { sessions } = readTranscripts(projects);
    expect(collectBlocks(sessions, { now: NOW }).map((b: { session: string }) => b.session)).toEqual(["old"]);
    expect(collectBlocks(sessions, { now: NOW, settleHours: 1 }).map((b: { session: string }) => b.session)).toEqual(["old", "fresh"]);
  });

  it("keeps ids stable when later turns arrive", () => {
    const t0 = NOW - 30 * HOUR;
    writeTranscript(pair(t0, 5));
    const first = collectBlocks(readTranscripts(projects).sessions, { now: NOW }).map((b: { id: string }) => b.id);
    writeTranscript([...pair(t0, 5), ...pair(t0 + 10 * MIN, 5), ...pair(t0 + 5 * HOUR, 5)]);
    const second = collectBlocks(readTranscripts(projects).sessions, { now: NOW }).map((b: { id: string }) => b.id);
    expect(first).toEqual([`s1:${t0}`]);
    expect(second).toEqual([`s1:${t0}`, `s1:${t0 + 5 * HOUR}`]);
    expect(second[0]).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  });

  it("filters by --since and --until", () => {
    const day1 = Date.parse("2026-06-01T10:00:00Z");
    const day2 = Date.parse("2026-06-02T10:00:00Z");
    const day3 = Date.parse("2026-06-03T10:00:00Z");
    writeTranscript([...pair(day1, 5, { session: "a" }), ...pair(day2, 5, { session: "b" }), ...pair(day3, 5, { session: "c" })]);
    const { sessions } = readTranscripts(projects);
    const got = collectBlocks(sessions, { now: NOW, since: parseBound("2026-06-02", "--since"), until: parseBound("2026-06-02", "--until", true) });
    expect(got.map((b: { session: string }) => b.session)).toEqual(["b"]);
    expect(() => parseBound("yesterday", "--since")).toThrow(/--since/);
  });

  it("buckets size by active minutes", () => {
    expect(sizeOf(0)).toBe("small");
    expect(sizeOf(29)).toBe("small");
    expect(sizeOf(30)).toBe("medium");
    expect(sizeOf(119)).toBe("medium");
    expect(sizeOf(120)).toBe("large");
  });
});

describe("mapping", () => {
  const block = (o: Partial<{ cwd: string; repo: string; branch: string; text: string }>) => ({
    cwd: "/home/user/work/acme-api",
    repo: "acme-api",
    branch: "main",
    text: "",
    ...o,
  });

  it("matches by cwd substring or glob, repo, branch regex and keys; first match wins; all given fields must match", () => {
    const rules = validateMap({
      rules: [
        { initiative: "both", repo: "acme-api", branch: "^release/" },
        { initiative: "by-key", keys: ["KEY-7"] },
        { initiative: "by-glob", cwd: "/home/user/work/*-web" },
        { initiative: "by-cwd", cwd: "work/acme-api", title: "Acme API", key: "KEY-1" },
        { initiative: "by-branch", branch: "^feature/" },
      ],
    });
    expect(matchRule(block({ branch: "release/1.0" }), rules)).toMatchObject({ rule: { initiative: "both" }, mappedBy: "rule 1 (repo, branch)" });
    expect(matchRule(block({ branch: "feature/KEY-7-x", cwd: "/x/other", repo: "other" }), rules)?.rule.initiative).toBe("by-key");
    expect(matchRule(block({ cwd: "/x/other", repo: "other", text: "User: look at KEY-7 please" }), rules)?.rule.initiative).toBe("by-key");
    expect(matchRule(block({ cwd: "/home/user/work/acme-web", repo: "acme-web" }), rules)?.rule.initiative).toBe("by-glob");
    expect(matchRule(block({ cwd: "C:\\Users\\user\\work\\acme-api" }), rules)?.rule).toMatchObject({ initiative: "by-cwd", title: "Acme API", key: "KEY-1" });
    expect(matchRule(block({ cwd: "/x/other", repo: "other", branch: "feature/y" }), rules)?.rule.initiative).toBe("by-branch");
    expect(matchRule(block({ cwd: "/x/other", repo: "other", branch: "main" }), rules)).toBeNull();
  });

  it("refuses a rule with no match field, a bad slug, a bad key and an unknown field", () => {
    expect(() => validateMap({ rules: [{ initiative: "x" }] })).toThrow(/at least one of/);
    expect(() => validateMap({ rules: [{ initiative: "Bad Slug", repo: "r" }] })).toThrow(/slug/);
    expect(() => validateMap({ rules: [{ initiative: "x", repo: "r", key: "nope" }] })).toThrow(/KEY-1/);
    expect(() => validateMap({ rules: [{ initiative: "x", repo: "r", extra: 1 }] })).toThrow(/unknown field extra/);
    expect(() => validateMap({ rules: [{ initiative: "x", branch: "(" }] })).toThrow(/regular expression/);
    expect(() => validateMap([])).toThrow(/rules/);
  });

  it("puts unmapped blocks under unassigned and lists their repos, branches and keys in the template, with no text", async () => {
    const t0 = NOW - 10 * HOUR;
    const sentinel = `sentinel-${randomUUID()}`;
    writeTranscript([
      ...pair(t0, 5, { session: "m", cwd: "/home/user/work/acme-api" }),
      ...pair(t0, 5, { session: "u", cwd: "/home/user/work/acme-web", branch: "feature/KEY-2-login" }, `${sentinel} and ACME-3`),
    ]);
    const map = path.join(dir, "map.json");
    writeFileSync(map, JSON.stringify({ rules: [{ initiative: "api-work", repo: "acme-api" }] }));
    const out = path.join(dir, "out", "draft.json");
    const c = capture();
    const code = await run(["draft", "--projects-dir", projects, "--out", out, "--map", map, "--no-llm"], c.deps);
    expect(code).toBe(0);
    const draft = JSON.parse(readFileSync(out, "utf8"));
    const byId = new Map<string, Entry>(draft.entries.map((e: Entry) => [String(e.session), e]));
    expect(byId.get("m")).toMatchObject({ initiative: "api-work", mappedBy: "rule 1 (repo)" });
    expect(byId.get("u")).toMatchObject({ initiative: "unassigned", mappedBy: "none" });
    const tplText = readFileSync(path.join(dir, "out", "draft.map-template.json"), "utf8");
    const tpl = JSON.parse(tplText);
    expect(tpl).toMatchObject({ repos: ["acme-web"], branches: ["feature/KEY-2-login"], keys: ["ACME-3", "KEY-2"], rules: [] });
    expect(tplText).not.toContain(sentinel);
  });
});

describe("drafting", () => {
  it("calls the provider with a capped excerpt plus repo and branch, and keeps one line of at most 200 chars", async () => {
    const t0 = NOW - 10 * HOUR;
    writeTranscript(pair(t0, 5, { branch: "feature/x" }, "fix the login page " + "y".repeat(6000), "done"));
    const prompts: string[] = [];
    const provider = async (p: string) => {
      prompts.push(p);
      return `\n  ${"Fixed the login page\u0007 ".repeat(20)}\nsecond line`;
    };
    const out = path.join(dir, "d.json");
    const code = await run(["draft", "--projects-dir", projects, "--out", out, "--machine", "acme-box"], { ...capture().deps, provider });
    expect(code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Repo: acme-api");
    expect(prompts[0]).toContain("Branch: feature/x");
    expect(prompts[0]).toContain("User: fix the login page");
    expect(prompts[0].length).toBeLessThan(4000 + 600);
    const [e] = JSON.parse(readFileSync(out, "utf8")).entries;
    expect(e.worked.length).toBeLessThanOrEqual(200);
    expect(e.worked).not.toMatch(/[\n\u0007]/);
    expect(e.worked.startsWith("Fixed the login page")).toBe(true);
    expect(e).toMatchObject({ include: true, size: "small", machine: "acme-box", session: "s1", turns: 2, minutes: 5, at: new Date(t0 + 5 * MIN).toISOString() });
    expect(postProcess("a\r\nb")).toBe("a");
  });

  it("records a provider error on that block and continues", async () => {
    const t0 = NOW - 10 * HOUR;
    writeTranscript([...pair(t0, 5, { session: "bad" }), ...pair(t0, 5, { session: "good" })]);
    let prompts = 0;
    const provider = async () => {
      if (prompts++ === 0) throw new Error("HTTP 500");
      return "Fixed the build";
    };
    const out = path.join(dir, "d.json");
    const c = capture();
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--concurrency", "1"], { ...c.deps, provider })).toBe(0);
    const entries = JSON.parse(readFileSync(out, "utf8")).entries as Entry[];
    expect(entries[0]).toMatchObject({ worked: "", include: false, error: "HTTP 500" });
    expect(entries[1]).toMatchObject({ worked: "Fixed the build", include: true });
    expect(c.out.join("\n")).toContain("1 drafting errors");
  });

  it("flags lines that look like secrets and leaves them out", async () => {
    const hex = randomBytes(20).toString("hex");
    const pk = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
    expect(flagLine(`rotated ${hex}`)).toBe("long hex run");
    expect(flagLine(pk)).toBe("private key");
    expect(flagLine("mailed user@example.com")).toBe("email");
    expect(flagLine("set api_key=abc")).toBe("key=");
    expect(flagLine("refreshed the token cache")).toBe("token");
    expect(flagLine("changed the db password")).toBe("password");
    expect(flagLine(`blob ${randomBytes(40).toString("base64")}`)).toMatch(/run/);
    expect(flagLine("Fixed the login page for KEY-1")).toBeNull();
    writeTranscript(pair(NOW - 10 * HOUR, 5));
    const out = path.join(dir, "d.json");
    await run(["draft", "--projects-dir", projects, "--out", out], { ...capture().deps, provider: async () => "Rotated the token" });
    expect(JSON.parse(readFileSync(out, "utf8")).entries[0]).toMatchObject({ include: false, flagged: "token" });
    expect(readFileSync(path.join(dir, "d.md"), "utf8")).toContain("no (flagged: token)");
  });

  it("reduces a host name to a safe machine name", () => {
    expect(reduceMachine("acme box!.example")).toBe("acmebox.example");
    expect(reduceMachine("a".repeat(80))).toHaveLength(20);
  });

  it("fails naming a missing variable, never printing a value, and writes nothing", async () => {
    writeTranscript(pair(NOW - 10 * HOUR, 5));
    const value = `value-${randomUUID()}`;
    const out = path.join(dir, "d.json");
    const cases: Array<[Record<string, string>, string]> = [
      [{ BAB_BACKFILL_MODEL: value, BAB_BACKFILL_API_KEY_ENV: "ACME_KEY" }, "BAB_BACKFILL_BASE_URL"],
      [{ BAB_BACKFILL_BASE_URL: "https://llm.example.com", BAB_BACKFILL_API_KEY_ENV: "ACME_KEY" }, "BAB_BACKFILL_MODEL"],
      [{ BAB_BACKFILL_BASE_URL: "https://llm.example.com", BAB_BACKFILL_MODEL: value }, "BAB_BACKFILL_API_KEY_ENV"],
      [{ BAB_BACKFILL_BASE_URL: "https://llm.example.com", BAB_BACKFILL_MODEL: value, BAB_BACKFILL_API_KEY_ENV: "ACME_KEY" }, "ACME_KEY"],
    ];
    for (const [env, name] of cases) {
      const c = capture();
      let called = false;
      const code = await run(["draft", "--projects-dir", projects, "--out", out], { ...c.deps, env, fetch: async () => { called = true; throw new Error("no"); } });
      expect(code).toBe(2);
      expect(c.err.join("\n")).toContain(name);
      expect(c.err.join("\n") + c.out.join("\n")).not.toContain(value);
      expect(called).toBe(false);
      expect(existsSync(out)).toBe(false);
    }
  });

  it("sends the key from the named variable in x-api-key and never prints or writes it", async () => {
    writeTranscript(pair(NOW - 10 * HOUR, 5));
    const key = `k-${randomBytes(12).toString("hex")}`;
    const env = { BAB_BACKFILL_BASE_URL: "https://llm.example.com/", BAB_BACKFILL_MODEL: "acme-model", BAB_BACKFILL_API_KEY_ENV: "ACME_LLM_KEY", ACME_LLM_KEY: key };
    const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string; method: string } }> = [];
    const fetch = async (url: string, init: { headers: Record<string, string>; body: string; method: string }) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Fixed the build" }] }), { status: 200 });
    };
    const c = capture();
    const out = path.join(dir, "d.json");
    expect(await run(["draft", "--projects-dir", projects, "--out", out], { ...c.deps, env, fetch })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://llm.example.com/v1/messages");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" });
    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({ model: "acme-model", max_tokens: 100, messages: [{ role: "user" }] });
    expect(body.messages[0].content).toContain("please fix the build");
    expect(JSON.parse(readFileSync(out, "utf8")).entries[0].worked).toBe("Fixed the build");
    expect(c.out.join("\n") + c.err.join("\n") + allFilesText(dir)).not.toContain(key);

    // A failing endpoint: the error names the status, not the key.
    const c2 = capture();
    const fail = async () => new Response(JSON.stringify({ error: key }), { status: 401 });
    await run(["draft", "--projects-dir", projects, "--out", out], { ...c2.deps, env, fetch: fail });
    expect(JSON.parse(readFileSync(out, "utf8")).entries[0]).toMatchObject({ include: false, error: "model request failed: HTTP 401" });
    expect(c2.out.join("\n") + c2.err.join("\n") + allFilesText(dir)).not.toContain(key);

    // The model endpoint must be https, or http on loopback.
    const c3 = capture();
    expect(await run(["draft", "--projects-dir", projects, "--out", out], { ...c3.deps, env: { ...env, BAB_BACKFILL_BASE_URL: "http://llm.example.com" }, fetch })).toBe(2);
    expect(c3.err.join("\n")).toMatch(/https/);
  });

  it("buildPrompt caps the excerpt", () => {
    const p = buildPrompt({ repo: "r", branch: "b", text: "z".repeat(10000) });
    expect(p.match(/z/g)!.length).toBe(4000);
  });
});

describe("sentinel: transcript text never leaves except as the drafted line", () => {
  it("keeps the sentinel out of every output, the console and the upload", async () => {
    const S = `sentinel-${randomUUID()}`;
    const t0 = NOW - 10 * HOUR;
    writeTranscript([
      line({ type: "user", at: t0, content: `please look at ${S}`, branch: "feature/KEY-4" }),
      line({ type: "user", at: t0 + MIN, content: [{ type: "tool_result", content: `tool said ${S}` }], branch: "feature/KEY-4" }),
      line({ type: "assistant", at: t0 + 2 * MIN, branch: "feature/KEY-4", content: [{ type: "text", text: `I looked at ${S}` }, { type: "tool_use", name: "x", input: { q: S } }] }),
    ]);
    const outDir = path.join(dir, "out");
    mkdirSync(outDir);

    // --no-llm through the real CLI.
    const cli = spawnSync(process.execPath, [SCRIPT, "draft", "--projects-dir", projects, "--out", path.join(outDir, "a.json"), "--no-llm", "--machine", "acme-box"], { encoding: "utf8" });
    expect(cli.status).toBe(0);
    expect(cli.stdout + cli.stderr).not.toContain(S);
    expect(JSON.parse(readFileSync(path.join(outDir, "a.json"), "utf8")).entries[0].worked).toBe("Worked in acme-api on feature/KEY-4 (2 turns)");

    // A stub provider that returns a fixed line; the prompt does carry the excerpt.
    const c = capture();
    const prompts: string[] = [];
    const provider = async (p: string) => {
      prompts.push(p);
      return "Reviewed the login flow";
    };
    expect(await run(["draft", "--projects-dir", projects, "--out", path.join(outDir, "b.json")], { ...c.deps, provider })).toBe(0);
    expect(prompts[0]).toContain(S);
    expect(c.out.join("\n") + c.err.join("\n")).not.toContain(S);
    expect(readdirSync(outDir).sort()).toEqual(["a.json", "a.map-template.json", "a.md", "b.json", "b.map-template.json", "b.md"]);
    expect(allFilesText(outDir)).not.toContain(S);

    // Upload: dry run and a real send to a fake fetch.
    const bodies: string[] = [];
    const fetch = async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(JSON.stringify({ accepted: 1, duplicate: 0, refused: [], created: [], reassigned: [] }), { status: 200 });
    };
    for (const f of ["a.json", "b.json"]) {
      const u = capture();
      expect(await run(["upload", "--draft", path.join(outDir, f), "--dry-run"], { ...u.deps, fetch })).toBe(0);
      expect(await run(["upload", "--draft", path.join(outDir, f), "--url", "https://bab.example.com/api/command-center/backfill/abcdef0123"], { ...u.deps, fetch })).toBe(0);
      expect(u.out.join("\n") + u.err.join("\n")).not.toContain(S);
    }
    expect(bodies).toHaveLength(2);
    expect(bodies.join("\n")).not.toContain(S);
  });
});

describe("upload", () => {
  function draftWith(entries: Entry[]) {
    const p = path.join(dir, "draft.json");
    writeFileSync(p, JSON.stringify({ v: 1, kind: "bab-cc-backfill-draft", generatedAt: new Date(NOW).toISOString(), entries }));
    return p;
  }
  const entry = (i: number, extra: Entry = {}): Entry => ({
    id: `s1:${1000 + i}`,
    initiative: "api-work",
    title: "Api work",
    key: "KEY-1",
    worked: `Worked on item ${i}`,
    size: "small",
    at: new Date(NOW - i * MIN).toISOString(),
    session: "s1",
    machine: "acme-box",
    include: true,
    mappedBy: "rule 1 (repo)",
    repo: "acme-api",
    branch: "main",
    turns: 4,
    minutes: 12,
    ...extra,
  });

  it("sends only the allowlisted fields of included entries with a worked line", () => {
    const sendable = uploadEntries({
      v: 1,
      kind: "bab-cc-backfill-draft",
      entries: [entry(1, { flagged: "token", error: "x", source: "live", kind: "note", seq: 3 }), entry(2, { include: false }), entry(3, { worked: "  " }), entry(4, { title: undefined, key: "" })],
    });
    expect(sendable).toHaveLength(2);
    expect(Object.keys(sendable[0]).sort()).toEqual(["at", "id", "initiative", "key", "machine", "session", "size", "title", "worked"]);
    expect(Object.keys(sendable[1]).sort()).toEqual(["at", "id", "initiative", "machine", "session", "size", "worked"]);
    expect(() => uploadEntries({ v: 2, entries: [] })).toThrow(/draft/);
  });

  it("dry run prints counts and the first 3 lines and sends nothing", async () => {
    const p = draftWith([entry(1), entry(2), entry(3), entry(4)]);
    const c = capture();
    let called = 0;
    expect(await run(["upload", "--draft", p, "--dry-run"], { ...c.deps, fetch: async () => { called++; return new Response("{}"); } })).toBe(0);
    expect(called).toBe(0);
    const text = c.out.join("\n");
    expect(text).toMatch(/Dry run: 4 entries in 1 batch/);
    expect(text).toContain("Worked on item 3");
    expect(text).not.toContain("Worked on item 4");
    expect(text).not.toMatch(/acme-api|rule 1|"turns"/);
  });

  it("batches at 2000 entries, uploads one batch per link, prints counts and what is left", async () => {
    const p = draftWith(Array.from({ length: 2500 }, (_, i) => entry(i)));
    const token = "abcdef" + randomBytes(32).toString("hex").slice(6);
    const url = `https://bab.example.com/api/command-center/backfill/${token}`;
    const sent: Array<{ url: string; body: { v: number; entries: Entry[] } }> = [];
    const fetch = async (u: string, init: { body: string; method: string; headers: Record<string, string> }) => {
      expect(init.method).toBe("POST");
      expect(init.headers["content-type"]).toBe("application/json");
      const body = JSON.parse(init.body);
      sent.push({ url: u, body });
      return new Response(
        JSON.stringify({ accepted: body.entries.length - 1, duplicate: 0, refused: [{ index: 0, id: body.entries[0].id, reason: "at is too old" }], created: ["api-work"], reassigned: [] }),
        { status: 200 },
      );
    };
    const c = capture();
    expect(await run(["upload", "--draft", p, "--url", url], { ...c.deps, fetch })).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.v).toBe(1);
    expect(sent[0].body.entries).toHaveLength(2000);
    expect(Object.keys(sent[0].body)).toEqual(["v", "entries"]);
    for (const e of sent[0].body.entries) expect(Object.keys(e).every((k) => ["id", "initiative", "title", "key", "worked", "size", "at", "session", "machine"].includes(k))).toBe(true);
    const text = c.out.join("\n");
    expect(text).toContain("accepted 1999, duplicate 0, refused 1, created 1");
    expect(text).toContain("at is too old");
    expect(text).toContain("500 entries left");
    expect(text).toContain("--from 2000");
    expect(text).toContain("/api/command-center/backfill/abcdef...");
    expect(c.out.join("\n") + c.err.join("\n")).not.toContain(token);

    // Continue with --from and a second link; or send both batches with two links.
    sent.length = 0;
    const c2 = capture();
    expect(await run(["upload", "--draft", p, "--url", url, "--from", "2000"], { ...c2.deps, fetch })).toBe(0);
    expect(sent[0].body.entries).toHaveLength(500);
    expect(sent[0].body.entries[0].id).toBe("s1:3000");
    sent.length = 0;
    expect(await run(["upload", "--draft", p, "--url", url, "--url", url], { ...capture().deps, fetch })).toBe(0);
    expect(sent.map((s) => s.body.entries.length)).toEqual([2000, 500]);
  });

  it("batches by bytes too", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ id: `x:${i}`, worked: "w".repeat(100) }));
    const batches = batchEntries(entries, { maxBytes: 600 });
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(Buffer.byteLength(JSON.stringify({ v: 1, entries: b }))).toBeLessThanOrEqual(600);
    expect(batches.flat()).toHaveLength(10);
  });

  it("reports a refused upload with a non-zero exit and the masked link", async () => {
    const p = draftWith([entry(1)]);
    const token = randomBytes(32).toString("hex");
    const url = `https://bab.example.com/api/command-center/backfill/${token}`;
    const c = capture();
    const fetch = async () => new Response(JSON.stringify({ error: "This link is used or expired; make a new one with bab_command_center action=backfill_link" }), { status: 404 });
    expect(await run(["upload", "--draft", p, "--url", url], { ...c.deps, fetch })).toBe(1);
    expect(c.err.join("\n")).toMatch(/HTTP 404: This link is used or expired/);
    expect(c.out.join("\n") + c.err.join("\n")).not.toContain(token);
  });

  it("masks the link token after 6 characters", () => {
    expect(maskUrl("https://bab.example.com/api/command-center/backfill/0123456789abcdef?x=1")).toBe("https://bab.example.com/api/command-center/backfill/012345...");
  });

  it("refuses http on a non-loopback host and accepts https and loopback http", async () => {
    expect(() => checkUploadUrl("http://bab.example.com/api/command-center/backfill/abc")).toThrow(/https/);
    expect(() => checkUploadUrl("ftp://bab.example.com/x")).toThrow(/https/);
    expect(checkUploadUrl("http://127.0.0.1:4310/api/command-center/backfill/abc").hostname).toBe("127.0.0.1");
    expect(checkUploadUrl("http://localhost:4310/x").hostname).toBe("localhost");
    expect(checkUploadUrl("https://bab.example.com/x").protocol).toBe("https:");
    const p = draftWith([entry(1)]);
    const c = capture();
    let called = 0;
    expect(await run(["upload", "--draft", p, "--url", "http://bab.example.com/api/command-center/backfill/abc"], { ...c.deps, fetch: async () => { called++; return new Response("{}"); } })).toBe(2);
    expect(called).toBe(0);
  });
});

describe("cli", () => {
  it("prints usage on a bad mode or argument", async () => {
    const c = capture();
    expect(await run(["nope"], c.deps)).toBe(2);
    expect(c.err.join("\n")).toBe(USAGE);
    const c2 = capture();
    expect(await run(["draft", "--bogus"], c2.deps)).toBe(2);
    expect(c2.err.join("\n")).toContain("unknown argument: --bogus");
    const cli = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain("node scripts/cc-backfill.mjs draft --out");
  });
});
