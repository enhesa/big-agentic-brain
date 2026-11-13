import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The hourly maintenance sweep re-redacts stored rows only when the redaction rules changed since
 * the last full pass (lib/maintenance.ts redactStoredRowsIfRulesChanged). Writes are redacted when
 * they land, so between rule changes the full scan finds nothing. The fingerprint is stored in the
 * database after a successful pass.
 */

let dataDir: string;
const ME = "pat@example.com";
// Built at runtime so the source holds no credential-shaped string.
const SECRET = ["pass", "word=", "hunter", "2"].join("");

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-redact-gate-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_REDACT_DOMAINS;
  (await import("../lib/config"))._resetConfigForTests();
  vi.resetModules();
});

/** A todo whose title is written raw, past the write-side redaction, as an old row would be. */
async function rawTodo(id: string): Promise<void> {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ME, email: ME, name: "Pat", roles: [] });
  const { create } = await import("../lib/todos");
  const t = create({ ownerId: ME, title: "placeholder" }, "mcp");
  const { getDb } = await import("../lib/db");
  getDb().prepare("UPDATE todos SET id = ?, title = ? WHERE id = ?").run(id, `use ${SECRET}`, t.id);
}

async function titleOf(id: string): Promise<string> {
  const { getDb } = await import("../lib/db");
  return (getDb().prepare("SELECT title FROM todos WHERE id = ?").get(id) as { title: string }).title;
}

describe("stored-row redaction runs only when the rules change", () => {
  it("runs the first time, skips while the rules are the same, and runs again when they change", async () => {
    const { redactStoredRowsIfRulesChanged } = await import("../lib/maintenance");
    const { getDb } = await import("../lib/db");

    await rawTodo("t1");
    expect(redactStoredRowsIfRulesChanged(getDb())).toBe(1);
    expect(await titleOf("t1")).not.toContain("hunter2");
    const stored = getDb().prepare("SELECT value FROM maintenance_state WHERE key = 'redact_fingerprint'").get() as { value: string };
    expect(stored.value).toMatch(/^[0-9a-f]{64}:/);

    // Same rules: the full scan is skipped, so a raw row slipped in since stays as it is.
    await rawTodo("t2");
    expect(redactStoredRowsIfRulesChanged(getDb())).toBe(0);
    expect(await titleOf("t2")).toContain("hunter2");

    // Rules changed (here: an older fingerprint, as after a release that adds a pattern).
    getDb().prepare("UPDATE maintenance_state SET value = 'older' WHERE key = 'redact_fingerprint'").run();
    expect(redactStoredRowsIfRulesChanged(getDb())).toBe(1);
    expect(await titleOf("t2")).not.toContain("hunter2");
  });

  it("the hourly sweep uses the gate: a second forced run reports nothing redacted", async () => {
    await rawTodo("t1");
    const { runMaintenance } = await import("../lib/maintenance");
    expect(runMaintenance(true)?.rowsRedacted).toBe(1);
    await rawTodo("t2");
    expect(runMaintenance(true)?.rowsRedacted).toBe(0);
  });

  it("a redaction setting is part of the fingerprint", async () => {
    const { redactionFingerprint } = await import("../lib/redact");
    const before = redactionFingerprint();
    expect(redactionFingerprint()).toBe(before);
    process.env.BAB_REDACT_DOMAINS = "example.com";
    (await import("../lib/config"))._resetConfigForTests();
    expect(redactionFingerprint()).not.toBe(before);
  });

  it("keeps no fingerprint after a failed pass, so the next run tries again", async () => {
    const { redactStoredRowsIfRulesChanged } = await import("../lib/maintenance");
    const { getDb } = await import("../lib/db");
    getDb().exec("DROP TABLE area_contacts");
    expect(() => redactStoredRowsIfRulesChanged(getDb())).toThrow();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM maintenance_state").get()).toEqual({ n: 0 });
  });
});
