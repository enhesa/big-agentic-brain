import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-session-links-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

async function seedUser(email: string) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: email, email, name: "Test User", roles: [] });
}

describe("session links", () => {
  it("redeems a token once and binds the session to the user", async () => {
    await seedUser("alice.example@example.com");
    const { mintLinkToken, redeemLinkToken, sessionOwner } = await import("../lib/session-links");

    const token = mintLinkToken("sess-1");
    expect(sessionOwner("sess-1")).toBeNull();

    const result = redeemLinkToken(token, "alice.example@example.com");
    expect(result.sessionId).toBe("sess-1");
    expect(sessionOwner("sess-1")).toBe("alice.example@example.com");
  });

  it("refuses the same owner redeeming their own already-used token (clean ConflictError), session stays theirs", async () => {
    await seedUser("alice.example@example.com");
    const { mintLinkToken, redeemLinkToken, sessionOwner } = await import("../lib/session-links");
    const { ConflictError } = await import("../lib/errors");

    const token = mintLinkToken("sess-self-replay");
    redeemLinkToken(token, "alice.example@example.com");

    expect(() => redeemLinkToken(token, "alice.example@example.com")).toThrow(ConflictError);
    expect(() => redeemLinkToken(token, "alice.example@example.com")).toThrow("Link token already used");
    expect(sessionOwner("sess-self-replay")).toBe("alice.example@example.com");
  });

  it("refuses a replayed token so a session cannot be re-pointed at another user", async () => {
    await seedUser("alice.example@example.com");
    await seedUser("carl.example@example.com");
    const { mintLinkToken, redeemLinkToken, sessionOwner } = await import("../lib/session-links");
    const { ConflictError } = await import("../lib/errors");

    const token = mintLinkToken("sess-1");
    redeemLinkToken(token, "alice.example@example.com");

    expect(() => redeemLinkToken(token, "carl.example@example.com")).toThrow(ConflictError);
    expect(sessionOwner("sess-1")).toBe("alice.example@example.com");
  });

  it("refuses to re-bind a session that already belongs to another user", async () => {
    await seedUser("alice.example@example.com");
    await seedUser("carl.example@example.com");
    const { mintLinkToken, redeemLinkToken, sessionOwner } = await import("../lib/session-links");
    const { ConflictError } = await import("../lib/errors");

    const firstToken = mintLinkToken("sess-owned");
    redeemLinkToken(firstToken, "alice.example@example.com");

    // Anyone who learns the session id can mint a fresh token for it (minting is
    // unauthenticated) — redeeming that token as a different user must still be refused.
    const takeoverToken = mintLinkToken("sess-owned");
    expect(() => redeemLinkToken(takeoverToken, "carl.example@example.com")).toThrow(ConflictError);
    expect(sessionOwner("sess-owned")).toBe("alice.example@example.com");
  });

  it("does not burn a token on a cross-owner refusal, so the rightful owner can still redeem it", async () => {
    await seedUser("alice.example@example.com");
    await seedUser("carl.example@example.com");
    const { mintLinkToken, redeemLinkToken, sessionOwner } = await import("../lib/session-links");
    const { ConflictError } = await import("../lib/errors");

    const firstToken = mintLinkToken("sess-owned-2");
    redeemLinkToken(firstToken, "alice.example@example.com");

    const takeoverToken = mintLinkToken("sess-owned-2");
    expect(() => redeemLinkToken(takeoverToken, "carl.example@example.com")).toThrow(ConflictError);

    const result = redeemLinkToken(takeoverToken, "alice.example@example.com");
    expect(result.sessionId).toBe("sess-owned-2");
    expect(sessionOwner("sess-owned-2")).toBe("alice.example@example.com");
  });

  it("stores no folder or title: a link only records whose session it is", async () => {
    await seedUser("alice.example@example.com");
    const { mintLinkToken, redeemLinkToken } = await import("../lib/session-links");
    const { getDb } = await import("../lib/db");

    const token = mintLinkToken("sess-plain");
    redeemLinkToken(token, "alice.example@example.com");

    const link = getDb().prepare("SELECT cwd, title FROM session_links WHERE token = ?").get(token);
    expect({ ...link }).toEqual({ cwd: null, title: null });
    const session = getDb().prepare("SELECT cwd, title FROM sessions WHERE id = ?").get("sess-plain");
    expect({ ...session }).toEqual({ cwd: null, title: null });
  });

  it("refuses an unknown token", async () => {
    await seedUser("alice.example@example.com");
    const { redeemLinkToken } = await import("../lib/session-links");
    const { NotFoundError } = await import("../lib/errors");
    expect(() => redeemLinkToken("nope", "alice.example@example.com")).toThrow(NotFoundError);
  });

  it("refuses an expired token", async () => {
    await seedUser("alice.example@example.com");
    const { mintLinkToken, redeemLinkToken } = await import("../lib/session-links");
    const { NotFoundError } = await import("../lib/errors");
    const { getDb } = await import("../lib/db");

    const token = mintLinkToken("sess-1");
    getDb()
      .prepare("UPDATE session_links SET expires_at = datetime('now','-1 minute') WHERE token = ?")
      .run(token);

    expect(() => redeemLinkToken(token, "alice.example@example.com")).toThrow(NotFoundError);
  });

  describe("mintOrReuseLinkToken", () => {
    // POST /api/hook (the only caller) is unauthenticated and Claude Code re-POSTs on
    // every prompt until a session links, so minting unconditionally would leave one
    // session_links row per hook call with no bound — see lib/maintenance.ts's
    // sweepExpiredLinks for the cleanup that catches whatever still accumulates.
    it("returns the same token for repeated calls while it's still live", async () => {
      const { mintOrReuseLinkToken } = await import("../lib/session-links");
      const a = mintOrReuseLinkToken("sess-reuse-1");
      const b = mintOrReuseLinkToken("sess-reuse-1");
      expect(b).toBe(a);
    });

    it("mints a fresh token once the live one has expired", async () => {
      const { mintOrReuseLinkToken } = await import("../lib/session-links");
      const { getDb } = await import("../lib/db");

      const a = mintOrReuseLinkToken("sess-reuse-2");
      getDb()
        .prepare("UPDATE session_links SET expires_at = datetime('now', '-1 minute') WHERE token = ?")
        .run(a);

      const b = mintOrReuseLinkToken("sess-reuse-2");
      expect(b).not.toBe(a);
    });

    it("mints a fresh token once the prior one has been redeemed (spent, not just expired)", async () => {
      await seedUser("alice.example@example.com");
      const { mintOrReuseLinkToken, redeemLinkToken, sessionOwner } = await import("../lib/session-links");

      const a = mintOrReuseLinkToken("sess-reuse-3");
      redeemLinkToken(a, "alice.example@example.com");
      expect(sessionOwner("sess-reuse-3")).toBe("alice.example@example.com");

      const b = mintOrReuseLinkToken("sess-reuse-3");
      expect(b).not.toBe(a);
    });

    it("never reuses one session's token for a different session_id", async () => {
      const { mintOrReuseLinkToken } = await import("../lib/session-links");
      const a = mintOrReuseLinkToken("sess-reuse-4a");
      const b = mintOrReuseLinkToken("sess-reuse-4b");
      expect(b).not.toBe(a);
    });
  });
});
