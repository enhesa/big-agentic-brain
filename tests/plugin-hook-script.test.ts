import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("plugins/claude-code/scripts/bab-hook.sh");
const HOOKS = path.resolve("plugins/claude-code/hooks/hooks.json");
// The script needs sh and curl, as the plugin does; skip where a runner has neither.
const hasTools = spawnSync("sh", ["-c", "command -v curl"]).status === 0;

describe("hooks.json", () => {
  it("runs every hook through bab-hook.sh, with the URL from the environment", () => {
    const config = JSON.parse(readFileSync(HOOKS, "utf8")) as { hooks: Record<string, { hooks: { command: string; args?: unknown }[] }[]> };
    const commands = Object.values(config.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
    expect(commands.length).toBe(3);
    for (const hook of commands) {
      expect(hook.command).toMatch(/^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/bab-hook\.sh" \d$/);
      // A shell-form command must not carry the setting: it is read from CLAUDE_PLUGIN_OPTION_BAB_URL.
      expect(hook.command).not.toContain("user_config");
      expect(hook.args).toBeUndefined();
    }
  });
});

describe.skipIf(!hasTools)("bab-hook.sh", () => {
  let server: http.Server;
  let base = "";
  let closedPort = 0;
  let calls = 0;
  let data = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls += 1;
        if (req.url === "/json/api/hook") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ echo: JSON.parse(body || "{}"), hookSpecificOutput: { additionalContext: "hi" } }));
        } else if (req.url === "/html/api/hook") {
          res.setHeader("Content-Type", "text/html");
          res.end("<html>Sign in to continue</html>");
        } else if (req.url === "/fake/api/hook") {
          res.setHeader("Content-Type", "application/json");
          res.end("<html>portal</html>");
        } else if (req.url === "/big/api/hook") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ x: "a".repeat(100_000) }));
        } else if (req.url === "/chunked/api/hook") {
          res.setHeader("Content-Type", "application/json");
          res.write('{"x":"');
          for (let i = 0; i < 10; i++) res.write("a".repeat(10_000));
          res.end('"}');
        } else if (req.url === "/error/api/hook") {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end('{"error":1}');
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A port that was free a moment ago: connecting to it is refused.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    if (data) rmSync(data, { recursive: true, force: true });
    data = mkdtempSync(path.join(tmpdir(), "bab-hook-"));
    calls = 0;
  });

  function run(
    url: string | undefined,
    input = '{"session_id":"s1","hook_event_name":"Stop"}',
    dataDir: string | null = data,
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.CLAUDE_PLUGIN_DATA;
      if (dataDir !== null) env.CLAUDE_PLUGIN_DATA = dataDir;
      delete env.CLAUDE_PLUGIN_OPTION_BAB_URL;
      if (url !== undefined) env.CLAUDE_PLUGIN_OPTION_BAB_URL = url;
      const child = spawn("sh", [SCRIPT, "3"], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  it("passes on a JSON answer, with the event posted as is", async () => {
    const out = await run(`${base}/json`);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ echo: { session_id: "s1", hook_event_name: "Stop" }, hookSpecificOutput: { additionalContext: "hi" } });
  });

  it("drops a trailing slash from the URL", async () => {
    expect(JSON.parse((await run(`${base}/json/`)).stdout).hookSpecificOutput.additionalContext).toBe("hi");
  });

  it.each(["html", "fake", "big", "chunked", "error", "missing"])("prints nothing for the %s answer", async (route) => {
    const out = await run(`${base}/${route}`);
    expect(out).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it.each([undefined, "", "ftp://example.com", 'https://example.com/"$(id)"', "https://example.com/a b"])("makes no call for the URL %j", async (url) => {
    const out = await run(url);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/^BAB hooks: the bab_url setting \(CLAUDE_PLUGIN_OPTION_BAB_URL\) is unset or not an http\(s\) URL/);
    expect(out.stderr.trim().split("\n")).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it("says once per quiet period that the URL is missing", async () => {
    expect((await run(undefined)).stderr).not.toBe("");
    expect(await run(undefined)).toEqual({ status: 0, stdout: "", stderr: "" });
    rmSync(path.join(data, "hook-no-url-until"));
    expect((await run(undefined)).stderr).not.toBe("");
  });

  it("skips the next calls for a while after a refused connection, then calls again once the mark expires", async () => {
    const first = await run(`http://127.0.0.1:${closedPort}`);
    expect(first).toEqual({ status: 0, stdout: "", stderr: "" });
    const stamp = path.join(data, "hook-offline-until");
    expect(existsSync(stamp)).toBe(true);
    const until = Number(readFileSync(stamp, "utf8"));
    expect(until - Date.now() / 1000).toBeGreaterThan(200);

    // BAB is back, but the mark still holds: no call.
    expect((await run(`${base}/json`)).stdout).toBe("");
    expect(calls).toBe(0);

    // Once the mark is gone, it calls BAB again.
    rmSync(stamp);
    expect((await run(`${base}/json`)).stdout).toContain("hookSpecificOutput");
    expect(calls).toBe(1);
  });

  it("ignores a mark further ahead than the quiet period", async () => {
    const stamp = path.join(data, "hook-offline-until");
    writeFileSync(stamp, String(Math.floor(Date.now() / 1000) + 10 * 365 * 86400));
    expect((await run(`${base}/json`)).stdout).toContain("hookSpecificOutput");
    expect(calls).toBe(1);
    expect(existsSync(stamp)).toBe(false);
  });

  it.each([null, "", "${CLAUDE_PLUGIN_DATA}"])("never skips and writes no mark without a plugin data folder (%j)", async (dataDir) => {
    const refused = await run(`http://127.0.0.1:${closedPort}`, undefined, dataDir);
    expect(refused).toEqual({ status: 0, stdout: "", stderr: "" });
    // The next call still goes out: there is no mark to skip on.
    expect((await run(`${base}/json`, undefined, dataDir)).stdout).toContain("hookSpecificOutput");
    expect(calls).toBe(1);
    expect(readdirSync(data)).toEqual([]);
  });

  it("does not write the mark through a link left in its place", async () => {
    const target = path.join(data, "target");
    writeFileSync(target, "keep");
    const stamp = path.join(data, "hook-offline-until");
    try {
      symlinkSync(target, stamp);
    } catch {
      return; // No symlink privilege on this machine.
    }
    await run(`http://127.0.0.1:${closedPort}`);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(lstatSync(stamp).isSymbolicLink()).toBe(false);
  });

  it("ignores a mark it cannot read", async () => {
    const stamp = path.join(data, "hook-offline-until");
    await run(`http://127.0.0.1:${closedPort}`);
    rmSync(stamp);
    writeFileSync(stamp, "junk");
    expect((await run(`${base}/json`)).stdout).toContain("hookSpecificOutput");
    expect(existsSync(stamp)).toBe(false);
  });
});
