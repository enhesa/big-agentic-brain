// Runs the agent's bash commands. With bubblewrap the repo is the only visible writable path (mounted at /work),
// there is no network and the environment is cleared, so hidden tests and reference fixes are unreachable.
// Without bubblewrap (e.g. a CI runner that forbids user namespaces) commands run in the workspace with a cleared env.
import { spawn, spawnSync } from "node:child_process";

let probed;
export function bwrapAvailable() {
  if (probed === undefined) {
    const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "true"], { stdio: "ignore" });
    probed = r.status === 0;
  }
  return probed;
}

const trunc = (s, n = 10_000) => (s.length <= n ? s : `${s.slice(0, n / 2)}\n...[${s.length - n} chars truncated]...\n${s.slice(-n / 2)}`);

export function sandboxMode(requested) {
  if (requested === "none") return "none";
  if (bwrapAvailable()) return "bwrap";
  if (requested === "bwrap") throw new Error("--sandbox bwrap requested but bubblewrap is not usable here");
  return "none";
}

export function workdirFor(mode, ws) {
  return mode === "bwrap" ? "/work" : ws;
}

/** Returns { text, isError }. */
export function runBash(mode, ws, command, timeoutMs = 120_000) {
  const baseEnv = { HOME: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };
  let cmd, args, opts;
  if (mode === "bwrap") {
    cmd = "bwrap";
    args = [
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64", "--ro-bind", "/etc", "/etc", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--bind", ws, "/work", "--chdir", "/work", "--unshare-all", "--die-with-parent",
      "--clearenv", ...Object.entries(baseEnv).flatMap(([k, v]) => ["--setenv", k, v]),
      "bash", "-lc", command,
    ];
    opts = {};
  } else {
    cmd = "bash";
    args = ["-lc", command];
    opts = { cwd: ws, env: { ...baseEnv, PATH: process.env.PATH ?? baseEnv.PATH } };
  }
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") resolve({ text: trunc(`TIMEOUT after ${timeoutMs / 1000}s\n${out}`), isError: true });
      else resolve({ text: trunc(`exit_code=${code}\n${out}`), isError: code !== 0 });
    });
  });
}
