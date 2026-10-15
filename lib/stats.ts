import { getDb } from "@/lib/db";

/** What is in the brain right now. Honest numbers for the landing page, nothing invented. */
export interface LiveNumbers {
  learnings: number;
  people: number;
  conversations: number;
}

function count(sql: string): number {
  const row = getDb().prepare(sql).get() as { n: number | bigint } | undefined;
  return Number(row?.n ?? 0);
}

export function liveNumbers(): LiveNumbers {
  return {
    learnings: count("SELECT count(*) AS n FROM learnings WHERE status = 'active'"),
    people: count("SELECT count(*) AS n FROM users"),
    conversations: count("SELECT count(*) AS n FROM threads"),
  };
}

/** The most-used tags across active memories, for the filter chips on /memory. */
export function topTags(limit = 12): Array<{ tag: string; n: number }> {
  const rows = getDb()
    .prepare("SELECT tags FROM learnings WHERE status = 'active'")
    .all() as Array<{ tags: string }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    let tags: unknown;
    try {
      tags = JSON.parse(r.tags || "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(tags)) continue;
    for (const t of tags) if (typeof t === "string" && t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, n]) => ({ tag, n }))
    .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
    .slice(0, Math.max(0, limit));
}

/** The most-used projects across active memories, for the filter chips on /memory. */
export function topProjects(limit = 12): Array<{ project: string; n: number }> {
  const rows = getDb()
    .prepare("SELECT project FROM learnings WHERE status = 'active' AND project IS NOT NULL")
    .all() as Array<{ project: string }>;
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.project) counts.set(r.project, (counts.get(r.project) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([project, n]) => ({ project, n }))
    .sort((a, b) => b.n - a.n || a.project.localeCompare(b.project))
    .slice(0, Math.max(0, limit));
}

/**
 * Count of active memories with no project set — the "General" bucket on
 * /memory's project filter (docs/spec.md: "Company-wide memories have none").
 */
export function generalProjectCount(): number {
  return count(
    "SELECT count(*) AS n FROM learnings WHERE status = 'active' AND project IS NULL",
  );
}

/**
 * Authors who actually have active memories, most first, for the author filter
 * on /memory. Deliberately NOT `listUsers()` + `learningCountsByAuthor()` (lib/users.ts):
 * those cover every registered user, including ones with zero memories, and this filter
 * must only ever offer someone worth filtering by.
 */
export function topAuthors(limit = 12): Array<{ authorId: string; name: string; n: number }> {
  const rows = getDb()
    .prepare(
      `SELECT l.author_id AS authorId, u.name AS name, COUNT(*) AS n
       FROM learnings l
       LEFT JOIN users u ON u.id = l.author_id
       WHERE l.status = 'active'
       GROUP BY l.author_id`,
    )
    .all() as Array<{ authorId: string; name: string | null; n: number | bigint }>;
  return rows
    .map((r) => ({ authorId: r.authorId, name: r.name ?? r.authorId, n: Number(r.n) }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit));
}
