// Global setup for the e2e suite: builds (unless skipped/fresh), starts the
// standalone server the same way the Dockerfile runtime stage does, waits
// for /healthz, hands the origin + tmp DATA_DIR to the test files via env
// vars, and tears the server down after the run.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync, cpSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { ACME_ENV } from "../setup-env";

const ROOT = process.cwd();
const STANDALONE_DIR = path.join(ROOT, ".next", "standalone");
const STANDALONE_SERVER = path.join(STANDALONE_DIR, "server.js");

function newestMtimeMs(dir: string): number {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true } as never)) {
    // node's recursive readdir typing varies by version; guard defensively.
    const e = entry as unknown as { name: string; parentPath?: string; path?: string };
    const full = e.parentPath ? path.join(e.parentPath, e.name) : path.join(dir, e.name);
    try {
      const m = statSync(full).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      // file disappeared mid-scan, ignore
    }
  }
  return newest;
}

function sourceIsNewerThanBuild(): boolean {
  if (!existsSync(STANDALONE_SERVER)) return true;
  const buildMtime = statSync(STANDALONE_SERVER).mtimeMs;
  const sourceDirs = ["app", "lib", "content", "public"].map((d) => path.join(ROOT, d));
  let newestSource = 0;
  for (const dir of sourceDirs) {
    newestSource = Math.max(newestSource, newestMtimeMs(dir));
  }
  return newestSource > buildMtime;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    srv.on("error", reject);
  });
}

async function waitForHealthz(origin: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/healthz`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms: ${String(lastErr)}`);
}

interface BootedServer {
  origin: string;
  dataDir: string;
  proc: ChildProcess;
}

const booted: BootedServer[] = [];

/** Starts one standalone server on a free port with its own DATA_DIR; extraEnv layers on top of the shared test env. */
export async function bootServer(extraEnv: Record<string, string> = {}): Promise<BootedServer> {
  const dir = mkdtempSync(path.join(tmpdir(), "bab-e2e-data-"));
  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;

  const proc = spawn(process.execPath, ["server.js"], {
    cwd: STANDALONE_DIR,
    env: {
      ...process.env,
      ...ACME_ENV,
      PORT: String(port),
      // Next's standalone server binds to $HOSTNAME when set; Git Bash on Windows
      // exports the machine name, which does not answer on 127.0.0.1.
      HOSTNAME: "127.0.0.1",
      DATA_DIR: dir,
      NODE_ENV: "production",
      // e2e hits the real handler chain. The proxy identity headers are trusted so the device tests can
      // act as a signed-in viewer; every other e2e file sends none, and X-Bab-Actor-* still
      // resolves identity for them.
      BAB_TRUST_PROXY_IDENTITY: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  proc.stdout?.on("data", (c) => (serverOutput += c.toString()));
  proc.stderr?.on("data", (c) => (serverOutput += c.toString()));
  proc.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      // Surface the tail of server output; helps diagnose a crash-on-boot.
      console.error(`[e2e] standalone server exited early (code=${code}, signal=${signal})`);
      console.error(serverOutput.slice(-4000));
    }
  });

  await waitForHealthz(origin);
  const server = { origin, dataDir: dir, proc };
  booted.push(server);
  return server;
}

export async function setup(): Promise<void> {
  const skipBuild = process.env.E2E_SKIP_BUILD === "1";
  const needsBuild = !skipBuild && sourceIsNewerThanBuild();

  if (needsBuild) {
    const result = spawnSync("pnpm", ["build"], { cwd: ROOT, stdio: "inherit", shell: true });
    if (result.status !== 0) {
      throw new Error(`pnpm build failed with exit code ${result.status}`);
    }
  }

  if (!existsSync(STANDALONE_SERVER)) {
    throw new Error(
      `No standalone server at ${STANDALONE_SERVER}. Run 'pnpm build' first, or unset E2E_SKIP_BUILD.`
    );
  }

  // Mirror the Dockerfile runtime stage: .next/static and public/ live next
  // to server.js in the standalone bundle (standalone tracing doesn't copy
  // them on its own).
  const staticSrc = path.join(ROOT, ".next", "static");
  const staticDest = path.join(STANDALONE_DIR, ".next", "static");
  if (existsSync(staticSrc)) cpSync(staticSrc, staticDest, { recursive: true });

  const publicSrc = path.join(ROOT, "public");
  const publicDest = path.join(STANDALONE_DIR, "public");
  if (existsSync(publicSrc)) cpSync(publicSrc, publicDest, { recursive: true });

  const main = await bootServer();
  const origin = main.origin;
  process.env.BAB_E2E_ORIGIN = origin;
  process.env.BAB_E2E_DATA_DIR = main.dataDir;

  // A second server with API tokens set, for tests/e2e/tokens.e2e.test.ts.
  const tokens = await bootServer({ BAB_API_TOKENS: "t1=alice.example@example.com", BAB_ORG_NAME: "Zeta Corp" });
  process.env.BAB_E2E_TOKENS_ORIGIN = tokens.origin;

  // Recipients must already exist as users (lib/messages.ts send() looks
  // them up and 400s with "Unknown recipient" otherwise) — a user row is
  // only created on that identity's own first request. Warm up the fixed
  // test identities so any test file can message any of them right away.
  const fixedIdentities = [
    { email: "alice.example@example.com", name: "Alice Example" },
    { email: "bob.example@example.com", name: "Bob Example" },
    { email: "carl.example@example.com", name: "Carl Example" },
  ];
  for (const actor of fixedIdentities) {
    await fetch(`${origin}/api/me`, {
      headers: { "X-Bab-Actor-Email": actor.email, "X-Bab-Actor-Name": actor.name },
    });
  }
}

export async function teardown(): Promise<void> {
  for (const server of booted) {
    if (!server.proc.killed) server.proc.kill();
  }
  await new Promise((r) => setTimeout(r, 200));
  for (const server of booted) {
    if (existsSync(server.dataDir)) {
      try {
        rmSync(server.dataDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}
