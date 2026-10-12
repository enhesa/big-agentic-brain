import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACME_ENV } from "../setup-env";

const STANDALONE_DIR = path.join(process.cwd(), ".next", "standalone");

describe("a bad configuration stops the server", () => {
  it("exits non-zero within 15 s and names BAB_ACCENT_COLOR on stderr", async () => {
    expect(existsSync(path.join(STANDALONE_DIR, "server.js"))).toBe(true);
    const dir = mkdtempSync(path.join(tmpdir(), "bab-e2e-cfgfail-"));
    try {
      const proc = spawn(process.execPath, ["server.js"], {
        cwd: STANDALONE_DIR,
        env: {
          ...process.env,
          ...ACME_ENV,
          PORT: "0",
          HOSTNAME: "127.0.0.1",
          DATA_DIR: dir,
          NODE_ENV: "production",
          BAB_ACCENT_COLOR: "red",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr?.on("data", (c) => (stderr += c.toString()));
      const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill();
          resolve({ code: null, timedOut: true });
        }, 15_000);
        proc.on("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, timedOut: false });
        });
      });
      expect(result.timedOut).toBe(false);
      expect(result.code).not.toBe(0);
      expect(stderr).toContain("BAB_ACCENT_COLOR");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
