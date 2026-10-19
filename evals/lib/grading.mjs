// Task loading, fresh workspaces and grading. Grading restores the protected (test) paths from the pristine repo,
// adds the hidden tests and runs the task's grade command, so editing tests never makes a task pass.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SUITES } from "./paths.mjs";

let tasksDir = SUITES.core;
/** Select the benchmark suite (core or tk) the task helpers read from. */
export function useSuite(name) {
  if (!SUITES[name]) throw new Error(`unknown suite ${name}; use ${Object.keys(SUITES).join(" or ")}`);
  tasksDir = SUITES[name];
}

export function allTaskIds() {
  return fs
    .readdirSync(tasksDir)
    .filter((d) => fs.existsSync(path.join(tasksDir, d, "task.json")))
    .sort();
}

export function loadTask(id) {
  const dir = path.join(tasksDir, id);
  return { ...JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")), dir };
}

const SKIP = new Set([".git", "__pycache__", "node_modules"]);
const copyFilter = (src) => !SKIP.has(path.basename(src));

export function makeWorkspace(task, dest) {
  fs.cpSync(path.join(task.dir, "repo"), dest, { recursive: true, filter: copyFilter });
  spawnSync("bash", ["-c", "git init -q && git add -A && git -c user.email=eval@example.com -c user.name=eval commit -qm init"], {
    cwd: dest,
  });
  return dest;
}

export function applyOracle(task, ws) {
  fs.cpSync(path.join(task.dir, "oracle"), ws, { recursive: true, filter: copyFilter });
}

/** Returns { pass, output }. */
export async function grade(task, ws, timeoutMs = 180_000) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bab-grade-"));
  const g = path.join(tmp, "ws");
  try {
    fs.cpSync(ws, g, { recursive: true, filter: copyFilter });
    for (const p of task.protected) {
      fs.rmSync(path.join(g, p), { recursive: true, force: true });
      const src = path.join(task.dir, "repo", p);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(g, p), { recursive: true });
    }
    const hidden = path.join(task.dir, "hidden");
    if (fs.existsSync(hidden)) fs.cpSync(hidden, g, { recursive: true });
    return await new Promise((resolve) => {
      const child = spawn("bash", ["-c", task.grade_cmd], {
        cwd: g,
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: tmp, LANG: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ pass: code === 0 && !signal, output: (signal ? "GRADE TIMEOUT\n" : "") + out.slice(-4000) });
      });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
