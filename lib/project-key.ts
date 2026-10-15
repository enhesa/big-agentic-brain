import { ValidationError } from "./errors";
import { config } from "./config";

/**
 * The project key: the scope a memory belongs to (a repo, a client, a campaign, a
 * product, a system). Its own module because BOTH the write path (lib/learnings.ts) and
 * the v9 migration's backfill (lib/db.ts) need it, and lib/learnings.ts imports lib/db.ts,
 * so putting it in either one would make a cycle or a second copy that drifts.
 */
const PROJECT_MAX = 80;
const PROJECT_DISALLOWED_RE = /[^a-z0-9.-]/g;
/** An agent sent the literal text instead of omitting the field (seen in production: a
 *  stored project of "null"). Treated as no project, same as absent/blank. */
const NULLISH_PROJECT_LITERALS = new Set(["null", "undefined", "none"]);

/**
 * Reserved filter value for "no project set" (the company-wide bucket): never a real
 * normalized key, because normalizeProjectKey() converts every underscore to a hyphen
 * before checking for disallowed characters, so a leading underscore can never survive
 * into a stored value. Recognized as-is (not run through normalizeProjectKey) by every
 * project filter: GET /api/learnings, bab_search, and the /memory project select.
 */
export const GENERAL_PROJECT_KEY = "_general";

/** Company prefixes a repo slug carries but a folder name does not (`acme.bab` vs the
 *  checkout folder `bab`). Stripped so both spellings land on one project. */
/** The canonical rule, applied to an already-cleaned key: no trailing `.git`, no company
 *  prefix. Each strip only happens when something is left, so `acme` stays `acme`. */
function canonicalise(key: string): string {
  // Looped until nothing changes, so canonicalise(canonicalise(x)) === canonicalise(x):
  // `acme.acme.bab` must not need two passes to reach `bab`.
  let out = key;
  for (let changed = true; changed; ) {
    const before = out;
    if (out.endsWith(".git") && out.length > ".git".length) out = out.slice(0, -".git".length);
    for (const prefix of config().projectKeyPrefixes) {
      if (out.startsWith(prefix) && out.length > prefix.length) {
        out = out.slice(prefix.length);
        break;
      }
    }
    out = out.replace(/^[-.]+|[-.]+$/g, "") || out;
    changed = out !== before;
  }
  return out;
}

export function normalizeProjectKey(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (NULLISH_PROJECT_LITERALS.has(trimmed.toLowerCase())) return null;

  const key = trimmed
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(PROJECT_DISALLOWED_RE, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_MAX)
    .replace(/^-+|-+$/g, "");

  if (!key) {
    throw new ValidationError("project must contain at least one letter, number, '.' or '-'");
  }
  // Done here, not only in the derive helpers, so every write path and every filter path
  // (bab_search, GET /api/learnings, the /memory select) canonicalises the same way.
  return canonicalise(key);
}

/** Alias that says what normalizeProjectKey() guarantees: the one canonical key per project. */
export function canonicalProjectKey(raw: string | null | undefined): string | null {
  return normalizeProjectKey(raw);
}

/** A repo URL or slug reduced to its project key: last segment, no .git, normalised.
 *  Best effort: a repo that normalises to nothing simply has no project. */
export function deriveProjectFromRepo(repo: string): string | null {
  const withoutTrailingSlash = repo.replace(/\/+$/, "");
  const lastSegment = withoutTrailingSlash.split("/").pop() ?? "";
  // normalizeProjectKey() strips .git and the configured company prefix, so `acme.bab` gives `bab`.
  try {
    return canonicalProjectKey(lastSegment);
  } catch {
    return null;
  }
}

/**
 * The project a working directory belongs to, for the first-prompt nudge. Handles the
 * shapes the desktop app and CLI actually report, Windows or POSIX:
 *   .../bab                                  -> bab
 *   .../bab/.claude/worktrees/some-branch    -> bab   (worktree of a repo)
 *   .../_worktrees/bab-fix-count             -> bab-fix-count (used as is on purpose:
 *                                               guessing where the repo name ends is worse
 *                                               than a miss)
 * Returns null for anything odd and never throws: this runs on a hook that must always
 * answer.
 */
export function projectKeyFromCwd(cwd: string | null | undefined): string | null {
  if (typeof cwd !== "string") return null;
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return null;

  let chosen: string | undefined;
  const claudeAt = segments.findIndex((s, i) => s === ".claude" && segments[i + 1] === "worktrees");
  if (claudeAt > 0) {
    chosen = segments[claudeAt - 1];
  } else {
    const wtAt = segments.indexOf("_worktrees");
    chosen = wtAt >= 0 && segments[wtAt + 1] ? segments[wtAt + 1] : segments[segments.length - 1];
  }
  try {
    return canonicalProjectKey(chosen);
  } catch {
    return null;
  }
}
