import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * lib/mcp-connections.ts: the Mcp-Session-Id BAB issues on initialize. An identified connection is
 * identity for later requests of the same client (when it keeps no device secret). Deliberately
 * tolerant: an unknown or malformed id is simply no connection, never an error.
 */

let dataDir: string;
const ALICE = "alice.example@example.com";
const MARIE = "marie.curie@example.com";
const DAY = 86_400_000;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-connections-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _setConnectionClockForTests } = await import("../lib/mcp-connections");
  _setConnectionClockForTests();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const lib = () => import("../lib/mcp-connections");

describe("createConnection", () => {
  it("only mints: 32 random bytes as base64url, different every time, and no row", async () => {
    const c = await lib();
    const a = c.createConnection();
    const b = c.createConnection();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(c.lookupConnection(a)).toBeNull();
    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM mcp_connections").get()).toEqual({ n: 0 });
  });

  it("a minted id becomes a connection only when it is bound", async () => {
    const c = await lib();
    const a = c.createConnection();
    c.bindConnection(a, ALICE);
    expect(c.lookupConnection(a)).toMatchObject({ id: a, userId: ALICE });
  });

  it("the test helper makes an unbound row", async () => {
    const c = await lib();
    const a = c._insertConnectionForTests();
    expect(c.lookupConnection(a)).toMatchObject({ id: a, userId: null });
  });

  it("is the header name the MCP streamable HTTP spec uses", async () => {
    const c = await lib();
    expect(c.MCP_SESSION_HEADER).toBe("mcp-session-id");
  });
});

describe("lookupConnection", () => {
  it("is null for an unknown id and for anything that is not a well-formed id", async () => {
    const c = await lib();
    expect(c.lookupConnection("q".repeat(43))).toBeNull();
    for (const bad of ["", "short", "q".repeat(42), "q".repeat(44), `${"q".repeat(42)}!`, "<script>", null, undefined]) {
      expect(c.lookupConnection(bad as never)).toBeNull();
    }
  });

  it("returns null for a connection older than the TTL, and does not refresh it", async () => {
    const c = await lib();
    const { getDb } = await import("../lib/db");
    let now = 100 * DAY;
    c._setConnectionClockForTests(() => now);
    const id = c._insertConnectionForTests();
    c.bindConnection(id, ALICE);
    now += 6 * DAY;
    expect(c.lookupConnection(id)?.userId).toBe(ALICE); // still alive, and refreshed
    const seen = () => (getDb().prepare("SELECT last_seen_at AS t FROM mcp_connections WHERE id = ?").get(id) as { t: number }).t;
    const refreshedAt = seen();
    now += c.CONNECTION_TTL_DAYS * DAY + 1;
    expect(c.lookupConnection(id)).toBeNull();
    expect(seen()).toBe(refreshedAt); // presenting a stale id does not keep it alive
    now += 1000;
    expect(c.lookupConnection(id)).toBeNull();
  });

  it("is alive right up to the TTL", async () => {
    const c = await lib();
    let now = 100 * DAY;
    c._setConnectionClockForTests(() => now);
    const id = c._insertConnectionForTests();
    now += c.CONNECTION_TTL_DAYS * DAY - 1;
    expect(c.lookupConnection(id)).not.toBeNull();
  });

  it("writes last_seen_at at most every 5 minutes", async () => {
    const c = await lib();
    let now = 5_000_000;
    c._setConnectionClockForTests(() => now);
    const id = c._insertConnectionForTests();
    const { getDb } = await import("../lib/db");
    const seen = () => (getDb().prepare("SELECT last_seen_at AS t FROM mcp_connections WHERE id = ?").get(id) as { t: number }).t;
    expect(seen()).toBe(now);
    now += 60_000;
    c.lookupConnection(id);
    expect(seen()).toBe(5_000_000);
    now += 5 * 60_000;
    c.lookupConnection(id);
    expect(seen()).toBe(now);
  });
});

describe("bindConnection", () => {
  it("binds a known connection to a person, and rebinding replaces", async () => {
    const c = await lib();
    const id = c._insertConnectionForTests();
    c.bindConnection(id, ALICE);
    expect(c.lookupConnection(id)!.userId).toBe(ALICE);
    c.bindConnection(id, MARIE);
    expect(c.lookupConnection(id)!.userId).toBe(MARIE);
  });

  it("adopts a well-formed id it has not seen, and refuses a malformed one", async () => {
    const c = await lib();
    c.bindConnection("z".repeat(43), ALICE);
    expect(c.lookupConnection("z".repeat(43))!.userId).toBe(ALICE);
    expect(() => c.bindConnection("not-an-id", ALICE)).toThrow();
  });
});

describe("listRecentConnections", () => {
  it("lists the person's identified connections seen in the last 7 days, newest first, without the id", async () => {
    const c = await lib();
    let now = 10 * DAY;
    c._setConnectionClockForTests(() => now);
    const old = c._insertConnectionForTests();
    c.bindConnection(old, ALICE);
    now += 6 * DAY;
    const fresh = c._insertConnectionForTests();
    c.bindConnection(fresh, ALICE);
    const other = c._insertConnectionForTests();
    c.bindConnection(other, MARIE);
    c._insertConnectionForTests(); // unbound: never listed
    now += 2 * DAY; // `old` was last seen 8 days ago

    const list = c.listRecentConnections(ALICE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ createdAt: expect.any(Number), lastSeenAt: expect.any(Number) });
    expect(JSON.stringify(list)).not.toContain(fresh);
    expect(JSON.stringify(list)).not.toContain(old);
  });
});

describe("expireStaleConnections", () => {
  it("deletes connections not seen for 7 days, bound or not, and keeps the rest", async () => {
    const c = await lib();
    let now = 100 * DAY;
    c._setConnectionClockForTests(() => now);
    const stale = c._insertConnectionForTests();
    const staleBound = c._insertConnectionForTests();
    c.bindConnection(staleBound, ALICE);
    now += 6 * DAY;
    const fresh = c._insertConnectionForTests();
    now += 2 * DAY;
    expect(c.expireStaleConnections()).toBe(2);
    expect(c.lookupConnection(stale)).toBeNull();
    expect(c.lookupConnection(staleBound)).toBeNull();
    expect(c.lookupConnection(fresh)).not.toBeNull();
  });

  it("is run by the maintenance sweep and reported", async () => {
    const c = await lib();
    const { getDb } = await import("../lib/db");
    c._insertConnectionForTests();
    getDb().prepare("UPDATE mcp_connections SET last_seen_at = ?").run(Date.now() - 8 * DAY);
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();
    expect(runMaintenance(true)?.connectionsExpired).toBe(1);
  });
});

describe("migration v34", () => {
  it("creates mcp_connections and drops device_connects, keeping devices", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    // How v33 left it: the connect table exists with a row, v34 not yet applied.
    db.exec("DROP TABLE mcp_connections");
    db.exec(
      "CREATE TABLE device_connects (nonce TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, label TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, requester_ip TEXT, raw_xff TEXT, raw_real_ip TEXT)",
    );
    db.prepare("INSERT INTO device_connects (nonce, secret_hash, label, expires_at) VALUES ('n', 'h', 'L', 1)").run();
    db.prepare("INSERT INTO devices (id, user_id, secret_hash, label, created_at) VALUES ('d1', ?, 'hh', 'L', 1)").run(ALICE);
    db.prepare("DELETE FROM migrations WHERE version >= 34").run();
    _resetDbForTests();

    const { getDb: again } = await import("../lib/db");
    const tables = (again().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("mcp_connections");
    expect(tables).not.toContain("device_connects");
    expect(again().prepare("SELECT user_id FROM devices WHERE id = 'd1'").get()).toEqual({ user_id: ALICE });
    expect(again().prepare("SELECT 1 FROM migrations WHERE version = 34").get()).toBeTruthy();
  });
});

describe("deleteConnectionsForUser", () => {
  it("ends every connection of that person and only theirs", async () => {
    const c = await lib();
    const a = c._insertConnectionForTests();
    const b = c._insertConnectionForTests();
    const hers = c._insertConnectionForTests();
    c.bindConnection(a, ALICE);
    c.bindConnection(b, ALICE);
    c.bindConnection(hers, MARIE);
    expect(c.deleteConnectionsForUser(ALICE)).toBe(2);
    expect(c.lookupConnection(a)).toBeNull();
    expect(c.lookupConnection(b)).toBeNull();
    expect(c.lookupConnection(hers)?.userId).toBe(MARIE);
    expect(c.deleteConnectionsForUser(ALICE)).toBe(0);
  });
});
