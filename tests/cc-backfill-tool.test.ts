import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs, { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
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
  maskExcerpt,
  postProcess,
  flagLine,
  reduceMachine,
  uploadEntries,
  batchEntries,
  maskUrl,
  checkUploadUrl,
  parseBound,
  USAGE,
  applyPlanOp,
  parseSyncLine,
  readSyncTranscripts,
  sessionState,
  collectSessionStates,
  groupSessions,
  buildSyncDraft,
  maskField,
  maskFieldInfo,
  flagField,
  writePrivate,
  syncMarkdown,
  draftMarkdown,
  syncSlug,
  titleSlug,
  dedupeByTitle,
  uploadCurrent,
  uploadBody,
  answerText,
  ModelAnswerError,
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

/**
 * Spies on how writePrivate writes: every file must be written to a new temp file in the same
 * folder, opened exclusively ("wx") with mode 0600, then renamed into place. Nothing else may write.
 */
function spyPrivateWrites() {
  const opens: Array<{ file: string; flags: unknown; mode: unknown }> = [];
  const renames: Array<{ from: string; to: string }> = [];
  const writeFiles: string[] = [];
  const realOpen = fs.openSync;
  const realRename = fs.renameSync;
  const realWriteFile = fs.writeFileSync;
  const spyOpen = vi.spyOn(fs, "openSync").mockImplementation(((file: string, flags: unknown, mode: unknown) => {
    // Only opens for writing: a read that goes through openSync is not a write.
    if (flags !== undefined && flags !== "r") opens.push({ file: String(file), flags, mode });
    return realOpen(file, flags as string, mode as number);
  }) as typeof fs.openSync);
  const spyRename = vi.spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
    renames.push({ from: String(from), to: String(to) });
    return realRename(from, to);
  }) as typeof fs.renameSync);
  const spyWriteFile = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: string, data: string, opts?: unknown) => {
    writeFiles.push(String(file));
    return realWriteFile(file, data, opts as fs.WriteFileOptions);
  }) as typeof fs.writeFileSync);
  return {
    restore() {
      spyOpen.mockRestore();
      spyRename.mockRestore();
      spyWriteFile.mockRestore();
    },
    expectPrivate(files: string[]) {
      expect(writeFiles).toEqual([]);
      expect(renames.map((r) => r.to)).toEqual(files);
      expect(opens).toHaveLength(files.length);
      opens.forEach((o, i) => {
        expect(o).toMatchObject({ flags: "wx", mode: 0o600 });
        expect(o.file).toBe(renames[i].from);
        expect(path.dirname(o.file)).toBe(path.dirname(path.resolve(files[i])));
        expect(existsSync(o.file)).toBe(false); // renamed away, no temp file left
      });
    },
  };
}

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
    // A branch rule outranks a keys-only rule, whatever the file order (precedence by tier).
    expect(matchRule(block({ branch: "feature/KEY-7-x", cwd: "/x/other", repo: "other" }), rules)?.rule.initiative).toBe("by-branch");
    expect(matchRule(block({ branch: "bug/KEY-7-x", cwd: "/x/other", repo: "other" }), rules)?.rule.initiative).toBe("by-key");
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
    // Keys come from branch names only: ACME-3 is in the transcript text, so it stays out.
    expect(tpl).toMatchObject({ repos: ["acme-web"], branches: ["feature/KEY-2-login"], keys: ["KEY-2"], rules: [] });
    expect(tplText).not.toContain(sentinel);
    expect(tplText).not.toContain("ACME-3");
  });

  it("writes the draft, the table and the template for the owner only (0600)", async () => {
    writeTranscript(pair(NOW - 10 * HOUR, 5));
    const out = path.join(dir, "out", "draft.json");
    mkdirSync(path.dirname(out));
    // An older draft with wider permissions is tightened too.
    writeFileSync(out, "{}", { mode: 0o644 });
    const spies = spyPrivateWrites();
    const chmods: Array<{ file: string; mode: unknown }> = [];
    const realChmod = fs.chmodSync;
    const spyChmod = vi.spyOn(fs, "chmodSync").mockImplementation(((file: string, mode: number) => {
      chmods.push({ file: String(file), mode });
      return realChmod(file, mode);
    }) as typeof fs.chmodSync);
    try {
      expect(await run(["draft", "--projects-dir", projects, "--out", out, "--no-llm"], capture().deps)).toBe(0);
    } finally {
      spies.restore();
      spyChmod.mockRestore();
    }
    const files = [out, path.join(dir, "out", "draft.md"), path.join(dir, "out", "draft.map-template.json")];
    spies.expectPrivate(files);
    expect(chmods).toEqual(files.map((file) => ({ file, mode: 0o600 })));
    expect(JSON.parse(readFileSync(out, "utf8")).entries).toHaveLength(1);
    if (process.platform !== "win32") for (const f of files) expect(statSync(f).mode & 0o777).toBe(0o600);
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

  it("defaults the machine to the host name reduced and cut to 20, and refuses a --machine over 20 or with other characters", async () => {
    expect(reduceMachine("acme box!.example")).toBe("acmebox.example");
    expect(reduceMachine("a".repeat(80))).toHaveLength(20);
    writeTranscript(pair(NOW - 10 * HOUR, 5, { branch: "feature/KEY-123-add-login-page-validation" }));
    const out = path.join(dir, "d.json");
    const c = capture();
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--no-llm"], { ...c.deps, hostname: () => "acme-workstation-01.example.com" })).toBe(0);
    const [e] = JSON.parse(readFileSync(out, "utf8")).entries;
    expect(e.machine).toBe("acme-workstation-01.");
    // A long dashed branch in the template line is not a secret.
    expect(e).toMatchObject({ include: true, worked: "Worked in acme-api on feature/KEY-123-add-login-page-validation (2 turns)" });
    expect(e.flagged).toBeUndefined();
    for (const bad of ["a".repeat(21), "acme box"]) {
      const c2 = capture();
      expect(await run(["draft", "--projects-dir", projects, "--out", out, "--no-llm", "--machine", bad], c2.deps)).toBe(2);
      expect(c2.err.join("\n")).toMatch(/--machine must be 1 to 20 characters/);
    }
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--no-llm", "--machine", "a".repeat(20)], capture().deps)).toBe(0);
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
    const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string; method: string; redirect?: string } }> = [];
    const fetch = async (url: string, init: { headers: Record<string, string>; body: string; method: string; redirect?: string }) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "Fixed the build" }] }), { status: 200 });
    };
    const c = capture();
    const out = path.join(dir, "d.json");
    expect(await run(["draft", "--projects-dir", projects, "--out", out], { ...c.deps, env, fetch })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://llm.example.com/v1/messages");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.headers).toEqual({ "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" });
    const body = JSON.parse(calls[0].init.body);
    expect(body).toMatchObject({ model: "acme-model", max_tokens: 1024, messages: [{ role: "user" }] });
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
    const p = buildPrompt({ repo: "r", branch: "b", text: "z ".repeat(5000) });
    expect(p.match(/z/g)!.length).toBe(2000);
  });

  it("masks secret-shaped strings, email addresses and backfill links before the excerpt goes to the model", async () => {
    // Every secret is built at runtime: no token-shaped literal in the source.
    const hex = randomBytes(24).toString("hex");
    const b64 = randomBytes(45).toString("base64").replace(/[^A-Za-z0-9]/g, "A");
    const pkBody = randomBytes(30).toString("base64");
    const pk = [["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "), pkBody, ["-----END", "RSA PRIVATE KEY-----"].join(" ")].join("\n");
    const bearer = `tok${randomBytes(9).toString("hex")}`;
    const pat = ["ghp", randomBytes(18).toString("hex")].join("_");
    const keyValue = `kv${randomUUID().slice(0, 8)}`;
    const tokenValue = `tv${randomUUID().slice(0, 8)}`;
    const pwValue = `pw${randomUUID().slice(0, 8)}`;
    const quotedPw = `qp${randomUUID().slice(0, 8)}`;
    const email = `person.${randomUUID().slice(0, 6)}@example.com`;
    const linkToken = randomBytes(32).toString("hex");
    const link = `https://bab.example.com/api/command-center/backfill/${linkToken}`;
    const secrets = [hex, b64, pkBody, bearer, pat, keyValue, tokenValue, pwValue, quotedPw, email, linkToken, link];
    const ask = [
      `use hash ${hex} and blob ${b64}`,
      pk,
      `curl -H "Authorization: Bearer ${bearer}"`,
      `export GH=${pat}`,
      `api_key=${keyValue} and access_token: ${tokenValue}, password = ${pwValue}`,
      `{"db_password": "${quotedPw}"}`,
      `mail ${email} please`,
      `upload to ${link}`,
    ].join("\n");
    writeTranscript(pair(NOW - 10 * HOUR, 5, {}, `please fix the login token flow\n${ask}`, "done"));
    const prompts: string[] = [];
    const provider = async (p: string) => {
      prompts.push(p);
      return "Fixed the login flow";
    };
    expect(await run(["draft", "--projects-dir", projects, "--out", path.join(dir, "d.json")], { ...capture().deps, provider })).toBe(0);
    expect(prompts).toHaveLength(1);
    for (const s of secrets) expect(prompts[0]).not.toContain(s);
    // The ordinary words stay, so the model can still summarise.
    expect(prompts[0]).toContain("please fix the login token flow");
    for (const kind of ["long hex run", "long base64 run", "private key", "bearer token", "token", "assignment", "email", "backfill link"]) {
      expect(prompts[0]).toContain(`[redacted:${kind}]`);
    }
    expect(prompts[0]).toContain("api_key=[redacted:assignment]");
    expect(maskExcerpt("Fixed the login page for KEY-1 on feature/KEY-1-login")).toBe("Fixed the login page for KEY-1 on feature/KEY-1-login");
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
    const fetch = async (u: string, init: { body: string; method: string; headers: Record<string, string>; redirect?: string }) => {
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
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

  it("takes the link from BAB_BACKFILL_LINK when no --url is given, refusing redirects; --url wins", async () => {
    const p = draftWith([entry(1)]);
    const token = randomBytes(32).toString("hex");
    const envUrl = `https://bab.example.com/api/command-center/backfill/${token}`;
    const flagUrl = `https://bab.example.com/api/command-center/backfill/${randomBytes(32).toString("hex")}`;
    const sent: Array<{ url: string; redirect?: string }> = [];
    const fetch = async (u: string, init: { redirect?: string }) => {
      sent.push({ url: u, redirect: init.redirect });
      return new Response(JSON.stringify({ accepted: 1, duplicate: 0, refused: [], created: [], reassigned: [] }), { status: 200 });
    };
    const c = capture();
    expect(await run(["upload", "--draft", p], { ...c.deps, env: { BAB_BACKFILL_LINK: envUrl }, fetch })).toBe(0);
    expect(sent).toEqual([{ url: envUrl, redirect: "error" }]);
    expect(c.out.join("\n") + c.err.join("\n")).not.toContain(token);
    sent.length = 0;
    expect(await run(["upload", "--draft", p, "--url", flagUrl], { ...capture().deps, env: { BAB_BACKFILL_LINK: envUrl }, fetch })).toBe(0);
    expect(sent.map((s) => s.url)).toEqual([flagUrl]);
    // Neither: a usage error naming both ways.
    const c2 = capture();
    expect(await run(["upload", "--draft", p], { ...c2.deps, env: {}, fetch })).toBe(2);
    expect(c2.err.join("\n")).toContain("BAB_BACKFILL_LINK");
    // The environment link is checked like --url.
    expect(await run(["upload", "--draft", p], { ...capture().deps, env: { BAB_BACKFILL_LINK: "http://bab.example.com/x" }, fetch })).toBe(2);
    expect(USAGE).toContain("BAB_BACKFILL_LINK");
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

// ---------------------------------------------------------------------------------------------
// sync

type SyncOpts = {
  type?: "user" | "assistant";
  session?: string;
  at: number;
  content?: unknown;
  cwd?: string;
  branch?: string;
  extra?: Record<string, unknown>;
};

function sline(o: SyncOpts): string {
  return JSON.stringify({
    type: o.type ?? "user",
    sessionId: o.session ?? "s1",
    timestamp: new Date(o.at).toISOString(),
    cwd: o.cwd ?? "/home/user/work/acme-api",
    gitBranch: o.branch ?? "main",
    message: { role: o.type ?? "user", content: o.content ?? "hello" },
    ...(o.extra ?? {}),
  });
}

const tool = (name: string, input: unknown) => [{ type: "tool_use", id: `tu-${randomUUID().slice(0, 8)}`, name, input }];
const asst = (o: Omit<SyncOpts, "type" | "content">, name: string, input: unknown) => sline({ ...o, type: "assistant", content: tool(name, input) });
const toolResult = (o: Omit<SyncOpts, "type" | "content">) =>
  sline({ ...o, type: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }], extra: { toolUseResult: { ok: true } } });
const titleLine = (session: string, kind: "custom-title" | "ai-title", text: string) =>
  JSON.stringify(kind === "custom-title" ? { type: kind, customTitle: text, sessionId: session } : { type: kind, aiTitle: text, sessionId: session });
const PLAN = "mcp__agent-board__update_plan";
const WRAP = "mcp__agent-board__wrap_up";
type Plan = Array<{ text: string; status: string }>;

function stateOf(lines: string[]) {
  return sessionState(lines.map(parseSyncLine).filter(Boolean));
}

describe("sync: plan and todo state", () => {
  it("folds update_plan like the plan tool: items replace, done [n], advance, start n", () => {
    const items = applyPlanOp(null, { items: [{ content: "a", status: "in_progress" }, { content: "b" }, { content: "c", status: "completed" }, { content: "  " }] });
    expect(items).toEqual([
      { text: "a", status: "in_progress" },
      { text: "b", status: "pending" },
      { text: "c", status: "done" },
    ]);
    expect(applyPlanOp(null, { advance: true })).toBeNull();
    const adv = applyPlanOp(items, { advance: true }) as Plan;
    expect(adv.map((x) => x.status)).toEqual(["done", "in_progress", "done"]);
    expect((items as Plan)[0].status).toBe("in_progress"); // a copy, not in place
    const started = applyPlanOp(adv, { start: 1 }) as Plan;
    expect(started.map((x) => x.status)).toEqual(["in_progress", "pending", "done"]);
    const done = applyPlanOp(started, { done: [1, 2, 9] }) as Plan;
    expect(done.map((x) => x.status)).toEqual(["done", "done", "done"]);
    expect(applyPlanOp(null, { items: Array.from({ length: 60 }, (_, i) => ({ content: `s${i}` })) })).toHaveLength(50);
  });

  it("takes the latest of update_plan and TodoWrite, maps statuses; a wrap_up leaves a TodoWrite list as written", () => {
    const t0 = NOW - 5 * HOUR;
    const base = [
      sline({ at: t0, content: "start please" }),
      asst({ at: t0 + MIN }, PLAN, { items: [{ content: "Plan one", status: "in_progress" }, { content: "Plan two" }] }),
      asst({ at: t0 + 2 * MIN }, PLAN, { advance: true }),
    ];
    expect(stateOf(base).plan).toEqual([
      { text: "Plan one", status: "done" },
      { text: "Plan two", status: "in_progress" },
    ]);
    const todo = [
      ...base,
      asst({ at: t0 + 3 * MIN }, "TodoWrite", {
        todos: [
          { content: "Todo one", status: "completed", activeForm: "x" },
          { content: "Todo two", status: "in_progress", activeForm: "y" },
          { content: "Todo three", status: "pending" },
        ],
      }),
    ];
    expect(stateOf(todo).plan).toEqual([
      { text: "Todo one", status: "done" },
      { text: "Todo two", status: "in_progress" },
      { text: "Todo three", status: "pending" },
    ]);
    // An update_plan increment after a TodoWrite applies to that list.
    expect((stateOf([...todo, asst({ at: t0 + 4 * MIN }, PLAN, { start: 3 })]).plan as Plan).map((x) => x.status)).toEqual(["done", "pending", "in_progress"]);
    const wrapped = stateOf([...todo, asst({ at: t0 + 5 * MIN }, WRAP, { recap: "Done: all of it" })]);
    expect((wrapped.plan as Plan).map((x) => x.status)).toEqual(["done", "in_progress", "pending"]);
    expect(wrapped.finished).toBe(false);
  });
});

describe("sync: open question from the last wrap_up", () => {
  const t0 = NOW - 5 * HOUR;
  const ask = (at: number, blocked = true) =>
    asst({ at }, WRAP, { recap: "r", ask: "Merge the PR now?", blocked, actions: [{ label: "Merge", message: "merge it" }, { action: "Wait" }, { label: "" }, null] });

  it("is open when blocked and no real user turn came after, even with a later tool result or meta line", () => {
    const s = stateOf([sline({ at: t0, content: "go" }), ask(t0 + MIN), toolResult({ at: t0 + 2 * MIN })]);
    expect(s.question).toMatchObject({ ask: "Merge the PR now?", options: ["Merge", "Wait"] });
    const s2 = stateOf([
      sline({ at: t0, content: "go" }),
      ask(t0 + MIN),
      sline({ at: t0 + 2 * MIN, content: "<command-name>/clear</command-name>" }),
      sline({ at: t0 + 3 * MIN, content: "meta", extra: { isMeta: true } }),
    ]);
    expect(s2.question).not.toBeNull();
  });

  it("is gone once the person answered, when not blocked, without an ask, or when a later wrap_up was not blocked", () => {
    expect(stateOf([sline({ at: t0, content: "go" }), ask(t0 + MIN), sline({ at: t0 + 2 * MIN, content: "yes merge" })]).question).toBeNull();
    expect(stateOf([sline({ at: t0, content: "go" }), ask(t0 + MIN, false)]).question).toBeNull();
    expect(stateOf([sline({ at: t0, content: "go" }), ask(t0 + MIN), ask(t0 + 2 * MIN, false)]).question).toBeNull();
    expect(stateOf([sline({ at: t0, content: "go" }), asst({ at: t0 + MIN }, WRAP, { blocked: true })]).question).toBeNull();
  });

  it("prefers the custom title over the ai title and tolerates malformed lines", () => {
    const s = stateOf([
      "not json {",
      "null",
      "[]",
      JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: "nope" }),
      JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: new Date(t0).toISOString(), message: { content: [null, { type: "tool_use" }, { type: "tool_use", name: PLAN, input: "x" }] } }),
      JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: new Date(t0).toISOString(), message: { content: tool("TodoWrite", { todos: "bad" }) } }),
      JSON.stringify({ type: "user", sessionId: "s1", timestamp: new Date(t0).toISOString(), message: null }),
      sline({ at: t0 + MIN, content: "go" }),
      titleLine("s1", "ai-title", "Ai named it"),
      titleLine("s1", "custom-title", "Login rework"),
      JSON.stringify({ type: "custom-title", customTitle: 5, sessionId: "s1" }),
    ]);
    expect(s).toMatchObject({ rawTitle: "Login rework", repo: "acme-api", branch: "main", userTurns: 1, plan: null });
    expect(stateOf([sline({ at: t0, content: "go" }), titleLine("s1", "ai-title", "Ai named it")]).rawTitle).toBe("Ai named it");
  });
});

describe("sync: grouping, window and ids", () => {
  const t0 = NOW - 5 * HOUR;
  const sess = (session: string, at: number, o: Partial<SyncOpts> = {}) => [sline({ ...o, session, at, content: "work on it" })];

  it("merges sessions sharing a key (branch or title) or repo and non-trunk branch; trunk sessions stay apart", () => {
    writeTranscript([
      ...sess("a", t0, { branch: "feature/ACME-12-login" }),
      ...sess("b", t0 + MIN, { cwd: "/home/user/work/acme-web", branch: "main" }),
      titleLine("b", "custom-title", "Follow up on ACME-12"),
      ...sess("c", t0 + 2 * MIN, { branch: "fix/cache" }),
      ...sess("d", t0 + 3 * MIN, { branch: "fix/cache" }),
      ...sess("e", t0 + 4 * MIN, { branch: "main" }),
      ...sess("f", t0 + 5 * MIN, { branch: "main" }),
    ]);
    const states = collectSessionStates(readSyncTranscripts(projects).sessions, { now: NOW });
    const { draft } = buildSyncDraft(states, { now: NOW });
    const byId = new Map<string, Entry>(draft.current.map((r: Entry) => [String(r.id), r]));
    // Ids are the slug of the title; these sessions have no plan, so none is included.
    expect(byId.get("follow-up-on-acme-12")).toMatchObject({ key: "ACME-12", title: "Follow up on ACME-12", mappedBy: "key ACME-12", state: "active", include: false, leftOut: "no plan" });
    expect([...(byId.get("follow-up-on-acme-12")!.sessions as string[])].sort()).toEqual(["a", "b"]);
    expect(byId.get("acme-api-fix-cache")).toMatchObject({ mappedBy: "repo+branch", title: "acme-api fix/cache", area: "acme-api" });
    expect([...(byId.get("acme-api-fix-cache")!.sessions as string[])].sort()).toEqual(["c", "d"]);
    // Two untitled trunk sessions share the fallback title "acme-api main": the newer gets the slug, the older -2.
    expect(byId.get("acme-api-main")).toMatchObject({ mappedBy: "session", sessions: ["f"] });
    expect(byId.get("acme-api-main-2")).toMatchObject({ mappedBy: "session", sessions: ["e"] });
    expect(draft.current).toHaveLength(4);
    expect(draft.current[0].id).toBe("acme-api-main"); // newest first
    for (const r of draft.current) expect(String(r.id)).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    // Stable across reruns.
    const again = buildSyncDraft(collectSessionStates(readSyncTranscripts(projects).sessions, { now: NOW }), { now: NOW }).draft;
    expect(again.current.map((r: Entry) => r.id)).toEqual(draft.current.map((r: Entry) => r.id));
  });

  it("honours --map rules: a rule names the initiative, unassigned leaves sessions out, reserved ids are never used", () => {
    writeTranscript([
      ...sess("a", t0, { branch: "feature/x" }),
      ...sess("b", t0 + MIN, { cwd: "/home/user/work/acme-web" }),
      ...sess("c", t0 + 2 * MIN, { cwd: "/home/user/work/scratch" }),
    ]);
    const states = collectSessionStates(readSyncTranscripts(projects).sessions, { now: NOW });
    const rules = validateMap({
      rules: [
        { initiative: "api-work", repo: "acme-api", title: "API work", key: "KEY-9" },
        { initiative: "backfill", repo: "acme-web" },
        { initiative: "unassigned", repo: "scratch" },
      ],
    });
    const { groups, left } = groupSessions(states, rules);
    expect(left).toBe(1);
    expect(groups).toHaveLength(2);
    const { draft } = buildSyncDraft(states, { rules, now: NOW });
    expect(draft.current.find((r: Entry) => r.id === "api-work")).toMatchObject({ title: "API work", key: "KEY-9", mappedBy: "rule 1 (repo)" });
    // A title slug never takes a rule's id or a reserved one: it gets -2.
    const other = { cwd: "/home/user/work/other", content: "go" };
    const titled = [
      stateOf([sline({ ...other, session: "z", at: t0 }), titleLine("z", "custom-title", "API work")]),
      stateOf([sline({ ...other, session: "y", at: t0 }), titleLine("y", "custom-title", "Export")]),
    ];
    const withTitled = buildSyncDraft([...states, ...titled], { rules, now: NOW }).draft.current;
    expect(withTitled.find((r: Entry) => r.title === "API work" && r.mappedBy === "session")).toMatchObject({ id: "api-work-2" });
    expect(withTitled.find((r: Entry) => r.title === "Export")).toMatchObject({ id: "export-2" });
    const ids = draft.current.map((r: Entry) => String(r.id));
    expect(ids).not.toContain("backfill");
    expect(ids.some((id: string) => id.startsWith("backfill-"))).toBe(true);
    expect(syncSlug("export")).not.toBe("export");
    expect(syncSlug("backfill")).toMatch(/^backfill-[0-9a-f]{6}$/);
    // The server's own initiative for unmapped work is reserved too, and stays the same across runs.
    expect(syncSlug("unassigned")).toMatch(/^unassigned-[0-9a-f]{6}$/);
    expect(syncSlug("unassigned")).toBe(syncSlug("unassigned"));
    expect(syncSlug("Unassigned!")).toMatch(/^unassigned-[0-9a-f]{6}$/);
    expect(syncSlug("x".repeat(60))).toHaveLength(40);
    expect(syncSlug("KEY-12")).toBe("key-12");
  });

  it("reads only sessions active in the last --days, and skips sessions with nothing in them", async () => {
    writeTranscript([
      ...sess("old", NOW - 20 * 24 * HOUR),
      ...sess("mid", NOW - 10 * 24 * HOUR),
      ...sess("new", NOW - HOUR),
      sline({ session: "empty", at: NOW - HOUR, type: "assistant", content: [{ type: "text", text: "hi" }] }),
    ]);
    const { sessions } = readSyncTranscripts(projects);
    expect(collectSessionStates(sessions, { now: NOW }).map((s: { session: string }) => s.session)).toEqual(["new", "mid"]);
    expect(collectSessionStates(sessions, { now: NOW, days: 7 }).map((s: { session: string }) => s.session)).toEqual(["new"]);
    const out = path.join(dir, "sync.json");
    expect(await run(["sync", "--projects-dir", projects, "--out", out, "--days", "30"], capture().deps)).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).current).toHaveLength(3);
    const c = capture();
    expect(await run(["sync", "--projects-dir", projects, "--out", out, "--days", "0"], c.deps)).toBe(2);
    expect(c.err.join("\n")).toMatch(/--days must be a number from 1 to 365/);
    expect(await run(["sync", "--projects-dir", projects, "--out", out, "--no-llm"], capture().deps)).toBe(2);
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--days", "3"], capture().deps)).toBe(2);
    expect(await run(["sync", "--projects-dir", projects], capture().deps)).toBe(2);
  });

  it("lists every record, also over 100, newest first, each with its own id", () => {
    const states = Array.from({ length: 105 }, (_, i) => sessionState([parseSyncLine(sline({ session: `s${String(i).padStart(3, "0")}`, at: NOW - (i + 1) * MIN, content: "go" }))]));
    const { draft } = buildSyncDraft(states, { now: NOW });
    expect(draft.current).toHaveLength(105);
    expect(draft.current[0].sessions).toEqual(["s000"]);
    expect(new Set(draft.current.map((r: Entry) => r.id)).size).toBe(105);
    for (const r of draft.current) expect(String(r.id)).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
  });
});

describe("sync: draft output and masking", () => {
  it("writes current records with tasks and questions, and the readable file, owner only (0600)", async () => {
    const t0 = NOW - 3 * HOUR;
    const b = "feature/KEY-5-login";
    writeTranscript([
      sline({ at: t0, content: "please do the login", branch: b }),
      titleLine("s1", "custom-title", "Login page"),
      asst({ at: t0 + MIN, branch: b }, PLAN, { items: [{ content: "Write the form", status: "completed" }, { content: "Add tests", status: "in_progress" }, { content: "Open the PR" }] }),
      asst({ at: t0 + 2 * MIN, branch: b }, WRAP, { ask: "Open the PR against main?", blocked: true, actions: [{ label: "Open it" }, { label: "Not yet" }] }),
    ]);
    const out = path.join(dir, "out", "sync.json");
    mkdirSync(path.dirname(out));
    writeFileSync(out, "{}", { mode: 0o644 });
    const spies = spyPrivateWrites();
    const c = capture();
    try {
      expect(await run(["sync", "--projects-dir", projects, "--out", out], c.deps)).toBe(0);
    } finally {
      spies.restore();
    }
    const md = path.join(dir, "out", "sync.md");
    spies.expectPrivate([out, md]);
    if (process.platform !== "win32") for (const f of [out, md]) expect(statSync(f).mode & 0o777).toBe(0o600);
    const draft = JSON.parse(readFileSync(out, "utf8"));
    expect(draft).toMatchObject({ v: 1, kind: "bab-cc-backfill-draft", entries: [] });
    // The wrap_up does not check off the plan: it has no recap starting with "Done".
    expect(draft.current).toEqual([
      {
        id: "login-page",
        title: "Login page",
        area: "acme-api",
        key: "KEY-5",
        state: "active",
        tasks: [
          { id: "step-1", text: "Write the form", status: "done" },
          { id: "step-2", text: "Add tests", status: "in_progress" },
          { id: "step-3", text: "Open the PR", status: "pending" },
        ],
        questions: [{ id: expect.stringMatching(/^ask-[0-9a-f]{8}$/), text: "Open the PR against main?", options: ["Open it", "Not yet"] }],
        include: true,
        mappedBy: "key KEY-5",
        lastActiveAt: new Date(t0 + 2 * MIN).toISOString(),
        sessions: ["s1"],
        repo: "acme-api",
        branch: b,
      },
    ]);
    const mdText = readFileSync(md, "utf8");
    expect(mdText).toContain("## Login page");
    expect(mdText).toContain("- [~] Add tests");
    expect(mdText).toContain("Include: true.");
    expect(mdText).toContain("Question: Open the PR against main? (options: Open it / Not yet)");
    expect(c.out.join("\n")).toContain("1 included, 0 flagged, 1 open questions");
    expect(c.out.join("\n")).toContain("Nothing was uploaded");
  });

  it("masks secrets, emails, links and paths in titles, tasks and questions, and flags those records", () => {
    const pat = ["ghp", randomBytes(18).toString("hex")].join("_");
    const email = `person.${randomUUID().slice(0, 6)}@example.com`;
    expect(maskField(`push with ${pat}`, 120)).toBe("push with [redacted:token]");
    expect(maskField(String.raw`read C:\Users\someone\notes.txt`, 120)).toBe("read [redacted:path]");
    expect(maskField("read /home/someone/x.txt and ~/y", 120)).toBe("read [redacted:path] and [redacted:path]");
    expect(maskField("see https://intranet.example.com/x?y=1 now", 120)).toBe("see [redacted:link] now");
    expect(maskField("a\nb\u0007  c", 120)).toBe("a b c");
    expect(maskField("ab ".repeat(100), 120)).toHaveLength(119); // cut to 120, then trimmed
    expect(flagField("call +32 2 555 01 23")).toBe("long number");
    expect(flagField("[redacted:email] x")).toBe("masked email");
    expect(flagField("Fix the login for KEY-1 on feature/KEY-1-login")).toBeNull();
    const t0 = NOW - HOUR;
    const s = stateOf([
      sline({ session: "x", at: t0, content: "go" }),
      titleLine("x", "custom-title", `Mail ${email}`),
      asst({ session: "x", at: t0 + MIN }, PLAN, { items: [{ content: `Rotate ${pat}` }, { content: "Plain step" }] }),
    ]);
    const { draft } = buildSyncDraft([s], { now: NOW });
    const [r] = draft.current;
    expect(r).toMatchObject({ include: false, flagged: "title: masked email", title: "Mail [redacted:email]" });
    expect(r.tasks[0].text).toBe("Rotate [redacted:token]");
    expect(JSON.stringify(draft)).not.toContain(pat);
    expect(JSON.stringify(draft)).not.toContain(email);
    // Flagged records are not sent unless the person sets include: true after review.
    expect(uploadCurrent(draft).records).toEqual([]);
  });

  it("sentinel: transcript text, tool results, other tool input and the cwd path never reach the draft, console or upload", async () => {
    const S = `sentinel${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    // The real CLI below runs on the real clock, so these turns are an hour before now.
    const t0 = Date.now() - HOUR;
    const cwd = `/home/user/${S}dir/acme-api`;
    writeTranscript([
      sline({ at: t0, cwd, content: `please look at ${S}` }),
      sline({ at: t0 + MIN, cwd, type: "assistant", content: [{ type: "text", text: `I looked at ${S}` }, { type: "thinking", thinking: S }, ...tool("Bash", { command: `echo ${S}` })] }),
      sline({ at: t0 + 2 * MIN, cwd, content: [{ type: "tool_result", content: `tool said ${S}` }], extra: { toolUseResult: { stdout: S } } }),
      asst({ at: t0 + 3 * MIN, cwd }, PLAN, { items: [{ content: "Check the cache" }], note: S }),
      asst({ at: t0 + 4 * MIN, cwd }, WRAP, { recap: `recap ${S}`, ask: "Ship it?", blocked: true, actions: [{ label: "Ship", message: `msg ${S}` }] }),
      JSON.stringify({ type: "summary", summary: S, sessionId: "s1" }),
    ]);
    const outDir = path.join(dir, "out");
    mkdirSync(outDir);
    const cli = spawnSync(process.execPath, [SCRIPT, "sync", "--projects-dir", projects, "--out", path.join(outDir, "s.json")], { encoding: "utf8" });
    expect(cli.status).toBe(0);
    expect(cli.stdout + cli.stderr).not.toContain(S);
    const text = allFilesText(outDir);
    expect(text).not.toContain(S);
    expect(text).not.toContain("/home/user");
    const draft = JSON.parse(readFileSync(path.join(outDir, "s.json"), "utf8"));
    expect(draft.current[0]).toMatchObject({ tasks: [{ text: "Check the cache" }], questions: [{ text: "Ship it?", options: ["Ship"] }], repo: "acme-api" });
    const bodies: string[] = [];
    const fetch = async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(JSON.stringify({ accepted: 0, duplicate: 0, refused: [], created: [], reassigned: [] }), { status: 200 });
    };
    const u = capture();
    expect(await run(["upload", "--draft", path.join(outDir, "s.json"), "--dry-run"], { ...u.deps, fetch })).toBe(0);
    expect(await run(["upload", "--draft", path.join(outDir, "s.json"), "--url", "https://bab.example.com/api/command-center/backfill/abcdef0123"], { ...u.deps, fetch })).toBe(0);
    expect(u.out.join("\n") + u.err.join("\n") + bodies.join("\n")).not.toContain(S);
    expect(bodies).toHaveLength(1);
  });
});

describe("sync and draft: masking review fixes", () => {
  const t0 = NOW - HOUR;
  const one = (o: Partial<SyncOpts> & { session: string }, title?: string) =>
    stateOf([sline({ at: t0, content: "go", ...o }), ...(title ? [titleLine(o.session, "custom-title", title)] : [])]);

  it("makes ids from the masked title, never from the repo or branch; ids stay the same across runs", () => {
    const pat = ["ghp", randomBytes(18).toString("hex")].join("_");
    const states = [one({ session: "a", branch: `fix/${pat}` }, "Other thing"), one({ session: "b", branch: "fix/x" }, `Rotate ${pat}`)];
    const first = buildSyncDraft(states, { now: NOW }).draft.current;
    expect(JSON.stringify(first.map((r: Entry) => r.id))).not.toContain(pat.slice(4));
    const byId = new Map<string, Entry>(first.map((r: Entry) => [String(r.id), r]));
    expect(byId.get("other-thing")).toMatchObject({ title: "Other thing" });
    expect(byId.get("rotate-redacted-token")).toMatchObject({ include: false, flagged: "title: masked token" });
    expect(buildSyncDraft(states, { now: NOW }).draft.current.map((r: Entry) => r.id)).toEqual(first.map((r: Entry) => r.id));
    expect(uploadCurrent(buildSyncDraft(states, { now: NOW }).draft).records).toEqual([]);
  });

  it("flags the fallback title made from the repo and branch like any title", () => {
    const email = `person.${randomUUID().slice(0, 6)}@example.com`;
    const [r] = buildSyncDraft([one({ session: "d", cwd: `/home/user/${email}` })], { now: NOW }).draft.current;
    expect(r).toMatchObject({ title: "[redacted:email] main", include: false, flagged: "title: masked email" });
    expect(r.area).toBeUndefined();
    expect(JSON.stringify(r.title)).not.toContain(email);
  });

  it("normalises (NFKC, no format characters) before masking and flagging, in sync fields and the draft prompt", () => {
    const tail = randomBytes(12).toString("hex").toUpperCase();
    const fullwidth = [..."ghp_" + tail].map((ch) => String.fromCodePoint(ch.codePointAt(0)! + 0xfee0)).join("");
    expect(maskField(`push ${fullwidth}`, 120)).toBe("push [redacted:token]");
    const email = "per\u200Bson@exa\u200Dmple.com";
    expect(maskField(`mail ${email}`, 120)).toBe("mail [redacted:email]");
    expect(maskField("a\u202Eb\uFEFFc", 120)).toBe("abc");
    const p = buildPrompt({ repo: "r", branch: "b", text: `use ${fullwidth} and mail ${email}` });
    expect(p).toContain("use [redacted:token] and mail [redacted:email]");
    expect(p).not.toContain(tail);
    expect(flagLine(`Mailed per\u200Bson@exa\u200Dmple.com`)).toBe("email");
  });

  it("flags non-ASCII letters next to @ or :, split tokens and 'pw is X' prose, and masks the prose value", () => {
    expect(flagLine("mailed pérson@example.com")).not.toBeNull();
    expect(flagLine("mailed bob@éxample.com")).toBe("non-ASCII next to @ or :");
    expect(flagLine("set ключ: x")).toBe("non-ASCII next to @ or :");
    expect(flagLine("Fixed the menu of the café: done")).toBe("non-ASCII next to @ or :");
    expect(flagLine(["ghp", "ABCDEFGHIJ KLMNOPQRSTUVWXYZ0123"].join("_"))).toBe("split token");
    expect(flagLine("the pw is hunter2")).toBe("password");
    expect(flagLine("passphrase was correct-horse")).toBe("password");
    expect(maskField("the pw is hunter2 ok", 120)).toBe("the pw is [redacted:assignment] ok");
    expect(maskField("password was 'hunter 2' then", 120)).toBe("password was [redacted:assignment] then");
    expect(maskExcerpt("my pw is hunter2")).toBe("my pw is [redacted:assignment]");
    expect(flagLine("Fixed the login page for KEY-1")).toBeNull();
  });

  it("masks links of any scheme, host names of 3+ labels with a host suffix, and more absolute paths", () => {
    expect(maskField("clone ssh://git:pw@git.example.org/r.git and ftp://u:p@files.example.com/x", 200)).toBe("clone [redacted:link] and [redacted:link]");
    expect(maskField("call api.dev.internal.example.com and kafka.kafka.svc now", 120)).toBe("call [redacted:host] and [redacted:host] now");
    // Repo names, namespaces, file names and versions are not host names.
    expect(maskField("edit cc-backfill-tool.test.ts in acme.tools.matrix, System.Text.Json v1.2.3", 120)).toBe("edit cc-backfill-tool.test.ts in acme.tools.matrix, System.Text.Json v1.2.3");
    expect(maskField("open /d/work/x.txt and /Volumes/Data/y and /c/Users/z", 120)).toBe("open [redacted:path] and [redacted:path] and [redacted:path]");
    expect(maskField(String.raw`run C:\Program Files (x86)\Acme\x.exe now`, 120)).toBe("run [redacted:path] now");
    expect(maskField(String.raw`run C:\Program Files\Acme App\x.exe now`, 120)).toBe("run [redacted:path] now");
    expect(maskField(String.raw`read \\fileserver\share\Some Dir\x.txt`, 120)).toBe("read [redacted:path]");
    expect(maskField("and/or the a.b split", 120)).toBe("and/or the a.b split");
  });

  it("masks adversarial input in linear time, in sync fields and draft prompts alike", () => {
    const inputs = [
      "a".repeat(80000),
      "a-".repeat(40000),
      "a.".repeat(40000),
      "eyJ-".repeat(20000),
      "sk-".repeat(27000),
      `key="${"a".repeat(80000)}`,
      "a@".repeat(40000),
      `a@${"b.".repeat(40000)}1`,
      String.raw`C:\x ` + "w ".repeat(40000),
      "a+".repeat(40000),
      "a.b".repeat(26000),
    ];
    for (const s of inputs) {
      for (const f of [() => maskExcerpt(s), () => maskField(s, 500), () => flagLine(s), () => flagField(s), () => buildPrompt({ repo: "r", branch: "b", text: s })]) {
        const t = performance.now();
        f();
        expect(performance.now() - t).toBeLessThan(1000);
      }
    }
  });

  it("cuts raw field text to 4x the limit before masking, dropping a partial last word, and flags the cut", () => {
    expect(maskFieldInfo("word ".repeat(100), 120)).toMatchObject({ cut: true });
    expect(maskFieldInfo("word ".repeat(10), 120)).toMatchObject({ cut: false });
    // The partial word at the 4x cut is dropped: no fragment of what follows.
    // (A long hex run masks short, so text after the 4x cut would show within the field limit.)
    const info = maskFieldInfo(`${"a".repeat(470)} XYZsecretvalue`, 120);
    expect(info).toEqual({ text: "[redacted:long hex run]", cut: true });
    const long = one({ session: "e", branch: "main" }, "Long ".repeat(200));
    const [r] = buildSyncDraft([long], { now: NOW }).draft.current;
    expect(r).toMatchObject({ include: false, flagged: "title: cut (over 480 characters)" });
    expect(String(r.title).length).toBeLessThanOrEqual(120);
  });

  it("flags a masked marker cut in half by the field limit", () => {
    const hex = randomBytes(16).toString("hex");
    const v = maskField(`${"a ".repeat(50)}${hex}`, 120);
    expect(v.endsWith("[redacted:long hex r")).toBe(true);
    expect(flagField(v)).toBe("masked long hex r");
    expect(flagField("x [redacted:")).toBe("masked text");
  });

  it("escapes Markdown and HTML in the readable files", () => {
    const bt = "`";
    const evil = `<img src=x onerror=alert(1)> [a](https://x) ${bt}c${bt} *d* |e| \\f`;
    const escaped = `\\<img src=x onerror=alert(1)\\> \\[a\\](https://x) \\${bt}c\\${bt} \\*d\\* \\|e\\| \\\\f`;
    const md = syncMarkdown({
      generatedAt: new Date(NOW).toISOString(),
      current: [{ id: "x", title: evil, include: true, lastActiveAt: new Date(NOW).toISOString(), tasks: [{ id: "step-1", text: evil, status: "pending" }], questions: [{ id: "q", text: evil, options: [evil] }] }],
    });
    expect(md).toContain(`## ${escaped}`);
    expect(md).toContain(`- [ ] ${escaped}`);
    expect(md).toContain(`- Question: ${escaped} (options: ${escaped})`);
    expect(md).not.toMatch(/(^|[^\\])<img/m);
    const dm = draftMarkdown({ generatedAt: new Date(NOW).toISOString(), entries: [{ at: new Date(NOW).toISOString(), initiative: "x", worked: evil, size: "small", include: true }] });
    expect(dm).toContain(`| ${escaped} |`);
  });
});

describe("writePrivate", () => {
  it("replaces the file through an exclusive 0600 temp file, leaving no temp file", () => {
    const f = path.join(dir, "w.json");
    writeFileSync(f, "old", { mode: 0o644 });
    const spies = spyPrivateWrites();
    try {
      writePrivate(f, "new content");
    } finally {
      spies.restore();
    }
    spies.expectPrivate([f]);
    expect(readFileSync(f, "utf8")).toBe("new content");
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("refuses to write through a symbolic link, and leaves its target alone", () => {
    const target = path.join(dir, "target.txt");
    writeFileSync(target, "keep");
    const link = path.join(dir, "link.json");
    let real = true;
    try {
      fs.symlinkSync(target, link, "file");
    } catch {
      real = false; // no symlink privilege (Windows): fake the link
    }
    const spy = real
      ? null
      : vi.spyOn(fs, "lstatSync").mockImplementation(((p: string) => ({ isSymbolicLink: () => String(p) === link, isFile: () => false })) as unknown as typeof fs.lstatSync);
    try {
      expect(() => writePrivate(link, "x")).toThrow(/symbolic link/);
    } finally {
      spy?.mockRestore();
    }
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("sync: upload of current records", () => {
  const rec = (i: number, extra: Entry = {}): Entry => ({
    id: `init-${i}`,
    title: `Initiative ${i}`,
    area: "acme-api",
    key: "KEY-1",
    state: "active",
    tasks: [{ id: "step-1", text: "Do it", status: "in_progress" }],
    questions: [{ id: "ask-1", text: "Go?", options: ["Yes", "No"] }],
    include: true,
    mappedBy: "key KEY-1",
    lastActiveAt: new Date(NOW).toISOString(),
    sessions: ["s1"],
    repo: "acme-api",
    branch: "feature/KEY-1",
    ...extra,
  });
  const logEntry = (i: number): Entry => ({
    id: `s1:${i}`,
    initiative: "init-1",
    worked: `Worked ${i}`,
    size: "small",
    at: new Date(NOW - i * MIN).toISOString(),
    session: "s1",
    machine: "acme-box",
    include: true,
  });
  function syncDraft(current: Entry[], entries: Entry[] = []) {
    const p = path.join(dir, "sync.json");
    writeFileSync(p, JSON.stringify({ v: 1, kind: "bab-cc-backfill-draft", generatedAt: new Date(NOW).toISOString(), entries, current }));
    return p;
  }
  const okFetch = (sent: Array<Record<string, unknown>>) => async (_u: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    // The server's real answer shape for current records.
    return new Response(JSON.stringify({ accepted: 0, duplicate: 0, refused: [], created: [], reassigned: [], syncCreated: 2, syncSkipped: 0, syncRefused: [] }), { status: 200 });
  };
  const URL1 = "https://bab.example.com/api/command-center/backfill/abcdef0123";

  it("sends included records as current, allowlisted, without include or review fields", async () => {
    const p = syncDraft([
      rec(1, {
        links: [{ label: "x", url: "https://x.example.com" }],
        flagged: "x",
        extra: 1,
        tasks: [{ id: "step-1", text: "Do it", status: "done", startedAt: "x" }],
        questions: [{ id: "ask-1", text: "Go?", options: [], askedAt: "x" }],
      }),
      rec(2, { area: "", key: undefined, tasks: [], questions: undefined }),
      rec(3, { include: false }),
    ]);
    const sent: Array<Record<string, unknown>> = [];
    const c = capture();
    expect(await run(["upload", "--draft", p, "--url", URL1], { ...c.deps, fetch: okFetch(sent) })).toBe(0);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0])).toEqual(["v", "entries", "current"]);
    expect(sent[0]).toEqual({
      v: 1,
      entries: [],
      current: [
        { id: "init-1", title: "Initiative 1", area: "acme-api", key: "KEY-1", state: "active", tasks: [{ id: "step-1", text: "Do it", status: "done" }], questions: [{ id: "ask-1", text: "Go?" }] },
        { id: "init-2", title: "Initiative 2", state: "active" },
      ],
    });
    expect(c.out.join("\n")).toContain("Uploading 0 entries and 2 current records");
    expect(c.out.join("\n")).toContain("current: created 2, skipped 0, refused 0");
  });

  it("prints the server's sync answer: created, skipped, and each refused id with its reason", async () => {
    const p = syncDraft([rec(1), rec(2), rec(3)]);
    const fetch = async () =>
      new Response(
        JSON.stringify({
          accepted: 0,
          duplicate: 0,
          refused: [],
          created: [],
          reassigned: [],
          syncCreated: 1,
          syncSkipped: 1,
          syncRefused: [{ index: 2, id: "init-3", reason: "title holds a link\u001b[2J" }],
        }),
        { status: 200 },
      );
    const c = capture();
    expect(await run(["upload", "--draft", p, "--url", URL1], { ...c.deps, fetch })).toBe(0);
    const text = c.out.join("\n");
    expect(text).toContain("current: created 1, skipped 1, refused 1");
    expect(text).toContain("  current refused #2 init-3: title holds a link [2J");
    expect(text).not.toContain("\u001b");
    // No sync fields in the answer (a log-only upload): no current line.
    const c2 = capture();
    const logOnly = async () => new Response(JSON.stringify({ accepted: 1, duplicate: 0, refused: [], created: [], reassigned: [] }), { status: 200 });
    expect(await run(["upload", "--draft", syncDraft([], [logEntry(1)]), "--url", URL1], { ...c2.deps, fetch: logOnly })).toBe(0);
    expect(c2.out.join("\n")).not.toContain("current:");
  });

  it("sends log entries and current records together in the first body, current only there, and not with --from", async () => {
    const p = syncDraft([rec(1)], Array.from({ length: 2001 }, (_, i) => logEntry(i)));
    const sent: Array<Record<string, unknown>> = [];
    expect(await run(["upload", "--draft", p, "--url", URL1, "--url", URL1], { ...capture().deps, fetch: okFetch(sent) })).toBe(0);
    expect(sent.map((b) => Object.keys(b))).toEqual([
      ["v", "entries", "current"],
      ["v", "entries"],
    ]);
    expect(sent.map((b) => (b.entries as Entry[]).length)).toEqual([2000, 1]);
    sent.length = 0;
    const c = capture();
    expect(await run(["upload", "--draft", p, "--url", URL1, "--from", "2000"], { ...c.deps, fetch: okFetch(sent) })).toBe(0);
    expect(Object.keys(sent[0])).toEqual(["v", "entries"]);
    expect(c.out.join("\n")).toContain("1 current records are sent with --from 0 only");
  });

  it("dry run counts current records, names id and title only, and sends nothing", async () => {
    const p = syncDraft([rec(1), rec(2), rec(3), rec(4)]);
    const c = capture();
    let called = 0;
    const fetch = async () => {
      called++;
      return new Response("{}");
    };
    expect(await run(["upload", "--draft", p, "--dry-run"], { ...c.deps, fetch })).toBe(0);
    expect(called).toBe(0);
    const text = c.out.join("\n");
    expect(text).toMatch(/Dry run: 0 entries and 4 current records in 1 batch\(es\) of \d+ bytes/);
    expect(text).toContain("current init-3: Initiative 3 (1 tasks, 1 questions)");
    expect(text).not.toContain("init-4");
    expect(text).not.toMatch(/feature\/KEY-1|sessions|mappedBy|s1/);
  });

  it("skips records that break the server's limits, naming the field, and refuses more than 100 included", () => {
    const { records, skipped } = uploadCurrent({
      current: [
        rec(1, { id: "backfill" }),
        rec(2, { id: "export" }),
        rec(3, { title: "t".repeat(121) }),
        rec(4, { tasks: [{ id: "a", text: "x", status: "completed" }] }),
        rec(5, { questions: [{ id: "q", text: "x", options: ["1", "2", "3", "4", "5"] }] }),
        rec(6, { key: "nope" }),
        rec(7, { area: "a".repeat(41) }),
        rec(8, { tasks: [{ id: "a", text: "x", status: "done" }, { id: "a", text: "y", status: "done" }] }),
        rec(9, { state: "done" }),
        rec(10),
        rec(10),
        rec(11, { id: "unassigned" }),
      ],
    });
    expect(records.map((r: Entry) => r.id)).toEqual(["init-10"]);
    expect(skipped.map((s: { id: string }) => s.id)).toEqual(["backfill", "export", "init-3", "init-4", "init-5", "init-6", "init-7", "init-8", "init-9", "init-10", "unassigned"]);
    expect(skipped[10].reason).toMatch(/not export, backfill, unassigned/);
    expect(skipped[2].reason).toMatch(/title/);
    expect(skipped[3].reason).toMatch(/status/);
    expect(() => uploadCurrent({ current: Array.from({ length: 101 }, (_, i) => rec(i)) })).toThrow(/at most 100/);
    expect(uploadCurrent({}).records).toEqual([]);
    expect(() => uploadCurrent({ current: {} })).toThrow(/list/);
  });

  it("counts current records toward the 1 MB cap of the first body", () => {
    const current = [{ id: "a", title: "x".repeat(300) }];
    const entries = Array.from({ length: 6 }, (_, i) => ({ id: `x:${i}`, worked: "w".repeat(100) }));
    const batches = batchEntries(entries, { maxBytes: 700, current });
    batches.forEach((b: Entry[], i: number) => expect(Buffer.byteLength(JSON.stringify(uploadBody(b, i, current)))).toBeLessThanOrEqual(700));
    expect(batches.flat()).toHaveLength(6);
    // No room for any entry next to the current records: they go alone first.
    const tight = batchEntries([{ id: "x", worked: "w".repeat(200) }], { maxBytes: 400, current });
    expect(tight.map((b: Entry[]) => b.length)).toEqual([0, 1]);
    expect(batchEntries([], { current })).toEqual([[]]);
    expect(() => batchEntries([], { maxBytes: 100, current })).toThrow(/current records alone/);
    expect(USAGE).toContain("sync --out");
  });
});

describe("sync: selection quality (plan state, plan-only, dedupe, cap, title ids)", () => {
  const t0 = NOW - 6 * HOUR;
  const planned = (session: string, at: number, title: string, items: unknown[] = [{ content: "Step one", status: "in_progress" }, { content: "Step two" }]) => [
    sline({ session, at, content: "go" }),
    titleLine(session, "custom-title", title),
    asst({ session, at: at + MIN }, PLAN, { items }),
  ];
  const draftOf = (lines: string[], opts: { max?: number } = {}) => {
    writeTranscript(lines);
    return buildSyncDraft(collectSessionStates(readSyncTranscripts(projects).sessions, { now: NOW }), { now: NOW, ...opts });
  };

  it("wrap_up implicit completion: a wrap_up without a Done recap keeps the statuses of the last explicit plan call", () => {
    const s = stateOf([
      sline({ at: t0, content: "go" }),
      asst({ at: t0 + MIN }, PLAN, { items: [{ content: "a", status: "in_progress" }, { content: "b" }, { content: "c" }] }),
      asst({ at: t0 + 2 * MIN }, PLAN, { advance: true }),
      asst({ at: t0 + 3 * MIN }, WRAP, { recap: "Pushed the branch; review next." }),
      sline({ at: t0 + 4 * MIN, content: "go on" }),
      asst({ at: t0 + 5 * MIN }, PLAN, { done: [2] }),
      asst({ at: t0 + 6 * MIN }, WRAP, { recap: "Step b finished" }),
    ]);
    expect((s.plan as Plan).map((x) => x.status)).toEqual(["done", "done", "pending"]);
    expect(s.finished).toBe(false);
    // No recap at all: the same.
    const bare = stateOf([sline({ at: t0, content: "go" }), asst({ at: t0 + MIN }, PLAN, { items: [{ content: "a" }] }), asst({ at: t0 + 2 * MIN }, WRAP, {})]);
    expect((bare.plan as Plan)[0].status).toBe("pending");
  });

  it("Done: recap: the plan reads finished only when the last wrap_up says Done and came after the last plan call", () => {
    const base = [sline({ at: t0, content: "go" }), asst({ at: t0 + MIN }, PLAN, { items: [{ content: "a", status: "in_progress" }, { content: "b" }] })];
    for (const recap of ["Done: shipped it", "  done. all good", "DONE - merged"]) {
      const s = stateOf([...base, asst({ at: t0 + 2 * MIN }, WRAP, { recap })]);
      expect(s.finished).toBe(true);
      expect((s.plan as Plan).map((x) => x.status)).toEqual(["done", "done"]);
    }
    // Not the done word: "Donetsk", "Not done", a non-string recap.
    for (const recap of ["Donetsk office set up", "Not done: tests fail", 5]) {
      expect(stateOf([...base, asst({ at: t0 + 2 * MIN }, WRAP, { recap })]).finished).toBe(false);
    }
    // An earlier Done, then a later wrap_up that is not: not finished.
    expect(stateOf([...base, asst({ at: t0 + 2 * MIN }, WRAP, { recap: "Done: a" }), asst({ at: t0 + 3 * MIN }, WRAP, { recap: "Asked about b" })]).finished).toBe(false);
    // A plan call after the Done wrap_up is newer work: not finished, its own statuses.
    const after = stateOf([...base, asst({ at: t0 + 2 * MIN }, WRAP, { recap: "Done: a" }), asst({ at: t0 + 3 * MIN }, PLAN, { items: [{ content: "c", status: "in_progress" }] })]);
    expect(after.finished).toBe(false);
    expect(after.plan).toEqual([{ text: "c", status: "in_progress" }]);
    // The plan call and the Done wrap_up in the same message, plan first: finished.
    const same = sline({ at: t0 + 2 * MIN, type: "assistant", content: [...tool(PLAN, { advance: true }), ...tool(WRAP, { recap: "Done: both" })] });
    expect(stateOf([...base, same]).finished).toBe(true);
    // The recap never reaches the state.
    expect(JSON.stringify(stateOf([...base, asst({ at: t0 + 2 * MIN }, WRAP, { recap: "Done: secret-recap-text" })]))).not.toContain("secret-recap-text");
  });

  it("no-plan sessions: listed with include false and left out (no plan); plan sessions (update_plan or TodoWrite) included", () => {
    const { draft, noPlan } = draftOf([
      ...planned("p", t0, "Build the login"),
      sline({ session: "t", at: t0 + 2 * MIN, content: "go" }),
      titleLine("t", "custom-title", "Todo work"),
      asst({ session: "t", at: t0 + 3 * MIN }, "TodoWrite", { todos: [{ content: "One", status: "pending" }] }),
      sline({ session: "h", at: t0 + 4 * MIN, content: "heartbeat" }),
      titleLine("h", "custom-title", "Heartbeat check"),
    ]);
    expect(noPlan).toBe(1);
    const byId = new Map<string, Entry>(draft.current.map((r: Entry) => [String(r.id), r]));
    expect(byId.get("build-the-login")).toMatchObject({ include: true });
    expect(byId.get("build-the-login")!.leftOut).toBeUndefined();
    expect(byId.get("todo-work")).toMatchObject({ include: true });
    expect(byId.get("heartbeat-check")).toMatchObject({ include: false, leftOut: "no plan" });
    // Included first, then the left-out ones.
    expect(draft.current.map((r: Entry) => r.include)).toEqual([true, true, false]);
    const md = syncMarkdown(draft);
    expect(md).toContain("## Heartbeat check");
    expect(md).toContain("Include: false, left out (no plan).");
    expect(md).toContain("Include: true.");
    expect(uploadCurrent(draft).records.map((r: Entry) => r.id).sort()).toEqual(["build-the-login", "todo-work"]);
  });

  it("dedupe: one session per title (case and spacing folded), the most recent, a plan session over one without", () => {
    const states = [
      stateOf(planned("old", t0, "Fix the cache", [{ content: "Old step" }])),
      stateOf(planned("new", t0 + 10 * MIN, "fix  the CACHE ", [{ content: "New step" }])),
      stateOf([sline({ session: "chat", at: t0 + 20 * MIN, content: "hi" }), titleLine("chat", "custom-title", "Fix the cache")]),
      stateOf(planned("punct", t0 + 5 * MIN, "Fix: the cache!", [{ content: "Punct step" }])), // the same slug: one title
      stateOf([sline({ session: "u1", at: t0 + 30 * MIN, content: "hi" })]),
      stateOf([sline({ session: "u2", at: t0 + 31 * MIN, content: "hi" })]),
    ];
    const { states: kept, dropped } = dedupeByTitle(states);
    expect(dropped).toBe(3);
    expect(kept.map((s: { session: string }) => s.session).sort()).toEqual(["new", "u1", "u2"]);
    const { draft, deduped } = buildSyncDraft(states, { now: NOW });
    expect(deduped).toBe(3);
    expect(draft.current.find((r: Entry) => (r.sessions as string[]).includes("new"))).toMatchObject({ id: "fix-the-cache", sessions: ["new"], tasks: [{ text: "New step" }] });
  });

  it("cap: at most 20 included by default, the most recent; --max changes it; the rest are left out (over --max)", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => planned(`s${String(i).padStart(2, "0")}`, t0 + i * MIN * 2, `Task ${i}`)).flat();
    const { draft, overMax } = draftOf(lines);
    expect(overMax).toBe(5);
    const inc = draft.current.filter((r: Entry) => r.include);
    expect(inc).toHaveLength(20);
    expect(inc[0].title).toBe("Task 24");
    const out = draft.current.filter((r: Entry) => !r.include);
    expect(out.map((r: Entry) => r.title)).toEqual(["Task 4", "Task 3", "Task 2", "Task 1", "Task 0"]);
    for (const r of out) expect(r.leftOut).toBe("over --max 20");
    expect(syncMarkdown(draft)).toContain("Include: false, left out (over --max 20).");
    expect(draftOf(lines, { max: 3 }).draft.current.filter((r: Entry) => r.include)).toHaveLength(3);
    // The CLI flag.
    const o = path.join(dir, "cap.json");
    const c = capture();
    expect(await run(["sync", "--projects-dir", projects, "--out", o, "--max", "7"], c.deps)).toBe(0);
    expect(JSON.parse(readFileSync(o, "utf8")).current.filter((r: Entry) => r.include)).toHaveLength(7);
    expect(c.out.join("\n")).toContain("Left out: 0 with no plan, 18 over --max 7");
    expect(await run(["sync", "--projects-dir", projects, "--out", o], capture().deps)).toBe(0);
    expect(JSON.parse(readFileSync(o, "utf8")).current.filter((r: Entry) => r.include)).toHaveLength(20);
    for (const bad of ["0", "101", "x"]) {
      const e = capture();
      expect(await run(["sync", "--projects-dir", projects, "--out", o, "--max", bad], e.deps)).toBe(2);
      expect(e.err.join("\n")).toMatch(/--max must be a number from 1 to 100/);
    }
    expect(await run(["draft", "--projects-dir", projects, "--out", o, "--max", "3", "--no-llm"], capture().deps)).toBe(2);
    expect(await run(["upload", "--draft", o, "--max", "3", "--dry-run"], capture().deps)).toBe(2);
  });

  it("slug ids: the title's slug like a publish id (a-z, 0-9, -, max 40), stable; clashes get -2, -3, the newest keeps the plain slug", () => {
    expect(titleSlug("Billing export")).toBe("billing-export");
    expect(titleSlug("  Fix: KEY-12 / login (v2)!  ")).toBe("fix-key-12-login-v2");
    expect(titleSlug("Ünïcode ☃")).toBe("n-code");
    expect(titleSlug("☃☃")).toBe("");
    const long = "A very long session title that keeps going and going past forty";
    expect(titleSlug(long)).toBe("a-very-long-session-title-that-keeps-goi");
    expect(titleSlug("x".repeat(39) + " y")).toBe("x".repeat(39)); // no trailing -
    const states = [
      stateOf(planned("a", t0, "Export")), // a reserved route: -2
      stateOf(planned("b", t0 + 10 * MIN, "Login rework")),
      stateOf(planned("c", t0 + 20 * MIN, "Login rework 2")), // its slug is what b's clash would be
      stateOf(planned("d", t0 + 30 * MIN, long + " one")),
      stateOf(planned("e", t0 + 40 * MIN, long + " two")),
      stateOf(planned("f", t0 + 50 * MIN, "☃")),
    ];
    const ids = (d: { draft: { current: Entry[] } }) => new Map<string, string>(d.draft.current.map((r: Entry) => [(r.sessions as string[])[0], String(r.id)]));
    const first = ids(buildSyncDraft(states, { now: NOW }));
    expect(first.get("a")).toBe("export-2");
    expect(first.get("b")).toBe("login-rework");
    expect(first.get("c")).toBe("login-rework-2");
    expect(first.get("e")).toBe("a-very-long-session-title-that-keeps-goi");
    expect(first.get("d")).toBe("a-very-long-session-title-that-keeps-g-2");
    expect(first.get("f")).toBe("session-f"); // nothing left of the title: the session id
    for (const id of first.values()) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    expect(ids(buildSyncDraft([...states].reverse(), { now: NOW }))).toEqual(first);
  });

  it("a TodoWrite list stays as written, also after update_plan increments and a Done recap", () => {
    const s = stateOf([
      sline({ at: t0, content: "go" }),
      asst({ at: t0 + MIN }, "TodoWrite", { todos: [{ content: "One", status: "in_progress" }, { content: "Two", status: "pending" }] }),
      asst({ at: t0 + 2 * MIN }, PLAN, { advance: true }),
      asst({ at: t0 + 3 * MIN }, WRAP, { recap: "Done: all" }),
    ]);
    expect(s.finished).toBe(false);
    expect((s.plan as Plan).map((x) => x.status)).toEqual(["done", "in_progress"]);
  });

  it("a --map rule group without a plan is left out too; a left-out flagged record shows both reasons; upload takes only included ones of a long list", () => {
    const email = `person.${randomUUID().slice(0, 6)}@example.com`;
    const ruled = stateOf([sline({ session: "m", at: t0, content: "go", cwd: "/home/user/work/acme-web" })]);
    const flagged = stateOf([sline({ session: "x", at: t0 + MIN, content: "go" }), titleLine("x", "custom-title", `Mail ${email}`)]);
    const { draft } = buildSyncDraft([ruled, flagged], { rules: validateMap({ rules: [{ initiative: "web-work", repo: "acme-web" }] }), now: NOW });
    expect(draft.current.find((r: Entry) => r.id === "web-work")).toMatchObject({ include: false, leftOut: "no plan" });
    expect(syncMarkdown(draft)).toContain("Include: false, left out (no plan), flagged: title: masked email.");
    const many = Array.from({ length: 130 }, (_, i) => stateOf(planned(`s${String(i).padStart(3, "0")}`, t0 + i * MIN, `Work ${i}`)));
    const big = buildSyncDraft(many, { now: NOW, max: 100 }).draft;
    expect(big.current).toHaveLength(130);
    expect(uploadCurrent(big).records).toHaveLength(100);
  });
});

describe("real run fixes: model answers, retry-errors, title and session mapping, map-from-sync", () => {
  const llmEnv = { BAB_BACKFILL_BASE_URL: "https://llm.example.com", BAB_BACKFILL_MODEL: "acme-model", BAB_BACKFILL_API_KEY_ENV: "ACME_LLM_KEY", ACME_LLM_KEY: "k-test" };
  type Init = { body: string };
  /** A fake Messages API server: answers each request with the next fixture body (the last one repeats), records max_tokens and the prompt. */
  function fakeModel(answers: Array<() => unknown>) {
    const calls: Array<{ maxTokens: number; prompt: string }> = [];
    const fetch = async (_url: string, init: Init) => {
      const body = JSON.parse(init.body);
      calls.push({ maxTokens: body.max_tokens, prompt: body.messages[0].content as string });
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)]();
      return new Response(JSON.stringify(answer), { status: 200 });
    };
    return { calls, fetch };
  }
  const THINKING = `thinking-${randomUUID()}`;
  const thinkingThenText = (text: string) => () => ({
    content: [{ type: "thinking", thinking: THINKING, signature: "sig" }, { type: "text", text }],
    stop_reason: "end_turn",
  });
  const onlyThinking = () => ({ content: [{ type: "thinking", thinking: THINKING, signature: "sig" }], stop_reason: "max_tokens" });

  it("answerText: first non-blank text block; no content list is an error, an empty list or blank text a skip", () => {
    expect(answerText({ content: [{ type: "thinking", thinking: "t" }, { type: "text", text: " " }, { type: "text", text: "Line" }] })).toBe("Line");
    const err = (body: unknown) => {
      try {
        answerText(body);
      } catch (e) {
        return e as ModelAnswerError;
      }
      throw new Error("no error");
    };
    expect(err({ error: { type: "overloaded" } })).toMatchObject({ empty: false, message: "model answer has no text block (stop_reason: none; blocks: none)" });
    expect(err(null).empty).toBe(false);
    expect(err({ content: [], stop_reason: "end_turn" }).empty).toBe(true);
    expect(err({ content: [{ type: "text", text: "" }] }).empty).toBe(true);
    expect(err({ content: [{ type: "thinking" }], stop_reason: "max_tokens" }).empty).toBe(false);
    // An empty list cut short is retried, not skipped.
    expect(err({ content: [], stop_reason: "max_tokens" }).empty).toBe(false);
    expect(err({ content: [], stop_reason: "refusal" }).empty).toBe(false);
  });

  it("takes the first text block after a thinking block", async () => {
    writeTranscript(pair(NOW - 10 * HOUR, 5));
    const m = fakeModel([thinkingThenText("Fixed the build pipeline")]);
    const out = path.join(dir, "d.json");
    expect(await run(["draft", "--projects-dir", projects, "--out", out], { ...capture().deps, env: llmEnv, fetch: m.fetch })).toBe(0);
    expect(m.calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(out, "utf8")).entries[0]).toMatchObject({ worked: "Fixed the build pipeline", include: true });
    expect(allFilesText(dir)).not.toContain(THINKING);
  });

  it("retries a block once with a larger budget when the answer has no text block, then records stop_reason and block types only", async () => {
    const S = `sentinel-${randomUUID()}`;
    writeTranscript(pair(NOW - 10 * HOUR, 5, { session: "a" }, `fix it ${S}`));
    const out = path.join(dir, "d.json");
    // Thinking only, twice: an error naming the stop reason and the block types, never any text.
    const m = fakeModel([onlyThinking]);
    const c = capture();
    expect(await run(["draft", "--projects-dir", projects, "--out", out], { ...c.deps, env: llmEnv, fetch: m.fetch })).toBe(0);
    expect(m.calls.map((x) => x.maxTokens)).toEqual([1024, 4096]);
    expect(m.calls[1].prompt).toBe(m.calls[0].prompt);
    const [e] = JSON.parse(readFileSync(out, "utf8")).entries;
    expect(e).toMatchObject({ worked: "", include: false, error: "model answer has no text block (stop_reason: max_tokens; blocks: thinking), also on retry" });
    expect(allFilesText(dir) + c.out.join("\n") + c.err.join("\n")).not.toContain(S);
    expect(allFilesText(dir)).not.toContain(THINKING);
    expect(c.out.join("\n")).toContain("--retry-errors");
    // Thinking only, then a text answer on the retry: the line is kept.
    const m2 = fakeModel([onlyThinking, thinkingThenText("Fixed it on the retry")]);
    expect(await run(["draft", "--projects-dir", projects, "--out", out], { ...capture().deps, env: llmEnv, fetch: m2.fetch })).toBe(0);
    expect(m2.calls).toHaveLength(2);
    const [e2] = JSON.parse(readFileSync(out, "utf8")).entries;
    expect(e2).toMatchObject({ worked: "Fixed it on the retry", include: true });
    expect(e2.error).toBeUndefined();
  });

  it("treats an empty answer as a skip with a reason, not an error, and does not retry it", async () => {
    writeTranscript([...pair(NOW - 10 * HOUR, 5, { session: "a" }), ...pair(NOW - 10 * HOUR, 5, { session: "b" })]);
    const out = path.join(dir, "d.json");
    const m = fakeModel([() => ({ content: [], stop_reason: "end_turn" }), () => ({ content: [{ type: "text", text: "  \n " }], stop_reason: "end_turn" })]);
    const c = capture();
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--concurrency", "1"], { ...c.deps, env: llmEnv, fetch: m.fetch })).toBe(0);
    expect(m.calls).toHaveLength(2);
    const entries = JSON.parse(readFileSync(out, "utf8")).entries as Entry[];
    expect(entries[0]).toMatchObject({ worked: "", include: false, skipped: "model returned an empty answer (stop_reason: end_turn; blocks: none)" });
    expect(entries[1]).toMatchObject({ worked: "", include: false, skipped: "model returned an empty answer (stop_reason: end_turn; blocks: text)" });
    for (const e of entries) expect(e.error).toBeUndefined();
    expect(c.out.join("\n")).toContain("0 drafting errors, 2 skipped (empty answer)");
    expect(readFileSync(path.join(dir, "d.md"), "utf8")).toContain("no (skipped: model returned an empty answer");
    // Odd answer fields are reduced to short names: no text of the answer reaches the error.
    const m2 = fakeModel([() => ({ content: [{ type: "Weird Type! secret" }], stop_reason: "stop: secret words here and more and more" })]);
    await run(["draft", "--projects-dir", projects, "--out", out, "--concurrency", "1"], { ...capture().deps, env: llmEnv, fetch: m2.fetch });
    const err = (JSON.parse(readFileSync(out, "utf8")).entries[0] as Entry).error as string;
    expect(err).toMatch(/^model answer has no text block \(stop_reason: [a-z0-9_]{1,30}; blocks: [a-z0-9_]+\), also on retry$/);
    expect(err).not.toContain(" secret");
  });

  it("--retry-errors drafts only errored entries again and keeps included, edited, flagged and skipped entries exactly", async () => {
    const t0 = NOW - 10 * HOUR;
    writeTranscript(["a", "b", "c", "d"].flatMap((s) => pair(t0, 5, { session: s }, `work on ${s}`)));
    const out = path.join(dir, "d.json");
    const provider1 = async (p: string) => {
      if (p.includes("work on a")) return "Worked on a";
      if (p.includes("work on b")) throw new Error("model request failed: HTTP 529");
      if (p.includes("work on c")) return "Rotated the token";
      return "";
    };
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--concurrency", "1"], { ...capture().deps, provider: provider1 })).toBe(0);
    const before = JSON.parse(readFileSync(out, "utf8"));
    const bySession = (d: { entries: Entry[] }, s: string) => d.entries.find((e) => e.session === s)!;
    expect(bySession(before, "b")).toMatchObject({ error: "model request failed: HTTP 529" });
    expect(bySession(before, "c")).toMatchObject({ flagged: "token" });
    expect(bySession(before, "d")).toMatchObject({ skipped: "model returned an empty line" });
    // The person edits an included line and its initiative.
    bySession(before, "a").worked = "Edited by hand";
    bySession(before, "a").initiative = "my-work";
    writeFileSync(out, JSON.stringify(before, null, 2));
    const prompts: string[] = [];
    const provider2 = async (p: string) => {
      prompts.push(p);
      return "Worked on b now";
    };
    const c = capture();
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--retry-errors"], { ...c.deps, provider: provider2 })).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("work on b");
    const after = JSON.parse(readFileSync(out, "utf8"));
    expect(after.entries.map((e: Entry) => e.id)).toEqual(before.entries.map((e: Entry) => e.id));
    for (const s of ["a", "c", "d"]) expect(bySession(after, s)).toEqual(bySession(before, s));
    expect(bySession(after, "b")).toMatchObject({ worked: "Worked on b now", include: true });
    expect(bySession(after, "b").error).toBeUndefined();
    expect(c.out.join("\n")).toContain("1 errored blocks drafted again");
    // Nothing errored now: a second retry asks the model nothing.
    const none = vi.fn(async () => "x");
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--retry-errors"], { ...capture().deps, provider: none })).toBe(0);
    expect(none).not.toHaveBeenCalled();
    // An errored entry the person fixed by hand (a line typed, error left in) is not redone.
    const handFixed = JSON.parse(JSON.stringify(after));
    const restored = { ...bySession(before, "b"), worked: "Typed by hand", include: true };
    handFixed.entries[handFixed.entries.findIndex((e: Entry) => e.session === "b")] = restored;
    writeFileSync(out, JSON.stringify(handFixed));
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--retry-errors"], { ...capture().deps, provider: none })).toBe(0);
    expect(none).not.toHaveBeenCalled();
    expect(bySession(JSON.parse(readFileSync(out, "utf8")), "b")).toEqual(restored);
    // An errored entry whose block is gone stays as it is.
    const gone = { ...after, entries: [...after.entries, { ...bySession(before, "b"), id: "gone:1", session: "gone" }] };
    writeFileSync(out, JSON.stringify(gone));
    const c3 = capture();
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--retry-errors"], { ...c3.deps, provider: none })).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).entries.at(-1)).toMatchObject({ id: "gone:1", error: "model request failed: HTTP 529" });
    expect(c3.out.join("\n")).toContain("1 errored entries whose block is no longer in the transcripts");
  });

  it("--retry-errors maps the redone entries with the current rules", async () => {
    writeTranscript([...pair(NOW - 10 * HOUR, 5, { session: "a" }), titleLine("a", "ai-title", "Command Center")]);
    const out = path.join(dir, "d.json");
    const failing = async (): Promise<string> => {
      throw new Error("model request failed (network)");
    };
    await run(["draft", "--projects-dir", projects, "--out", out], { ...capture().deps, provider: failing });
    expect(JSON.parse(readFileSync(out, "utf8")).entries[0]).toMatchObject({ initiative: "unassigned", error: "model request failed (network)" });
    const map = path.join(dir, "map.json");
    writeFileSync(map, JSON.stringify({ rules: [{ initiative: "cc", titleMatch: "command center" }] }));
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--retry-errors", "--map", map], { ...capture().deps, provider: async () => "Built it" })).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).entries[0]).toMatchObject({ initiative: "cc", worked: "Built it", include: true });
  });

  it("--retry-errors refuses a missing or foreign draft and the window flags; the new flags are refused outside draft", async () => {
    writeTranscript(pair(NOW - 10 * HOUR, 5));
    const out = path.join(dir, "d.json");
    const c = capture();
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--retry-errors", "--no-llm"], c.deps)).toBe(2);
    expect(c.err.join("\n")).toMatch(/cannot read the draft to retry/);
    writeFileSync(out, JSON.stringify({ v: 1, kind: "other", entries: [] }));
    const c2 = capture();
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--retry-errors", "--no-llm"], c2.deps)).toBe(2);
    expect(c2.err.join("\n")).toMatch(/the draft to retry must be/);
    for (const extra of [["--since", "2026-01-01"], ["--settle-hours", "1"]]) {
      const c3 = capture();
      expect(await run(["draft", "--projects-dir", projects, "--out", out, "--retry-errors", "--no-llm", ...extra], c3.deps)).toBe(2);
      expect(c3.err.join("\n")).toMatch(/do not apply/);
    }
    const c4 = capture();
    expect(await run(["sync", "--projects-dir", projects, "--out", out, "--retry-errors"], c4.deps)).toBe(2);
    expect(c4.err.join("\n")).toMatch(/--retry-errors is for draft/);
    const c5 = capture();
    expect(await run(["upload", "--draft", out, "--dry-run", "--map-from-sync", out], c5.deps)).toBe(2);
    expect(c5.err.join("\n")).toMatch(/are for draft/);
  });

  it("maps by titleMatch (substring or /regex/, case-insensitive) and sessionId, with precedence sessionId > titleMatch > cwd/repo/branch > keys", () => {
    const rules = validateMap({
      rules: [
        { initiative: "by-keys", keys: ["KEY-1"] },
        { initiative: "by-repo", repo: "acme-api" },
        { initiative: "by-title", titleMatch: "Login REWORK" },
        { initiative: "by-title-re", titleMatch: "/^export\\b.*csv$/" },
        { initiative: "by-session", sessionId: ["s-pinned", "s-other"] },
        { initiative: "title-and-repo", titleMatch: "billing", repo: "acme-web" },
      ],
    });
    const b = (o: Partial<{ session: string; title: string; repo: string; branch: string; text: string }>) => ({ session: "s1", title: "", cwd: "/home/user/work", repo: "acme-api", branch: "feature/KEY-1", text: "", ...o });
    expect(matchRule(b({}), rules)).toMatchObject({ rule: { initiative: "by-repo" } });
    expect(matchRule(b({ repo: "work" }), rules)).toMatchObject({ rule: { initiative: "by-keys" } });
    expect(matchRule(b({ title: "the login rework, part 2" }), rules)).toMatchObject({ rule: { initiative: "by-title" }, mappedBy: "rule 3 (titleMatch)" });
    expect(matchRule(b({ title: "EXPORT to CSV" }), rules)?.rule.initiative).toBe("by-title-re");
    expect(matchRule(b({ title: "not an export to csv" }), rules)?.rule.initiative).toBe("by-repo");
    expect(matchRule(b({ session: "s-pinned", title: "login rework" }), rules)).toMatchObject({ rule: { initiative: "by-session" }, mappedBy: "rule 5 (sessionId)" });
    // All given fields of a rule must match: a title rule with a repo needs both.
    expect(matchRule(b({ title: "Billing fixes", repo: "acme-web" }), rules)?.rule.initiative).toBe("title-and-repo");
    expect(matchRule(b({ title: "Billing fixes" }), rules)?.rule.initiative).toBe("by-repo");
    expect(() => validateMap({ rules: [{ initiative: "x", titleMatch: "/(/" }] })).toThrow(/regular expression/);
    expect(() => validateMap({ rules: [{ initiative: "x", titleMatch: "" }] })).toThrow(/titleMatch/);
    expect(() => validateMap({ rules: [{ initiative: "x", sessionId: [] }] })).toThrow(/sessionId/);
    expect(() => validateMap({ rules: [{ initiative: "x", sessionId: "bad id!" }] })).toThrow(/sessionId/);
    expect(() => validateMap({ rules: [{ initiative: "x", sessionId: ["ok", 5] }] })).toThrow(/sessionId/);
    expect(() => validateMap({ rules: [{ initiative: "x", titleMatch: "/login/i" }] })).toThrow(/takes no flags/);
  });

  it("draft maps blocks by session title from the transcript and lists masked titles of unmapped sessions in the template, never a raw one", async () => {
    const t0 = NOW - 10 * HOUR;
    const generic = { cwd: "C:\\Users\\person\\work" };
    const S = `sentinel-${randomUUID()}`;
    writeTranscript([
      ...pair(t0, 5, { ...generic, session: "a" }),
      titleLine("a", "ai-title", "Ai said something"),
      titleLine("a", "custom-title", "Command Center rollout zq"),
      ...pair(t0, 5, { ...generic, session: "b" }),
      titleLine("b", "ai-title", "Fix flaky login tests"),
      ...pair(t0, 5, { ...generic, session: "c" }),
      titleLine("c", "ai-title", `Look at C:\\Users\\person\\secret ${S}`),
      ...pair(t0, 5, { ...generic, session: "d" }),
    ]);
    const map = path.join(dir, "map.json");
    writeFileSync(map, JSON.stringify({ rules: [{ initiative: "cc", titleMatch: "command center" }, { initiative: "pinned", sessionId: "d" }] }));
    const out = path.join(dir, "out", "d.json");
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--map", map, "--no-llm"], capture().deps)).toBe(0);
    const entries = JSON.parse(readFileSync(out, "utf8")).entries as Entry[];
    const bySession = new Map(entries.map((e) => [e.session, e]));
    expect(bySession.get("a")).toMatchObject({ initiative: "cc", mappedBy: "rule 1 (titleMatch)" });
    expect(bySession.get("d")).toMatchObject({ initiative: "pinned", mappedBy: "rule 2 (sessionId)" });
    expect(bySession.get("b")).toMatchObject({ initiative: "unassigned" });
    const tpl = JSON.parse(readFileSync(path.join(dir, "out", "d.map-template.json"), "utf8"));
    // c's title had a path, so it was masked and left out of the list.
    expect(tpl.titles).toEqual(["Fix flaky login tests"]);
    const all = allFilesText(dir);
    expect(all).not.toContain(S);
    expect(all).not.toContain("rollout zq");
    expect(all).not.toContain("Ai said something");
  });

  it("sync rules match by title and sessionId too", () => {
    const t0 = NOW - 2 * HOUR;
    const rules = validateMap({ rules: [{ initiative: "cc", titleMatch: "/command\\s+center/" }, { initiative: "pin", sessionId: "s9" }] });
    const base = { firstMs: t0, lastMs: t0, cwd: "/w", repo: "w", branch: "main", finished: false, question: null, userTurns: 1 };
    const states = [
      { ...base, session: "s1", rawTitle: "Command  Center work", plan: [{ text: "x", status: "pending" }] },
      { ...base, session: "s9", rawTitle: "Other", plan: null },
    ];
    const { groups } = groupSessions(states, rules);
    expect(groups.map((g) => [g.id, g.mappedBy])).toEqual([
      ["cc", "rule 1 (titleMatch)"],
      ["pin", "rule 2 (sessionId)"],
    ]);
  });

  it("--map-from-sync assigns blocks of a session to its initiative in the sync draft when no --map rule matched", async () => {
    const t0 = NOW - 10 * HOUR;
    writeTranscript([
      ...["a", "b", "c", "d"].flatMap((s) => pair(t0, 5, { session: s })),
      // e is not in the sync draft (sync kept one session per title), but its title matches a record's.
      ...pair(t0, 5, { session: "e" }),
      titleLine("e", "ai-title", "login  REWORK!"),
    ]);
    const sync = path.join(dir, "sync.json");
    writeFileSync(
      sync,
      JSON.stringify({
        v: 1,
        kind: "bab-cc-backfill-draft",
        entries: [],
        current: [
          { id: "login-rework", title: "Login rework", key: "KEY-4", include: true, sessions: ["a", "b"] },
          { id: "left-out", title: "Not chosen", include: false, sessions: ["c"] },
        ],
      }),
    );
    const map = path.join(dir, "map.json");
    writeFileSync(map, JSON.stringify({ rules: [{ initiative: "pinned", sessionId: "b" }] }));
    const out = path.join(dir, "d.json");
    expect(await run(["draft", "--projects-dir", projects, "--out", out, "--map", map, "--map-from-sync", sync, "--no-llm"], capture().deps)).toBe(0);
    const bySession = new Map((JSON.parse(readFileSync(out, "utf8")).entries as Entry[]).map((e) => [e.session, e]));
    expect(bySession.get("a")).toMatchObject({ initiative: "login-rework", title: "Login rework", key: "KEY-4", mappedBy: "sync login-rework" });
    expect(bySession.get("b")).toMatchObject({ initiative: "pinned", mappedBy: "rule 1 (sessionId)" });
    expect(bySession.get("c")).toMatchObject({ initiative: "unassigned", mappedBy: "none" });
    expect(bySession.get("d")).toMatchObject({ initiative: "unassigned" });
    expect(bySession.get("e")).toMatchObject({ initiative: "login-rework", mappedBy: "sync login-rework (title)" });
    // A file that is not a sync draft, a reserved id, or a bad session id is refused before anything is drafted.
    for (const bad of [
      { v: 1, kind: "bab-cc-backfill-draft", entries: [] },
      { v: 1, kind: "bab-cc-backfill-draft", current: [{ id: "unassigned", include: true, sessions: ["a"] }] },
      { v: 1, kind: "bab-cc-backfill-draft", current: [{ id: "ok", include: true, sessions: [5] }] },
    ]) {
      writeFileSync(sync, JSON.stringify(bad));
      const c = capture();
      expect(await run(["draft", "--projects-dir", projects, "--out", out, "--map-from-sync", sync, "--no-llm"], c.deps)).toBe(2);
      expect(c.err.join("\n")).toMatch(/sync draft/);
    }
  });
});
