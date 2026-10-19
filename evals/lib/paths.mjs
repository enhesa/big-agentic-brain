import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVALS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.dirname(EVALS_DIR);
export const TASKS_DIR = path.join(EVALS_DIR, "tasks");
export const FIXTURES_DIR = path.join(EVALS_DIR, "fixtures");
