import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-stats-"));
  process.env.DATA_DIR = dataDir;
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  delete process.env.DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("liveNumbers", () => {
  it("is all zeros on an empty brain", async () => {
    const { liveNumbers } = await import("../lib/stats");
    expect(liveNumbers()).toEqual({ learnings: 0, people: 0, conversations: 0 });
  });

  it("counts active learnings, people and threads, not archived or deleted learnings", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u2', 'c.d@example.com', 'C D')").run();
    const ins = db.prepare(
      "INSERT INTO learnings (id, author_id, title, body, tags, status) VALUES (?, 'u1', ?, 'b', '[]', ?)",
    );
    ins.run("l1", "one", "active");
    ins.run("l2", "two", "active");
    ins.run("l3", "three", "archived");
    ins.run("l4", "four", "deleted");
    db.prepare("INSERT INTO threads (id, subject, created_by) VALUES ('t1', 's', 'u1')").run();

    const { liveNumbers } = await import("../lib/stats");
    expect(liveNumbers()).toEqual({ learnings: 2, people: 2, conversations: 1 });
  });
});

describe("topTags", () => {
  it("counts tags over active memories only, most used first", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    const ins = db.prepare("INSERT INTO learnings (id, author_id, title, body, tags, status) VALUES (?, 'u1', ?, 'b', ?, ?)");
    ins.run("l1", "one", '["marketing","campaigns"]', "active");
    ins.run("l2", "two", '["marketing","brand"]', "active");
    ins.run("l3", "three", '["sales"]', "archived");
    ins.run("l4", "four", "not json", "active");

    const { topTags } = await import("../lib/stats");
    expect(topTags()).toEqual([
      { tag: "marketing", n: 2 },
      { tag: "brand", n: 1 },
      { tag: "campaigns", n: 1 },
    ]);
    expect(topTags(1)).toEqual([{ tag: "marketing", n: 2 }]);
  });
});

describe("topProjects", () => {
  it("counts projects over active memories only, most used first", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    const ins = db.prepare(
      "INSERT INTO learnings (id, author_id, title, body, tags, project, status) VALUES (?, 'u1', ?, 'b', '[]', ?, ?)",
    );
    ins.run("l1", "one", "bab", "active");
    ins.run("l2", "two", "bab", "active");
    ins.run("l3", "three", "bab", "archived");
    ins.run("l4", "four", "forge2", "active");
    ins.run("l5", "five", null, "active");

    const { topProjects } = await import("../lib/stats");
    expect(topProjects()).toEqual([
      { project: "bab", n: 2 },
      { project: "forge2", n: 1 },
    ]);
    expect(topProjects(1)).toEqual([{ project: "bab", n: 2 }]);
  });
});

describe("topAuthors", () => {
  it("counts authors over active memories only, most used first, by stored name", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u2', 'c.d@example.com', 'C D')").run();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u3', 'e.f@example.com', NULL)").run();
    const ins = db.prepare(
      "INSERT INTO learnings (id, author_id, title, body, tags, status) VALUES (?, ?, ?, 'b', '[]', ?)",
    );
    ins.run("l1", "u1", "one", "active");
    ins.run("l2", "u1", "two", "active");
    ins.run("l3", "u1", "three", "archived");
    ins.run("l4", "u2", "four", "active");
    ins.run("l5", "u3", "five", "active");

    const { topAuthors } = await import("../lib/stats");
    expect(topAuthors()).toEqual([
      { authorId: "u1", name: "A B", n: 2 },
      { authorId: "u2", name: "C D", n: 1 },
      { authorId: "u3", name: "u3", n: 1 },
    ]);
    expect(topAuthors(1)).toEqual([{ authorId: "u1", name: "A B", n: 2 }]);
  });

  it("never lists a registered user with no active memories", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u2', 'ghost@example.com', 'Ghost')").run();

    const { topAuthors } = await import("../lib/stats");
    expect(topAuthors()).toEqual([]);
  });
});
