import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-forge-suggest-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seedUsers(...emails: string[]) {
  const { upsertUser } = await import("../lib/users");
  for (const email of emails) upsertUser({ id: email, email, name: null, roles: [] });
}

describe("suggestLinkFor", () => {
  it("matches the alias to first initial plus last name", async () => {
    await seedUsers("alice.example@example.com", "anna.smith@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "aexample@example.com", "Alice Example")).toEqual({
      email: "alice.example@example.com",
      name: "Alice Example",
    });
  });

  it("is case-insensitive on the alias and trims it", async () => {
    await seedUsers("alice.example@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "  AExample@Example.com ", "Alice Example")?.email).toBe("alice.example@example.com");
  });

  it("joins a multi-part last name without dots", async () => {
    await seedUsers("bob.van.der.example@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "bvanderexample@example.com", "Bob van der Example")?.email).toBe("bob.van.der.example@example.com");
  });

  it("matches a single-segment last name", async () => {
    await seedUsers("bob.vanderexample@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "bvanderexample@example.com", "Bob van der Example")?.email).toBe("bob.vanderexample@example.com");
  });

  it("ignores hyphens and apostrophes in the long form", async () => {
    await seedUsers("bob-luc.van-der-example@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "bvanderexample@example.com", "Bob-Luc Van-Der-Example")?.email).toBe("bob-luc.van-der-example@example.com");
  });

  it("falls back to a name derived from the email when the user has none", async () => {
    await seedUsers("alice.example@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "aexample@example.com", "Alice Example")?.name).toBe("Alice Example");
  });

  it("returns null when nobody matches", async () => {
    await seedUsers("anna.smith@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "aexample@example.com", "Alice Example")).toBeNull();
  });

  it("returns null when two people match (ambiguous)", async () => {
    await seedUsers("bob.van.der.example@example.com", "bob.vanderexample@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    // Same alias and the name fits both emails, so neither may be offered.
    expect(suggestLinkFor("oid-1", "bvanderexample@example.com", "Bob Van der Example")).toBeNull();
  });

  it("uses the name to tell apart two people who share an alias", async () => {
    await seedUsers("alice.example@example.com", "adam.example@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "aexample@example.com", "Adam Example")?.email).toBe("adam.example@example.com");
  });

  it("returns null when the match is already linked to a different forge user", async () => {
    await seedUsers("alice.example@example.com");
    const { suggestLinkFor, claimSuggestedLink } = await import("../lib/forge-links");
    claimSuggestedLink("oid-other", "aexample@example.com", "Alice Example", "alice.example@example.com");
    expect(suggestLinkFor("oid-1", "aexample@example.com", "Alice Example")).toBeNull();
  });

  it("returns null for a non-acme domain", async () => {
    await seedUsers("alice.example@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "aexample@other.test", null)).toBeNull();
  });

  it("returns null when the email is already long-form, missing or malformed", async () => {
    await seedUsers("alice.example@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "alice.example@example.com", "Alice Example")).toBeNull();
    expect(suggestLinkFor("oid-1", null, null)).toBeNull();
    expect(suggestLinkFor("oid-1", "", null)).toBeNull();
    expect(suggestLinkFor("oid-1", "not-an-email", null)).toBeNull();
    expect(suggestLinkFor("oid-1", "a@b@example.com", "Test Person")).toBeNull();
  });

  it("is case-insensitive about the proxy name", async () => {
    await seedUsers("alice.example@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "aexample@example.com", "ALICE EXAMPLE")?.email).toBe("alice.example@example.com");
  });

  it("returns null without a proxy name, so the code flow is used", async () => {
    await seedUsers("alice.example@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "aexample@example.com", null)).toBeNull();
    expect(suggestLinkFor("oid-1", "aexample@example.com", "   ")).toBeNull();
  });

  it("does not offer Adam Smith to Anna Smith (same alias, different first name)", async () => {
    await seedUsers("adam.smith@example.com");
    const { suggestLinkFor, claimSuggestedLink } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "asmith@example.com", "Anna Smith")).toBeNull();
    expect(() => claimSuggestedLink("oid-1", "asmith@example.com", "Anna Smith", "adam.smith@example.com")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(suggestLinkFor("oid-2", "asmith@example.com", "Adam Smith")?.email).toBe("adam.smith@example.com");
  });

  it("checks the proxy name against the email, not the agent-declared users.name", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "adam.smith@example.com", email: "adam.smith@example.com", name: "Anna Smith", roles: [] });
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE users SET name = 'Anna Smith' WHERE id = 'adam.smith@example.com'").run();
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "asmith@example.com", "Anna Smith")).toBeNull();
  });

  it("returns null for a one-letter alias", async () => {
    await seedUsers("alice.example@example.com");
    const { suggestLinkFor } = await import("../lib/forge-links");
    expect(suggestLinkFor("oid-1", "i@example.com", "Alice Example")).toBeNull();
  });

  it("still suggests the same user when this forge id is the one linked to them", async () => {
    await seedUsers("alice.example@example.com");
    const { suggestLinkFor, claimSuggestedLink } = await import("../lib/forge-links");
    claimSuggestedLink("oid-1", "aexample@example.com", "Alice Example", "alice.example@example.com");
    expect(suggestLinkFor("oid-1", "aexample@example.com", "Alice Example")?.email).toBe("alice.example@example.com");
  });
});

describe("claimSuggestedLink", () => {
  it("creates the forge_links row and audits link-browser-claim via ui", async () => {
    await seedUsers("alice.example@example.com");
    const { claimSuggestedLink, getLinkedUserId } = await import("../lib/forge-links");
    const res = claimSuggestedLink("oid-1", "aexample@example.com", "Alice Example", "Alice.Example@example.com");
    expect(res).toEqual({ email: "alice.example@example.com" });
    expect(getLinkedUserId("oid-1")).toBe("alice.example@example.com");

    const { getDb } = await import("../lib/db");
    const row = getDb()
      .prepare("SELECT actor_id, entity, entity_id, via FROM audit_log WHERE action = 'link-browser-claim'")
      .get() as { actor_id: string; entity: string; entity_id: string; via: string };
    expect({ ...row }).toEqual({
      actor_id: "alice.example@example.com",
      entity: "forge_link",
      entity_id: "oid-1",
      via: "ui",
    });
  });

  it("400s when the claimed email is not the server-side suggestion", async () => {
    await seedUsers("alice.example@example.com", "anna.smith@example.com");
    const { claimSuggestedLink, getLinkedUserId } = await import("../lib/forge-links");
    expect(() => claimSuggestedLink("oid-1", "aexample@example.com", "Alice Example", "anna.smith@example.com")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => claimSuggestedLink("oid-1", "aexample@example.com", "Alice Example", "")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(getLinkedUserId("oid-1")).toBeNull();
  });

  it("409s when that user is already linked to a different forge id", async () => {
    await seedUsers("alice.example@example.com");
    const { claimSuggestedLink } = await import("../lib/forge-links");
    claimSuggestedLink("oid-first", "aexample@example.com", "Alice Example", "alice.example@example.com");
    expect(() => claimSuggestedLink("oid-second", "aexample@example.com", "Alice Example", "alice.example@example.com")).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("409s when this forge id is already linked to someone else (no re-claim)", async () => {
    await seedUsers("alice.example@example.com");
    const { claimSuggestedLink, getLinkedUserId } = await import("../lib/forge-links");
    const { getDb } = await import("../lib/db");
    getDb().prepare("INSERT INTO forge_links (forge_user_id, user_id) VALUES ('oid-1', 'adam.example@example.com')").run();
    expect(() => claimSuggestedLink("oid-1", "aexample@example.com", "Alice Example", "alice.example@example.com")).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(getLinkedUserId("oid-1")).toBe("adam.example@example.com");
  });

  it("is idempotent for the same forge id and user", async () => {
    await seedUsers("alice.example@example.com");
    const { claimSuggestedLink } = await import("../lib/forge-links");
    claimSuggestedLink("oid-1", "aexample@example.com", "Alice Example", "alice.example@example.com");
    expect(claimSuggestedLink("oid-1", "aexample@example.com", "Alice Example", "alice.example@example.com").email).toBe(
      "alice.example@example.com",
    );
  });
});
