import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVALS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.dirname(EVALS_DIR);
export const TASKS_DIR = path.join(EVALS_DIR, "tasks");
/** Benchmark suites: core (bugs the repo itself reveals) and tk (team knowledge: the fix needs a fact that is not in the repo). */
export const SUITES = { core: TASKS_DIR, tk: path.join(EVALS_DIR, "tasks-tk") };
export const FIXTURES_DIR = path.join(EVALS_DIR, "fixtures");

/**
 * Scratch root for workspaces and run outputs — always outside the repo/tasks tree so an
 * unsandboxed agent cannot climb into hidden/ or oracle/ via relative paths.
 * Override with BAB_EVAL_SCRATCH. Defaults to $TMPDIR/bab-evals-<user>.
 */
export function scratchRoot() {
  const override = process.env.BAB_EVAL_SCRATCH;
  const root = override
    ? path.resolve(override)
    : path.join(os.tmpdir(), `bab-evals-${process.env.USER || process.env.LOGNAME || "user"}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}
