import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _resetConfigForTests } from "../lib/config";

/**
 * Home team and area contacts (lib/area-contacts.ts, migration v45): the person's own opt-in,
 * its limits, who may change what, and the contacts a search with no answer suggests.
 */

let dataDir: string;
const ADA = "ada.t@example.com";
const BOB = "bob.b@example.com";
const CAL = "cal.c@example.com";
const DEE = "dee.d@example.com";
const MAINT = "maint.m@example.com";

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-area-contacts-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_MAINTAINERS = MAINT;
  _resetConfigForTests();
  const { getDb } = await import("../lib/db");
  const db = getDb();
  for (const id of [ADA, BOB, CAL, DEE, MAINT]) {
    db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(id, id, id.split(".")[0]);
  }
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
  _resetConfigForTests();
});

const auditActions = async () => {
  const { getDb } = await import("../lib/db");
  return (getDb().prepare("SELECT action FROM audit_log WHERE entity IN ('user', 'area_contact') ORDER BY id").all() as { action: string }[]).map((r) => r.action);
};

describe("normalizeArea", () => {
  it("lowercases and hyphenates a free label", async () => {
    const { normalizeArea } = await import("../lib/area-contacts");
    expect(normalizeArea("  Regulatory Lists! ")).toBe("regulatory-lists");
    expect(normalizeArea("PFAS_2026")).toBe("pfas-2026");
  });

  it("refuses an empty or too long area", async () => {
    const { normalizeArea } = await import("../lib/area-contacts");
    expect(() => normalizeArea("")).toThrow(/area is required/);
    expect(() => normalizeArea("!!!")).toThrow(/area is required/);
    expect(() => normalizeArea(undefined)).toThrow(/area is required/);
    expect(() => normalizeArea("a".repeat(41))).toThrow(/40 characters or fewer/);
    expect(normalizeArea("a".repeat(40))).toHaveLength(40);
  });
});

describe("home team", () => {
  it("sets, changes and clears the home team, and audits each change", async () => {
    const { setHomeTeam } = await import("../lib/area-contacts");
    const { getUser } = await import("../lib/users");
    expect(setHomeTeam(ADA, "Regulatory", "mcp")).toBe("regulatory");
    expect(getUser(ADA)?.home_team).toBe("regulatory");
    expect(setHomeTeam(ADA, "legal", "ui")).toBe("legal");
    expect(setHomeTeam(ADA, "", "mcp")).toBeNull();
    expect(setHomeTeam(ADA, null, "mcp")).toBeNull();
    expect(getUser(ADA)?.home_team).toBeNull();
    expect(await auditActions()).toEqual(["home_team_set", "home_team_set", "home_team_set", "home_team_set"]);
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT details FROM audit_log WHERE action = 'home_team_set' ORDER BY id LIMIT 1").get() as { details: string };
    expect(JSON.parse(row.details)).toEqual({ from: null, to: "regulatory" });
  });

  it("refuses a team that is not a team tag, and changes nothing", async () => {
    const { setHomeTeam } = await import("../lib/area-contacts");
    const { getUser } = await import("../lib/users");
    setHomeTeam(ADA, "data", "mcp");
    expect(() => setHomeTeam(ADA, "wizards", "mcp")).toThrow(/team must be one of engineering, product/);
    expect(getUser(ADA)?.home_team).toBe("data");
  });

  it("is never changed by a later request from the same person", async () => {
    const { setHomeTeam } = await import("../lib/area-contacts");
    const { upsertUser, getUser } = await import("../lib/users");
    setHomeTeam(ADA, "it", "mcp");
    upsertUser({ id: ADA, email: ADA, name: "ada", roles: [] });
    expect(getUser(ADA)?.home_team).toBe("it");
  });
});

describe("area contacts", () => {
  it("adds a contact with a note and lists it for the area", async () => {
    const { addAreaContact, contactsForArea, areasOf } = await import("../lib/area-contacts");
    expect(addAreaContact(ADA, "Toxicology", "regulatory lists, CHAs, certifications", "mcp")).toEqual({
      area: "toxicology",
      note: "regulatory lists, CHAs, certifications",
    });
    expect(contactsForArea("TOXICOLOGY")).toEqual([
      { area: "toxicology", id: ADA, name: "ada", note: "regulatory lists, CHAs, certifications" },
    ]);
    expect(areasOf(ADA)).toEqual([{ area: "toxicology", note: "regulatory lists, CHAs, certifications" }]);
    expect(contactsForArea("unknown")).toEqual([]);
  });

  it("the same area again only changes the note and does not count against the limits", async () => {
    const { addAreaContact, contactsForArea } = await import("../lib/area-contacts");
    addAreaContact(ADA, "toxicology", "old", "mcp");
    addAreaContact(ADA, "toxicology", "", "mcp");
    expect(contactsForArea("toxicology")).toHaveLength(1);
    expect(contactsForArea("toxicology")[0].note).toBeNull();
    expect(await auditActions()).toEqual(["area_contact_add", "area_contact_update"]);
  });

  it("redacts the note like other user text, and refuses one that is too long", async () => {
    const { addAreaContact, contactsForArea } = await import("../lib/area-contacts");
    const secret = ["pass", "word=hunter2"].join(""); // assembled at runtime: no secret-shaped literal in the file
    addAreaContact(ADA, "toxicology", "ask me, " + secret, "mcp");
    const note = contactsForArea("toxicology")[0].note ?? "";
    expect(note).not.toContain("hunter2");
    expect(note).toContain("[redacted");
    expect(() => addAreaContact(ADA, "hazards", "x".repeat(201), "mcp")).toThrow(/note must be 200 characters or fewer/);
    expect(contactsForArea("hazards")).toEqual([]);
  });

  it("allows at most 3 contacts per area", async () => {
    const { addAreaContact, contactsForArea } = await import("../lib/area-contacts");
    for (const who of [ADA, BOB, CAL]) addAreaContact(who, "toxicology", null, "mcp");
    expect(() => addAreaContact(DEE, "toxicology", null, "mcp")).toThrow(/already has 3 contacts/);
    expect(contactsForArea("toxicology").map((c) => c.id)).toEqual([ADA, BOB, CAL]);
  });

  it("allows at most 10 areas per person", async () => {
    const { addAreaContact, areasOf } = await import("../lib/area-contacts");
    for (let i = 0; i < 10; i++) addAreaContact(ADA, "area-" + i, null, "mcp");
    expect(() => addAreaContact(ADA, "one-too-many", null, "mcp")).toThrow(/already a contact for 10 areas/);
    expect(areasOf(ADA)).toHaveLength(10);
    // An area already held can still be edited at the limit.
    expect(() => addAreaContact(ADA, "area-3", "still fine", "mcp")).not.toThrow();
  });

  it("a person removes only themselves; a repeat removes nothing", async () => {
    const { addAreaContact, removeAreaContact, contactsForArea } = await import("../lib/area-contacts");
    addAreaContact(ADA, "toxicology", null, "mcp");
    addAreaContact(BOB, "toxicology", null, "mcp");
    expect(removeAreaContact(ADA, "toxicology", undefined, "mcp")).toBe(true);
    expect(removeAreaContact(ADA, "toxicology", undefined, "mcp")).toBe(false);
    expect(contactsForArea("toxicology").map((c) => c.id)).toEqual([BOB]);
    expect(await auditActions()).toEqual(["area_contact_add", "area_contact_add", "area_contact_remove"]);
  });

  it("refuses a non-maintainer who names someone else; naming oneself is fine", async () => {
    const { addAreaContact, removeAreaContact, contactsForArea } = await import("../lib/area-contacts");
    addAreaContact(BOB, "toxicology", null, "mcp");
    expect(() => removeAreaContact(ADA, "toxicology", BOB, "mcp")).toThrow(/Only maintainers/);
    expect(contactsForArea("toxicology")).toHaveLength(1);
    addAreaContact(ADA, "toxicology", null, "mcp");
    expect(removeAreaContact(ADA, "toxicology", ADA.toUpperCase(), "mcp")).toBe(true);
  });

  it("lets a maintainer remove anyone, and audits who did it", async () => {
    const { addAreaContact, removeAreaContact, contactsForArea } = await import("../lib/area-contacts");
    const { getDb } = await import("../lib/db");
    addAreaContact(BOB, "toxicology", null, "mcp");
    expect(removeAreaContact(MAINT, "toxicology", BOB, "ui")).toBe(true);
    expect(contactsForArea("toxicology")).toEqual([]);
    const row = getDb().prepare("SELECT actor_id, details FROM audit_log WHERE action = 'area_contact_remove'").get() as { actor_id: string; details: string };
    expect(row.actor_id).toBe(MAINT);
    expect(JSON.parse(row.details)).toEqual({ area: "toxicology", userId: BOB });
  });

  it("there is no way to add someone else: the person is always the caller", async () => {
    const { addAreaContact, areasOf } = await import("../lib/area-contacts");
    addAreaContact(MAINT, "toxicology", null, "mcp");
    expect(areasOf(BOB)).toEqual([]);
    expect(addAreaContact.length).toBe(4); // (userId, area, note, via): no separate target
  });

  it("areasByUser groups every person's areas", async () => {
    const { addAreaContact, areasByUser } = await import("../lib/area-contacts");
    addAreaContact(ADA, "toxicology", null, "mcp");
    addAreaContact(ADA, "chemicals", "CHAs", "mcp");
    addAreaContact(BOB, "toxicology", null, "mcp");
    const map = areasByUser();
    expect(map.get(ADA)).toEqual([{ area: "chemicals", note: "CHAs" }, { area: "toxicology", note: null }]);
    expect(map.get(BOB)).toEqual([{ area: "toxicology", note: null }]);
    expect(map.get(CAL)).toBeUndefined();
  });
});

describe("review fixes", () => {
  it("an area label that redaction would change is refused, and nothing is stored", async () => {
    const { normalizeArea, addAreaContact, areasOf } = await import("../lib/area-contacts");
    const secret = ["pass", "word=hunter2"].join("");
    expect(() => normalizeArea(secret)).toThrow(/personal data/);
    expect(() => addAreaContact(ADA, secret, null, "mcp")).toThrow(/personal data/);
    expect(areasOf(ADA)).toEqual([]);
    expect(normalizeArea("Toxicology")).toBe("toxicology");
  });

  it("a missing team is an error and changes nothing; only null or an empty string clears", async () => {
    const { setHomeTeam } = await import("../lib/area-contacts");
    const { getUser } = await import("../lib/users");
    setHomeTeam(ADA, "legal", "mcp");
    expect(() => setHomeTeam(ADA, undefined, "mcp")).toThrow(/team is required/);
    expect(getUser(ADA)?.home_team).toBe("legal");
    expect(setHomeTeam(ADA, "", "mcp")).toBeNull();
  });

  it("an unknown user gets a clear error and no audit row, for the team and for an area", async () => {
    const { setHomeTeam, addAreaContact } = await import("../lib/area-contacts");
    const { getDb } = await import("../lib/db");
    const before = (getDb().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    expect(() => setHomeTeam("ghost.g@example.com", "legal", "mcp")).toThrow(/does not know you/);
    expect(() => addAreaContact("ghost.g@example.com", "toxicology", null, "mcp")).toThrow(/does not know you/);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBe(before);
  });

  it("the note length is checked before redaction", async () => {
    const { addAreaContact } = await import("../lib/area-contacts");
    const secret = ["pass", "word=hunter2"].join("");
    // 201 raw characters that redact down to a short text: still refused.
    expect(() => addAreaContact(ADA, "toxicology", secret + " " + "x".repeat(200), "mcp")).toThrow(/200 characters or fewer/);
  });

  it("the maintenance sweep re-redacts area_contacts.note", async () => {
    const { addAreaContact, contactsForArea } = await import("../lib/area-contacts");
    const { getDb } = await import("../lib/db");
    const { redactStoredRows } = await import("../lib/maintenance");
    addAreaContact(ADA, "toxicology", "fine", "mcp");
    const secret = ["pass", "word=hunter2"].join("");
    getDb().prepare("UPDATE area_contacts SET note = ? WHERE area = 'toxicology'").run("ask " + secret);
    expect(redactStoredRows(getDb())).toBe(1);
    expect(contactsForArea("toxicology")[0].note).not.toContain("hunter2");
    expect(redactStoredRows(getDb())).toBe(0);
  });

  it("noise: a stopword or a common word does not match a part, a real word still does", async () => {
    const { addAreaContact, contactsForSearch } = await import("../lib/area-contacts");
    addAreaContact(ADA, "data-science", null, "mcp");
    addAreaContact(BOB, "toxicology", null, "mcp");
    addAreaContact(CAL, "how-to", null, "mcp");
    expect(contactsForSearch("how to fix data")).toEqual([]);
    expect(contactsForSearch("how do we handle this")).toEqual([]);
    expect(contactsForSearch("toxicology").map((c) => c.id)).toEqual([BOB]);
    expect(contactsForSearch("science questions").map((c) => c.id)).toEqual([ADA]);
    // A whole-area match still works for a common word.
    addAreaContact(DEE, "data", null, "mcp");
    expect(contactsForSearch("", "data").map((c) => c.id)).toEqual([DEE]);
  });
});

describe("contactsForSearch", () => {
  it("matches a query word or a tag filter against the area, whole or as a hyphen part", async () => {
    const { addAreaContact, contactsForSearch } = await import("../lib/area-contacts");
    addAreaContact(ADA, "toxicology", null, "mcp");
    addAreaContact(BOB, "regulatory-lists", null, "mcp");
    addAreaContact(CAL, "certifications", null, "mcp");
    expect(contactsForSearch("who knows toxicology?").map((c) => c.id)).toEqual([ADA]);
    expect(contactsForSearch("which lists apply").map((c) => c.id)).toEqual([BOB]);
    expect(contactsForSearch("", "Certifications").map((c) => c.id)).toEqual([CAL]);
    expect(contactsForSearch("regulatory-lists").map((c) => c.id)).toEqual([BOB]);
  });

  it("matches nothing for short words, no keys, or an unusable tag", async () => {
    const { addAreaContact, contactsForSearch } = await import("../lib/area-contacts");
    addAreaContact(ADA, "it", null, "mcp");
    expect(contactsForSearch("it is on")).toEqual([]);
    expect(contactsForSearch("")).toEqual([]);
    expect(contactsForSearch("", "!!!")).toEqual([]);
    expect(contactsForSearch("pizza")).toEqual([]);
  });

  it("returns at most 3, a whole-area match before a partial one", async () => {
    const { addAreaContact, contactsForSearch } = await import("../lib/area-contacts");
    addAreaContact(ADA, "lists-and-more", null, "mcp");
    addAreaContact(BOB, "lists-two", null, "mcp");
    addAreaContact(CAL, "lists-three", null, "mcp");
    addAreaContact(DEE, "lists", null, "mcp");
    const ids = contactsForSearch("lists").map((c) => c.id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(DEE);
  });
});

describe("migration v45", () => {
  it("adds the column and the table on a database that is at v44, and runs again safely", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.prepare("DELETE FROM migrations WHERE version >= 45").run();
    db.exec("DROP TABLE area_contacts");
    db.exec("ALTER TABLE users DROP COLUMN home_team");
    _resetDbForTests();
    const again = (await import("../lib/db")).getDb();
    const cols = (again.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("home_team");
    expect(again.prepare("SELECT 1 FROM migrations WHERE version = 45").get()).toBeTruthy();
    expect({ ...again.prepare("SELECT COUNT(*) AS n FROM area_contacts").get() }).toEqual({ n: 0 });

    // A process that died before the migrations row: the column exists, the row is missing.
    again.prepare("DELETE FROM migrations WHERE version = 45").run();
    _resetDbForTests();
    const third = (await import("../lib/db")).getDb();
    expect(third.prepare("SELECT 1 FROM migrations WHERE version = 45").get()).toBeTruthy();
  });

  it("keeps existing users with no home team", async () => {
    const { getUser } = await import("../lib/users");
    expect(getUser(ADA)?.home_team).toBeNull();
  });
});
