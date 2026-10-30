import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-users-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("users.upsertUser", () => {
  it("inserts a new user on first call", async () => {
    const { upsertUser } = await import("../lib/users");
    const u = upsertUser({ id: "u1", email: "u1@example.com", name: "First Name", roles: ["member"] });
    expect(u.id).toBe("u1");
    expect(u.email).toBe("u1@example.com");
    expect(u.name).toBe("First Name");
  });

  it("updates email/roles/last_seen_at on repeat calls, but keeps the first-seen name", async () => {
    const { upsertUser } = await import("../lib/users");
    const first = upsertUser({ id: "u1", email: "old@example.com", name: "Old Name", roles: [] });

    const second = upsertUser({ id: "u1", email: "new@example.com", name: "New Name", roles: ["admin"] });
    expect(second.email).toBe("new@example.com");
    expect(second.name).toBe("Old Name");
    expect(second.roles).toBe("admin");
    expect(new Date(second.last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first.last_seen_at).getTime(),
    );

    const { getUser } = await import("../lib/users");
    expect(getUser("u1")!.email).toBe("new@example.com");
    expect(getUser("u1")!.name).toBe("Old Name");
  });

  it("records a name_mismatch audit action (both names) when a known id arrives with a different name", async () => {
    const { upsertUser } = await import("../lib/users");
    const { getDb } = await import("../lib/db");
    upsertUser({ id: "u1", email: "u1@example.com", name: "Old Name", roles: [] });
    upsertUser({ id: "u1", email: "u1@example.com", name: "New Name", roles: [] });

    const db = getDb();
    const rows = db
      .prepare("SELECT details FROM audit_log WHERE action = 'name_mismatch' AND actor_id = ?")
      .all("u1") as { details: string | null }[];
    expect(rows.length).toBe(1);
    const details = JSON.parse(rows[0].details ?? "{}");
    expect(details.storedName).toBe("Old Name");
    expect(details.incomingName).toBe("New Name");
  });

  it("does not write a name_mismatch audit when the name is unchanged", async () => {
    const { upsertUser } = await import("../lib/users");
    const { getDb } = await import("../lib/db");
    upsertUser({ id: "u1", email: "u1@example.com", name: "Same Name", roles: [] });
    upsertUser({ id: "u1", email: "u1@example.com", name: "Same Name", roles: [] });

    const db = getDb();
    const rows = db.prepare("SELECT * FROM audit_log WHERE action = 'name_mismatch'").all();
    expect(rows.length).toBe(0);
  });
});

describe("users.upsertUser: first-sight name derivation for long-form @example.com addresses", () => {
  it("derivedNameFromEmail title-cases each dot-separated part, including hyphen/apostrophe sub-parts", async () => {
    const { derivedNameFromEmail } = await import("../lib/identity");
    expect(derivedNameFromEmail("bob-luc.van-der-example@example.com")).toBe("Bob-Luc Van-Der-Example");
    expect(derivedNameFromEmail("test.user@example.com")).toBe("Test User");
  });

  it("keeps the header name when it loosely matches the derived name (case/accents/spacing/order)", async () => {
    const { upsertUser } = await import("../lib/users");
    const cases: [string, string][] = [
      ["alice.example@example.com", "ALICE example"],
      ["alice.example@example.com", "Example Alice"],
      ["alice.example@example.com", "Alicé Example"],
    ];
    for (const [email, headerName] of cases) {
      const dataDirLocal = mkdtempSync(path.join(tmpdir(), "bab-users-loose-"));
      process.env.DATA_DIR = dataDirLocal;
      const { _resetDbForTests } = await import("../lib/db");
      _resetDbForTests();
      const u = upsertUser({ id: email, email, name: headerName, roles: [] });
      expect(u.name).toBe(headerName);
      const db = (await import("../lib/db")).getDb();
      const rows = db.prepare("SELECT * FROM audit_log WHERE action = 'name_from_email'").all();
      expect(rows.length).toBe(0);
      _resetDbForTests();
      rmSync(dataDirLocal, { recursive: true, force: true });
    }
    process.env.DATA_DIR = dataDir;
  });

  it("replaces a header name that doesn't match and audits name_from_email", async () => {
    const { upsertUser } = await import("../lib/users");
    const { getDb } = await import("../lib/db");
    const u = upsertUser({
      id: "alice.example@example.com",
      email: "alice.example@example.com",
      name: "Test User",
      roles: [],
    });
    expect(u.name).toBe("Alice Example");

    const db = getDb();
    const rows = db
      .prepare("SELECT details FROM audit_log WHERE action = 'name_from_email' AND actor_id = ?")
      .all("alice.example@example.com") as { details: string | null }[];
    expect(rows.length).toBe(1);
    const details = JSON.parse(rows[0].details ?? "{}");
    expect(details.headerName).toBe("Test User");
    expect(details.derivedName).toBe("Alice Example");
  });

  it("does not touch an existing row's name on a later upsert, even for a long-form address", async () => {
    const { upsertUser, getUser } = await import("../lib/users");
    upsertUser({
      id: "alice.example@example.com",
      email: "alice.example@example.com",
      name: "Alice Example",
      roles: [],
    });
    upsertUser({
      id: "alice.example@example.com",
      email: "alice.example@example.com",
      name: "Something Else",
      roles: [],
    });
    expect(getUser("alice.example@example.com")!.name).toBe("Alice Example");
  });

  it("still allows a deliberate rename via renameUser after a derived name was stored", async () => {
    const { upsertUser, renameUser, getUser } = await import("../lib/users");
    upsertUser({
      id: "alice.example@example.com",
      email: "alice.example@example.com",
      name: "Test User",
      roles: [],
    });
    expect(getUser("alice.example@example.com")!.name).toBe("Alice Example");

    const updated = renameUser("alice.example@example.com", "Alicé Example");
    expect(updated.name).toBe("Alicé Example");
  });
});

describe("users.renameUser", () => {
  it("changes the name and writes an audited rename action", async () => {
    const { upsertUser, renameUser, getUser } = await import("../lib/users");
    const { getDb } = await import("../lib/db");
    upsertUser({ id: "u1", email: "u1@example.com", name: "Old Name", roles: [] });

    const updated = renameUser("u1", "Brand New Name");
    expect(updated.name).toBe("Brand New Name");
    expect(getUser("u1")!.name).toBe("Brand New Name");

    const db = getDb();
    const rows = db
      .prepare("SELECT details FROM audit_log WHERE action = 'rename' AND actor_id = ?")
      .all("u1") as { details: string | null }[];
    expect(rows.length).toBe(1);
    const details = JSON.parse(rows[0].details ?? "{}");
    expect(details.oldName).toBe("Old Name");
    expect(details.newName).toBe("Brand New Name");
  });
});

describe("users.listUsers and learningCountsByAuthor", () => {
  it("lists all upserted users", async () => {
    const { upsertUser, listUsers } = await import("../lib/users");
    upsertUser({ id: "u1", email: "a@example.com", name: "A", roles: [] });
    upsertUser({ id: "u2", email: "b@example.com", name: "B", roles: [] });

    const list = listUsers();
    expect(list.map((u) => u.id).sort()).toEqual(["u1", "u2"]);
  });

  it("counts active/expiring learnings per author, excluding deleted", async () => {
    const { upsertUser, learningCountsByAuthor } = await import("../lib/users");
    upsertUser({ id: "author-1", email: "a@example.com", name: "A", roles: [] });
    const { create } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");

    create({ authorId: "author-1", title: "One", body: "B" });
    create({ authorId: "author-1", title: "Two", body: "B" });
    const deleted = create({ authorId: "author-1", title: "Three", body: "B" });
    getDb().prepare("UPDATE learnings SET status = 'deleted' WHERE id = ?").run(deleted.id);

    const counts = learningCountsByAuthor();
    expect(counts["author-1"]).toBe(2);
  });

  it("returns an empty map when there are no learnings", async () => {
    const { learningCountsByAuthor } = await import("../lib/users");
    expect(learningCountsByAuthor()).toEqual({});
  });
});

describe("users.enrolledByWeek", () => {
  it("counts every user row once, as a running total at the end of each ISO week", async () => {
    const { upsertUser, enrolledByWeek } = await import("../lib/users");
    const { getDb } = await import("../lib/db");
    for (const id of ["a", "b", "c", "d"]) upsertUser({ id, email: `${id}@example.com`, name: id, roles: [] });
    const set = getDb().prepare("UPDATE users SET created_at = ? WHERE id = ?");
    set.run("2026-09-30 10:00:00", "a"); // before the first week shown
    set.run("2026-10-05 23:59:59", "b"); // Sunday: still the week of 29 Sep
    set.run("2026-10-06 00:00:00", "c"); // Monday 6 Oct
    set.run("2026-10-14 08:00:00", "d"); // week of 13 Oct
    expect(enrolledByWeek(["2026-10-06", "2026-10-13"])).toEqual({ total: 4, running: [3, 4], lastWeek: 1 });
    expect(enrolledByWeek(["2026-09-29", "2026-10-06"])).toEqual({ total: 4, running: [2, 3], lastWeek: 2 });
    expect(enrolledByWeek([])).toEqual({ total: 4, running: [], lastWeek: 0 });
  });
});
