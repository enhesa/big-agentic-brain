// Throwaway BAB instances: the standalone Next build (`pnpm build`), one DATA_DIR per instance.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { REPO_ROOT } from "./paths.mjs";

export function standaloneDir(env = process.env) {
  return env.BAB_EVAL_STANDALONE ?? path.join(REPO_ROOT, ".next", "standalone");
}

export function assertBuilt(env = process.env) {
  const dir = standaloneDir(env);
  if (!fs.existsSync(path.join(dir, "server.js"))) {
    throw new Error(`No BAB build at ${dir}. Run \`pnpm build\` first (or set BAB_EVAL_STANDALONE).`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/** Start BAB on a fresh port. `seedFrom` is a data dir snapshot to copy first. Returns { origin, stop() }. */
export async function startBab({ dataDir, seedFrom, logFile }) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (seedFrom) fs.cpSync(seedFrom, dataDir, { recursive: true });
  else fs.mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET/.test(k)));
  Object.assign(env, { NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", DATA_DIR: dataDir, BAB_PUBLIC_ORIGIN: origin });
  const out = fs.openSync(logFile ?? path.join(dataDir, "..", `bab-${port}.log`), "w");
  const child = spawn(process.env.BAB_EVAL_NODE ?? process.execPath, ["server.js"], {
    cwd: standaloneDir(),
    env,
    stdio: ["ignore", out, out],
  });
  const deadline = Date.now() + 240_000; // generous: a loaded CI runner or shared box can be slow to boot Next
  for (;;) {
    if (child.exitCode !== null) throw new Error(`BAB exited with ${child.exitCode}; see ${logFile}`);
    try {
      const r = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`BAB did not become ready; see ${logFile}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    origin,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(() => child.kill("SIGKILL"), 10_000);
        child.once("exit", () => {
          clearTimeout(t);
          fs.closeSync(out);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}

/** POST /api/learnings as the given author. Returns the created learning. */
export async function postLearning(origin, author, learning) {
  const res = await fetch(`${origin}/api/learnings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bab-actor-email": author.email, "x-bab-actor-name": author.name },
    body: JSON.stringify({ confirmNotDuplicate: true, ...learning }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST /api/learnings ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.learning ?? body;
}
