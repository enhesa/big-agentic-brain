import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * bab-headers.sh is the plugin's headersHelper. Claude Code drops a helper that is too slow, and on
 * a loaded Windows machine every process start costs about a second, so once the device secret and
 * the label cache exist it must answer with shell builtins only, and print the same bytes as the
 * full path.
 */
const SCRIPT = path.resolve("plugins/claude-code/scripts/bab-headers.sh");
const hasSh = spawnSync("sh", ["-c", "true"]).status === 0;
const SECRET = "a".repeat(32) + "0123456789abcdef0123456789abcdef";

let dir: string;

/** Runs the helper. noCommands: PATH points nowhere, so any external command fails. */
function run(dataDir: string, noCommands = false): string {
  const script = noCommands ? 'p=$(command -v sh); PATH=/no-such-dir exec "$p" "$0" "$1"' : 'exec sh "$0" "$1"';
  const res = spawnSync("sh", ["-c", script, SCRIPT, dataDir], { encoding: "utf8", timeout: 120_000 });
  expect(res.status).toBe(0);
  return res.stdout;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bab-headers-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A loaded Windows runner takes seconds per process start; the full path starts about ten.
describe.skipIf(!hasSh)("bab-headers.sh", { timeout: 300_000 }, () => {
  it("creates a secret and a label cache on the first run, then answers the same without any external command", () => {
    const first = run(dir);
    const parsed = JSON.parse(first) as Record<string, string>;
    expect(parsed["X-Bab-Device"]).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed["X-Bab-Device-Label"]).toMatch(/^[A-Za-z0-9 ._-]{1,60}$/);
    expect(readFileSync(path.join(dir, "device-secret"), "utf8")).toBe(parsed["X-Bab-Device"]);
    const [host, label, rest] = readFileSync(path.join(dir, "device-label"), "utf8").split("\n");
    expect(label).toBe(parsed["X-Bab-Device-Label"]);
    expect(host.length).toBeGreaterThan(0);
    expect(rest).toBe("");
    expect(run(dir, true)).toBe(first);
    expect(run(dir)).toBe(first);
  });

  it("keeps an existing secret byte for byte when the label cache is new", () => {
    writeFileSync(path.join(dir, "device-secret"), `${SECRET}\n`);
    const out = run(dir);
    expect(JSON.parse(out)["X-Bab-Device"]).toBe(SECRET);
    expect(existsSync(path.join(dir, "device-label"))).toBe(true);
    expect(readFileSync(path.join(dir, "device-secret"), "utf8")).toBe(`${SECRET}\n`);
    expect(run(dir, true)).toBe(out);
  });

  it("takes the full path when the label cache is missing or the secret is not clean hex", () => {
    writeFileSync(path.join(dir, "device-secret"), SECRET);
    // No label cache and no commands: the full path runs and cannot name the machine.
    expect(run(dir, true)).not.toBe(run(dir));
    // A secret with spaces is cleaned by the full path, as before.
    writeFileSync(path.join(dir, "device-secret"), `${SECRET.slice(0, 10)} ${SECRET.slice(10)}`);
    expect(JSON.parse(run(dir))["X-Bab-Device"]).toBe(SECRET);
  });

  it("ignores a damaged label cache and rewrites it on the full path", () => {
    const good = run(dir);
    for (const bad of ['bad"label\\x', "x".repeat(61), ""]) {
      writeFileSync(path.join(dir, "device-label"), `host\n${bad}\n`);
      // No commands: the fast path refuses the cache, and the full path cannot name the machine.
      expect(run(dir, true)).not.toContain(bad || "never");
      expect(run(dir)).toBe(good);
    }
  });

  it("refuses a bad data dir as before", () => {
    expect(run("relative/dir")).toBe('{"X-Bab-Device-Error":"bad-dir"}');
    expect(run("${CLAUDE_PLUGIN_DATA}")).toBe('{"X-Bab-Device-Error":"bad-dir"}');
  });

  it("starts no process on the fast path: no $(...), backticks or pipes there", () => {
    const text = readFileSync(SCRIPT, "utf8");
    const start = text.indexOf("# Fast path:");
    const end = text.indexOf("# Windows-style paths");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const code = text
      .slice(start, end)
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      // case patterns such as `msys* | cygwin*)` are alternatives, not pipes
      .filter((l) => !/^\s*\S+( \| \S+)*\)/.test(l))
      .join("\n");
    expect(code).not.toContain("$(");
    expect(code).not.toContain("`");
    expect(code).not.toMatch(/[^|]\|[^|]/);
  });
});
