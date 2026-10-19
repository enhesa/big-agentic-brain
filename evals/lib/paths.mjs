import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVALS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.dirname(EVALS_DIR);
export const TASKS_DIR = path.join(EVALS_DIR, "tasks");
/** Benchmark suites: core (bugs the repo itself reveals) and tk (team knowledge: the fix needs a fact that is not in the repo). */
export const SUITES = { core: TASKS_DIR, tk: path.join(EVALS_DIR, "tasks-tk") };
export const FIXTURES_DIR = path.join(EVALS_DIR, "fixtures");
