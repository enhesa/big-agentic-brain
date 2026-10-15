import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { linkForTests } from "./link-helper";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-forge-links-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("getLinkedUserId", () => {
  it("returns null for a forge user id that was never linked", async () => {
    const { getLinkedUserId } = await import("../lib/forge-links");
    expect(getLinkedUserId("forge-oid-unknown")).toBeNull();
  });
});

describe("unlinkOwnBrowser", () => {
  it("removes the caller link and audits unlink-browser-self", async () => {
    const { unlinkOwnBrowser, getLinkedUserId } = await import("../lib/forge-links");
    await linkForTests("forge-oid-1", "jean.dupont@example.com");
    expect(unlinkOwnBrowser("forge-oid-1")).toEqual({ email: "jean.dupont@example.com" });
    expect(getLinkedUserId("forge-oid-1")).toBeNull();
    const { getDb } = await import("../lib/db");
    const rows = getDb()
      .prepare("SELECT actor_id FROM audit_log WHERE action = 'unlink-browser-self' AND entity_id = ?")
      .all("forge-oid-1") as { actor_id: string }[];
    expect(rows).toEqual([{ actor_id: "jean.dupont@example.com" }]);
  });

  it("leaves other links alone and returns null when nothing was linked", async () => {
    const { unlinkOwnBrowser, getLinkedUserId } = await import("../lib/forge-links");
    await linkForTests("forge-oid-1", "jean.dupont@example.com");
    expect(unlinkOwnBrowser("forge-oid-other")).toBeNull();
    expect(getLinkedUserId("forge-oid-1")).toBe("jean.dupont@example.com");
  });

  it("the person can link again after unlinking", async () => {
    const { unlinkOwnBrowser, getLinkedUserId, claimTypedIdentity } = await import("../lib/forge-links");
    await linkForTests("forge-oid-1", "jean.dupont@example.com");
    unlinkOwnBrowser("forge-oid-1");
    claimTypedIdentity("forge-oid-1", "jdupont@example.com", "Jean Dupont", "jean.dupont@example.com");
    expect(getLinkedUserId("forge-oid-1")).toBe("jean.dupont@example.com");
  });
});

describe("claimTypedIdentity (P1.0)", () => {
  const FORGE = "forge-oid-typed";

  it("links an alias-only SSO account with no users row, creating the row and auditing the claim", async () => {
    const { claimTypedIdentity, getLinkedUserId } = await import("../lib/forge-links");
    const { getUser } = await import("../lib/users");
    expect(getUser("alice.example@example.com")).toBeUndefined();

    const out = claimTypedIdentity(FORGE, "aexample@example.com", "Alice Example", "  Alice.Example@Example.com ");
    expect(out).toEqual({ email: "alice.example@example.com" });
    expect(getLinkedUserId(FORGE)).toBe("alice.example@example.com");
    expect(getUser("alice.example@example.com")?.name).toBe("Alice Example");

    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT * FROM audit_log WHERE action = 'link-browser-claim'").get() as {
      actor_id: string;
      entity_id: string;
      details: string;
    };
    expect(row.actor_id).toBe("alice.example@example.com");
    expect(row.entity_id).toBe(FORGE);
    expect(JSON.parse(row.details)).toEqual({ forgeEmail: "aexample@example.com", forgeName: "Alice Example" });
  });

  it("shows up on the maintainer list with the proxy email and name", async () => {
    const { claimTypedIdentity, listLinks } = await import("../lib/forge-links");
    claimTypedIdentity(FORGE, "aexample@example.com", "Alice Example", "alice.example@example.com");
    expect(listLinks()[0]).toMatchObject({ forgeEmail: "aexample@example.com", forgeName: "Alice Example" });
  });

  it("links to an existing agent-made user without touching their stored name", async () => {
    const { upsertUser, getUser } = await import("../lib/users");
    upsertUser({ id: "alice.example@example.com", email: "alice.example@example.com", name: "Alice Example", roles: [] });
    const { claimTypedIdentity, getLinkedUserId } = await import("../lib/forge-links");
    claimTypedIdentity(FORGE, "aexample@example.com", "Alice Example", "alice.example@example.com");
    expect(getLinkedUserId(FORGE)).toBe("alice.example@example.com");
    expect(getUser("alice.example@example.com")?.name).toBe("Alice Example");
  });

  it("refuses an address whose name does not fit the SSO name, writes nothing, creates no user", async () => {
    const { claimTypedIdentity, getLinkedUserId } = await import("../lib/forge-links");
    const { getUser } = await import("../lib/users");
    expect(() => claimTypedIdentity(FORGE, "mcurie@example.com", "Marie Curie", "alice.example@example.com")).toThrow(
      /does not fit/,
    );
    expect(getLinkedUserId(FORGE)).toBeNull();
    expect(getUser("alice.example@example.com")).toBeUndefined();
  });

  it("refuses when SSO sent no name at all", async () => {
    const { claimTypedIdentity } = await import("../lib/forge-links");
    expect(() => claimTypedIdentity(FORGE, "aexample@example.com", null, "alice.example@example.com")).toThrow(/does not fit/);
  });

  it("applies the alias rule too: the name fits but the SSO email belongs to someone else", async () => {
    const { claimTypedIdentity, getLinkedUserId } = await import("../lib/forge-links");
    expect(() =>
      claimTypedIdentity(FORGE, "mcurie@example.com", "Alice Example", "alice.example@example.com"),
    ).toThrow(/admin\/links/);
    expect(getLinkedUserId(FORGE)).toBeNull();
  });

  it("refuses a missing or non-acme SSO email, pointing at /admin/links, and links nothing", async () => {
    const { claimTypedIdentity, getLinkedUserId } = await import("../lib/forge-links");
    for (const sso of [null, "", "aexample@other.test", "alice@example.com.evil.test"]) {
      expect(() => claimTypedIdentity(FORGE, sso, "Alice Example", "alice.example@example.com")).toThrow(/admin\/links/);
    }
    expect(getLinkedUserId(FORGE)).toBeNull();
  });

  it("middle names: the guessed alias must be the SSO alias", async () => {
    const { claimTypedIdentity, getLinkedUserId } = await import("../lib/forge-links");
    expect(() => claimTypedIdentity(FORGE, "jpsmith@example.com", "John Paul Smith", "john.paul.smith@example.com")).toThrow(
      /admin\/links/,
    );
    expect(getLinkedUserId(FORGE)).toBeNull();
    expect(claimTypedIdentity(FORGE, "jsmith@example.com", "John Paul Smith", "john.paul.smith@example.com").email).toBe(
      "john.paul.smith@example.com",
    );
  });

  it("the linked owner shape is accepted: alias aexample, name with a nickname", async () => {
    const { claimTypedIdentity } = await import("../lib/forge-links");
    expect(claimTypedIdentity(FORGE, "aexample@example.com", "Alice (Ally) Example", "alice.example@example.com").email).toBe(
      "alice.example@example.com",
    );
  });

  it("accepts an SSO email that is already the long form", async () => {
    const { claimTypedIdentity } = await import("../lib/forge-links");
    expect(
      claimTypedIdentity(FORGE, "alice.example@example.com", "Alice Example", "alice.example@example.com").email,
    ).toBe("alice.example@example.com");
  });

  it("is a 400 for something that is not a long-form address", async () => {
    const { claimTypedIdentity } = await import("../lib/forge-links");
    for (const bad of ["aexample@example.com", "alice.example@other.test", "", "alice example"]) {
      expect(() => claimTypedIdentity(FORGE, "aexample@example.com", "Alice Example", bad)).toThrow(/first\.last@example.com/);
    }
    expect(() => claimTypedIdentity(FORGE, "aexample@example.com", "Alice Example", 42 as never)).toThrow(/first\.last/);
  });

  it("is a 409 when the address is already linked to another browser", async () => {
    const { claimTypedIdentity, getLinkedUserId } = await import("../lib/forge-links");
    claimTypedIdentity("forge-oid-first", "aexample@example.com", "Alice Example", "alice.example@example.com");
    let err: unknown;
    try {
      claimTypedIdentity("forge-oid-second", "aexample@example.com", "Alice Example", "alice.example@example.com");
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ status: 409 });
    expect(getLinkedUserId("forge-oid-second")).toBeNull();
    expect(getLinkedUserId("forge-oid-first")).toBe("alice.example@example.com");
  });

  it("is a 409 when this browser is already linked to someone else, and a no-op for the same person", async () => {
    const { claimTypedIdentity, getLinkedUserId } = await import("../lib/forge-links");
    claimTypedIdentity(FORGE, "aexample@example.com", "Alice Example", "alice.example@example.com");
    expect(claimTypedIdentity(FORGE, "aexample@example.com", "Alice Example", "alice.example@example.com").email).toBe(
      "alice.example@example.com",
    );
    expect(() => claimTypedIdentity(FORGE, "aexample@example.com", "Alice Example", "alyce.example@example.com")).toThrow();
    expect(getLinkedUserId(FORGE)).toBe("alice.example@example.com");
  });

  it("can be undone with the existing self-unlink and claimed again", async () => {
    const { claimTypedIdentity, unlinkOwnBrowser, getLinkedUserId } = await import("../lib/forge-links");
    claimTypedIdentity(FORGE, "aexample@example.com", "Alice Example", "alice.example@example.com");
    expect(unlinkOwnBrowser(FORGE)).toEqual({ email: "alice.example@example.com" });
    expect(getLinkedUserId(FORGE)).toBeNull();
    claimTypedIdentity(FORGE, "aexample@example.com", "Alice Example", "alice.example@example.com");
    expect(getLinkedUserId(FORGE)).toBe("alice.example@example.com");
  });
});
