import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-todos-gaps-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seedUser() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "owner-1", email: "a@example.com", name: "Ada", roles: [] });
}

describe("todos.listMine 'done' tab", () => {
  it("lists both done and abandoned todos, newest-updated first", async () => {
    await seedUser();
    const { create, complete, abandon, listMine } = await import("../lib/todos");

    const t1 = create({ ownerId: "owner-1", title: "First" });
    const t2 = create({ ownerId: "owner-1", title: "Second" });
    complete(t1.id, "owner-1");
    abandon(t2.id, "owner-1");

    const done = listMine("owner-1", "done");
    expect(done.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    expect(done.every((t) => t.status === "done" || t.status === "abandoned")).toBe(true);
  });

  it("excludes open todos from the done tab", async () => {
    await seedUser();
    const { create, listMine } = await import("../lib/todos");
    create({ ownerId: "owner-1", title: "Still open" });

    expect(listMine("owner-1", "done")).toEqual([]);
  });
});

describe("todos related_key redaction", () => {
  it("redacts a secret in related_key on create and keeps it redacted in listMine output", async () => {
    await seedUser();
    const { create, listMine } = await import("../lib/todos");
    const bearer = ["Bearer ", "abc123.def456-ghi"].join("");
    create({ ownerId: "owner-1", title: "Rotate", relatedKey: bearer });

    const open = listMine("owner-1", "open");
    expect(open[0].related_key).toContain("[redacted]");
    expect(open[0].related_key).not.toContain("abc123");
  });
});
