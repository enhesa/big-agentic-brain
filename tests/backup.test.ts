import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-backup-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("maybeSnapshotBackup", () => {
  it("produces a snapshot.db that opens with node:sqlite and contains learnings rows", async () => {
    const { getDb } = await import("../lib/db");
    const { upsertUser } = await import("../lib/users");
    const { create } = await import("../lib/learnings");
    const { maybeSnapshotBackup, _resetSnapshotGuardForTests } = await import("../lib/backup");
    _resetSnapshotGuardForTests();

    getDb();
    upsertUser({ id: "u1", email: "u1@example.com", name: "U1", roles: [] });
    create({ authorId: "u1", title: "Snapshot me", body: "Body" });

    maybeSnapshotBackup();

    const snapPath = path.join(dataDir, "snapshot.db");
    const snap = new DatabaseSync(snapPath, { readOnly: true });
    try {
      const tables = snap
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learnings'")
        .all();
      expect(tables.length).toBe(1);

      const rows = snap.prepare("SELECT title FROM learnings").all() as { title: string }[];
      expect(rows.map((r) => r.title)).toContain("Snapshot me");
    } finally {
      snap.close();
    }
  });

  it("does nothing on a second call within the freshness window", async () => {
    const { getDb } = await import("../lib/db");
    const { maybeSnapshotBackup, _resetSnapshotGuardForTests } = await import("../lib/backup");
    _resetSnapshotGuardForTests();

    getDb();
    maybeSnapshotBackup();

    const snapPath = path.join(dataDir, "snapshot.db");
    // Back-date the mtime so this assertion isn't at the mercy of filesystem mtime
    // resolution (some filesystems round to ~1-2s, which could make two real writes a
    // few ms apart look identical even if a second VACUUM INTO had actually run).
    const backdated = new Date(Date.now() - 60_000);
    utimesSync(snapPath, backdated, backdated);

    maybeSnapshotBackup();

    // Still the backdated mtime we set: the second call saw a fresh-enough snapshot
    // (well under the 20h window) and skipped writing entirely.
    expect(statSync(snapPath).mtimeMs).toBe(backdated.getTime());
  });

  it("re-snapshots once the existing snapshot is older than the freshness window", async () => {
    const { getDb } = await import("../lib/db");
    const { maybeSnapshotBackup, _resetSnapshotGuardForTests } = await import("../lib/backup");
    _resetSnapshotGuardForTests();

    getDb();
    maybeSnapshotBackup();

    const snapPath = path.join(dataDir, "snapshot.db");
    const stale = new Date(Date.now() - 21 * 60 * 60 * 1000);
    utimesSync(snapPath, stale, stale);

    maybeSnapshotBackup();

    // A fresh snapshot was written, so its mtime is no longer the stale one we set.
    expect(statSync(snapPath).mtimeMs).toBeGreaterThan(stale.getTime());
  });

  it("is not fooled by a leftover temp file from a previous, interrupted run", async () => {
    const { getDb } = await import("../lib/db");
    const { maybeSnapshotBackup, _resetSnapshotGuardForTests } = await import("../lib/backup");
    _resetSnapshotGuardForTests();

    getDb();
    const tmpPath = path.join(dataDir, "snapshot.db.tmp");
    writeFileSync(tmpPath, "leftover from a crashed previous run, not a real sqlite file");

    expect(() => maybeSnapshotBackup()).not.toThrow();

    const snapPath = path.join(dataDir, "snapshot.db");
    const snap = new DatabaseSync(snapPath, { readOnly: true });
    try {
      const tables = snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      expect(tables.length).toBeGreaterThan(0);
    } finally {
      snap.close();
    }
  });

  it("never throws when the underlying VACUUM INTO fails", async () => {
    const { getDb } = await import("../lib/db");
    const { maybeSnapshotBackup, _resetSnapshotGuardForTests } = await import("../lib/backup");
    _resetSnapshotGuardForTests();

    const db = getDb();
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (sql.startsWith("VACUUM INTO")) throw new Error("simulated vacuum failure");
      return original(sql);
    }) as typeof db.prepare;

    expect(() => maybeSnapshotBackup()).not.toThrow();
  });
});

describe("maintenance scheduling never writes a snapshot on its own under vitest", () => {
  it("runMaintenance() alone (how tests/maintenance.test.ts and tests/db.test.ts call it) does not write snapshot.db", async () => {
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    const { existsSync } = await import("node:fs");
    _resetMaintenanceGuardForTests();

    getDb();
    runMaintenance(true);

    expect(existsSync(path.join(dataDir, "snapshot.db"))).toBe(false);
  });

  it("scheduleMaintenance() is a no-op under vitest, so it doesn't write one either", async () => {
    const { getDb } = await import("../lib/db");
    const { scheduleMaintenance } = await import("../lib/maintenance");
    const { existsSync } = await import("node:fs");

    getDb();
    scheduleMaintenance();
    // scheduleMaintenance defers to setImmediate in production; under vitest it returns
    // before ever scheduling that callback, so there is nothing to flush or await here.
    expect(existsSync(path.join(dataDir, "snapshot.db"))).toBe(false);
  });
});
