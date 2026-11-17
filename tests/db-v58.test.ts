import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Migration v58 adds trust_events, the validation history of a memory (lib/trust.ts), and copies
 * what votes and supersession_links still hold into it, marked backfilled. Running it twice adds
 * nothing.
 */

let dataDir: string;
const AUTHOR = "ada.author@example.com";
const BOB = "bob.b@example.com";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-db-v58-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

type Db = ReturnType<typeof import("../lib/db").getDb>;

/** Put the database back to how v57 left it (no trust_events), so reopening runs v58 for real. */
async function rewindAndReopen(db: Db, drop: boolean): Promise<Db> {
  if (drop) db.exec("DROP TABLE trust_events");
  db.prepare("DELETE FROM migrations WHERE version >= 58").run();
  const { _resetDbForTests, getDb } = await import("../lib/db");
  _resetDbForTests();
  return getDb();
}

async function seed() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: AUTHOR, email: AUTHOR, name: "Ada Author", roles: [] });
  upsertUser({ id: BOB, email: BOB, name: "Bob B", roles: [] });
  const { create, createWithSupersedes, confirm, flag, keepLearning } = await import("../lib/learnings");
  const a = create({ authorId: AUTHOR, title: "Old webhook rule zqa", body: "Body zqa", confirmNotDuplicate: true });
  const b = create({ authorId: AUTHOR, title: "Queue container rule zqb", body: "Body zqb", confirmNotDuplicate: true });
  confirm(b.id, BOB, "Checked in the repo", "mcp");
  keepLearning(b.id, AUTHOR, "mcp", "Still true");
  flag(a.id, BOB, "mcp", "Wrong hash");
  const c = createWithSupersedes({ authorId: BOB, title: "New webhook rule zqc", body: "Body zqc", confirmNotDuplicate: true }, [a.id], "mcp");
  // Votes that are not validation stay out of the history.
  const { vote } = await import("../lib/learnings");
  vote(c.id, AUTHOR, "helpful", "mcp");
  return { a, b, c };
}

const events = (db: Db) =>
  db
    .prepare("SELECT learning_id, actor_id, kind, by_author, note, related_id, backfilled FROM trust_events ORDER BY learning_id, kind")
    .all() as Array<Record<string, unknown>>;

describe("migration v58: trust_events", () => {
  it("backfills confirm, flag, keep and supersede from older records, marked backfilled", async () => {
    const { getDb } = await import("../lib/db");
    const { a, b, c } = await seed();
    const after = await rewindAndReopen(getDb(), true);
    expect(after.prepare("SELECT 1 FROM migrations WHERE version = 58").get()).toBeTruthy();
    const rows = events(after);
    expect(rows).toEqual(
      [
        { learning_id: a.id, actor_id: BOB, kind: "flag", by_author: 0, note: "Wrong hash", related_id: null, backfilled: 1 },
        { learning_id: a.id, actor_id: BOB, kind: "supersede", by_author: 0, note: null, related_id: c.id, backfilled: 1 },
        { learning_id: b.id, actor_id: BOB, kind: "confirm", by_author: 0, note: "Checked in the repo", related_id: null, backfilled: 1 },
        { learning_id: b.id, actor_id: AUTHOR, kind: "keep", by_author: 1, note: "Still true", related_id: null, backfilled: 1 },
      ].sort((x, y) => (x.learning_id + x.kind).localeCompare(y.learning_id + y.kind)),
    );
  });

  it("adds nothing when it runs again", async () => {
    const { getDb } = await import("../lib/db");
    await seed();
    const once = await rewindAndReopen(getDb(), true);
    const n = events(once).length;
    const twice = await rewindAndReopen(once, false);
    expect(events(twice).length).toBe(n);
  });

  it("shows the backfilled rows in the history with the backfilled mark", async () => {
    const { getDb } = await import("../lib/db");
    const { b } = await seed();
    await rewindAndReopen(getDb(), true);
    const { trustHistory } = await import("../lib/trust");
    const h = trustHistory(b.id);
    expect(h.map((e) => [e.kind, e.backfilled])).toEqual(expect.arrayContaining([["confirm", true], ["keep", true]]));
  });
});
