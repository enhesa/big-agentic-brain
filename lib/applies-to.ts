import { ValidationError } from "./errors";

/**
 * "Applies to" labels: which stack or platform a memory holds for (migration v41,
 * learnings.applies_to). A memory such as "use IsEnabledForAsync" holds for dotnet only, and
 * without this it looks company-wide, so a Python or Node agent may follow it. Empty means it
 * applies everywhere. Separate from tags: a closed vocabulary an agent can match against its repo.
 *
 * The labels and their aliases live here; scripts/suggest-applies-to.mjs repeats the keyword
 * rules for the back-fill and points back at this file as the source of truth.
 */
export const STACK_LABELS = [
  "dotnet",
  "node",
  "typescript",
  "python",
  "angular",
  "react",
  "java",
  "go",
  "sql",
  "postgres",
  "sqlite",
  "elasticsearch",
  "kafka",
  "docker",
  "helm",
  "terraform",
] as const;

export const PLATFORM_LABELS = ["aks", "forge", "azure", "aws", "windows", "linux", "macos"] as const;

export const APPLIES_TO_LABELS: readonly string[] = [...STACK_LABELS, ...PLATFORM_LABELS];

/** Only a filter value (never stored, never a stack): matches memories with no label. */
export const EVERYWHERE = "everywhere";

const LABEL_SET = new Set<string>(APPLIES_TO_LABELS);

// Alias -> label. Keys are lowercase with spaces and underscores already folded to hyphens (see
// canonicalLabel). k8s and kubernetes mean AKS, the only Kubernetes the organization runs.
const ALIASES: Record<string, string> = {
  "c#": "dotnet",
  csharp: "dotnet",
  "c-sharp": "dotnet",
  ".net": "dotnet",
  net: "dotnet",
  "dot-net": "dotnet",
  "asp.net": "dotnet",
  aspnet: "dotnet",
  nuget: "dotnet",
  nodejs: "node",
  "node.js": "node",
  js: "node",
  javascript: "node",
  pnpm: "node",
  npm: "node",
  ts: "typescript",
  py: "python",
  python3: "python",
  angularjs: "angular",
  reactjs: "react",
  "react.js": "react",
  golang: "go",
  postgresql: "postgres",
  pg: "postgres",
  psql: "postgres",
  elastic: "elasticsearch",
  es: "elasticsearch",
  opensearch: "elasticsearch",
  tf: "terraform",
  k8s: "aks",
  kubernetes: "aks",
  "azure-kubernetes-service": "aks",
  win: "windows",
  win32: "windows",
  mac: "macos",
  osx: "macos",
  "mac-os": "macos",
  ubuntu: "linux",
};

/** The canonical label for a raw value (alias or label, any case), or null when it is not one. */
export function canonicalLabel(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!key) return null;
  if (LABEL_SET.has(key)) return key;
  return ALIASES[key] ?? null;
}

function unknownMessage(bad: string[]): string {
  return (
    `Unknown appliesTo value${bad.length > 1 ? "s" : ""}: ${bad.map((b) => JSON.stringify(b)).join(", ")}. ` +
    `Valid: stack: ${STACK_LABELS.join(", ")}; platform: ${PLATFORM_LABELS.join(", ")}. ` +
    `To suggest a new label, use bab_feedback.`
  );
}

/** A list from an array of strings or a comma-separated string; anything else is refused. */
function toList(raw: unknown, field: string): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => {
      if (typeof v !== "string") throw new ValidationError(`${field} must be a list of text labels`);
      return v;
    });
  }
  if (typeof raw === "string") return raw.split(",");
  throw new ValidationError(`${field} must be a list of text labels`);
}

function dedupe(labels: string[]): string[] {
  return [...new Set(labels)];
}

/**
 * The `appliesTo` of a write (bab_learn, POST /api/learnings). Absent is `undefined` (a correction
 * then inherits); null or an empty list is `[]` (applies everywhere, on purpose). Aliases are
 * normalised (c# -> dotnet); an unknown label is refused with the list of valid ones, never
 * dropped, so a typo does not silently widen a memory to everywhere.
 */
export function parseAppliesTo(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  const items = toList(raw, "appliesTo")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad: string[] = [];
  const labels: string[] = [];
  for (const item of items) {
    const label = canonicalLabel(item);
    if (label) labels.push(label);
    else bad.push(item);
  }
  if (bad.length > 0) throw new ValidationError(unknownMessage(bad));
  return dedupe(labels);
}

/**
 * The `appliesTo` search filter: labels, or "everywhere" for memories with none. Absent or blank is
 * no filter. An unknown value is refused, like a bad kind: a typo must not read as "unfiltered".
 */
export function parseAppliesToFilter(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const items = toList(raw, "appliesTo")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return undefined;
  const bad: string[] = [];
  const labels: string[] = [];
  for (const item of items) {
    if (item.toLowerCase() === EVERYWHERE) labels.push(EVERYWHERE);
    else {
      const label = canonicalLabel(item);
      if (label) labels.push(label);
      else bad.push(item);
    }
  }
  if (bad.length > 0) throw new ValidationError(unknownMessage(bad));
  return dedupe(labels);
}

/**
 * The caller's stack for bab_search / GET /api/learnings `stack`. Lenient on purpose: a repo may
 * well use something outside the vocabulary (rust), and refusing it would kill the search. Aliases
 * are normalised and unknown values are dropped; nothing usable is `undefined` (no ranking).
 */
export function parseStack(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  let items: string[];
  try {
    items = toList(raw, "stack");
  } catch {
    return undefined;
  }
  const labels = dedupe(items.map(canonicalLabel).filter((l): l is string => l !== null));
  return labels.length > 0 ? labels : undefined;
}

/** The labels stored on a row (`applies_to`, a JSON array): never throws, [] for anything unreadable. */
export function readAppliesTo(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** True when the memory applies everywhere, or at least one of its labels is in the stack. */
export function matchesStack(labels: readonly string[], stack: readonly string[]): boolean {
  return labels.length === 0 || labels.some((l) => stack.includes(l));
}

/**
 * What a search hit carries: its labels always, and, when the caller passed a stack that it does
 * not match, `stackMismatch: true` and a hint. The hit is kept, only ranked later.
 */
export function appliesToFields(
  row: { applies_to?: string | null },
  stack?: readonly string[],
): { appliesTo: string[]; stackMismatch?: true; stackHint?: string } {
  const appliesTo = readAppliesTo(row.applies_to);
  if (!stack || stack.length === 0 || matchesStack(appliesTo, stack)) return { appliesTo };
  return {
    appliesTo,
    stackMismatch: true,
    stackHint: `for ${appliesTo.join(", ")}, not your stack: weigh, don't follow`,
  };
}

/**
 * The union of the labels of several memories being merged (a consolidation). One that applies
 * everywhere makes the merge apply everywhere: narrowing it to the others' labels would hide the
 * fact from stacks it held for.
 */
export function mergeAppliesTo(lists: readonly (readonly string[])[]): string[] {
  if (lists.length === 0 || lists.some((l) => l.length === 0)) return [];
  return dedupe(lists.flat());
}

// The SQL below inlines labels as literals. That is safe only because every label reaching it went
// through canonicalLabel (a closed vocabulary of [a-z]+); the guard makes a slip fail loudly.
function literal(label: string): string {
  if (!LABEL_SET.has(label)) throw new Error(`not an appliesTo label: ${label}`);
  return `'%"${label}"%'`;
}

/** SQL for "carries one of these labels" (or none at all, for "everywhere"). `prefix` is a table alias such as "learnings.". */
export function appliesToFilterSql(labels: readonly string[], prefix = ""): string {
  const parts = labels.map((l) =>
    l === EVERYWHERE ? `${prefix}applies_to = '[]'` : `${prefix}applies_to LIKE ${literal(l)}`,
  );
  return `(${parts.join(" OR ")})`;
}

/**
 * An ORDER BY term that puts memories that fit the stack (no labels, or a shared one) before the
 * rest. Done in SQL, not by re-sorting a page, so paging and `total` stay consistent. Empty string
 * when there is no stack.
 */
export function stackRankSql(stack: readonly string[] | undefined, prefix = ""): string {
  if (!stack || stack.length === 0) return "";
  const parts = [`${prefix}applies_to = '[]'`, ...stack.map((l) => `${prefix}applies_to LIKE ${literal(l)}`)];
  return `CASE WHEN ${parts.join(" OR ")} THEN 0 ELSE 1 END`;
}
