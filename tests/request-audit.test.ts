import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-request-audit-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }),
  }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

describe("auditRequest", () => {
  it("writes a row with actor_name, actor_email, path and the RIGHT-most x-forwarded-for hop (the proxy-added one)", async () => {
    const { auditRequest } = await import("../lib/request-audit");
    const { getDb } = await import("../lib/db");

    await auditRequest({
      actor: { id: "ada@example.com", name: "Ada", email: "ada@example.com" },
      method: "GET",
      path: "/board",
      via: "ui",
    });

    const row = getDb()
      .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as {
      actor_id: string;
      actor_name: string | null;
      actor_email: string | null;
      path: string | null;
      ip: string | null;
      via: string;
      action: string;
    };

    expect(row.actor_id).toBe("ada@example.com");
    expect(row.actor_name).toBe("Ada");
    expect(row.actor_email).toBe("ada@example.com");
    expect(row.path).toBe("/board");
    expect(row.ip).toBe("10.0.0.1");
    expect(row.via).toBe("ui");
    expect(row.action).toBe("GET");
  });

  it("falls back to x-real-ip when there is no x-forwarded-for", async () => {
    vi.doUnmock("next/headers");
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-real-ip": "198.51.100.9" }),
    }));

    const { auditRequest } = await import("../lib/request-audit");
    const { getDb } = await import("../lib/db");

    await auditRequest({
      actor: { id: "bob@example.com", name: "Bob", email: "bob@example.com" },
      method: "POST",
      path: "/todos",
      via: "mcp",
    });

    const row = getDb()
      .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { ip: string | null };
    expect(row.ip).toBe("198.51.100.9");
  });

  it("never throws, even when reading the request fails", async () => {
    vi.doUnmock("next/headers");
    vi.doMock("next/headers", () => ({
      headers: async () => {
        throw new Error("boom");
      },
    }));

    const { auditRequest } = await import("../lib/request-audit");
    await expect(
      auditRequest({
        actor: { id: "x@example.com", name: "X", email: "x@example.com" },
        method: "GET",
        path: "/x",
        via: "ui",
      }),
    ).resolves.toBeNull();
  });
});

describe("recordSearchOutcome", () => {
  it("adds the result count and the redacted, cut query to the row it was given, keeping its other details", async () => {
    const { auditRequest, recordSearchOutcome, SEARCH_QUERY_MAX } = await import("../lib/request-audit");
    const { getDb } = await import("../lib/db");
    const id = await auditRequest({
      actor: { id: "ada@example.com", name: "Ada", email: "ada@example.com", source: "device" },
      method: "GET",
      path: "/api/learnings",
      via: "mcp",
    });
    expect(typeof id).toBe("number");
    const token = "sk-" + "a".repeat(30);
    recordSearchOutcome(id, { results: 0, query: `  why does   ${token} fail ${"y".repeat(300)}` });
    recordSearchOutcome(null, { results: 3, query: "ignored" });
    const r = getDb().prepare("SELECT details FROM audit_log WHERE id = ?").get(id) as { details: string };
    const d = JSON.parse(r.details);
    expect(d.source).toBe("device");
    expect(d.results).toBe(0);
    expect(d.q.startsWith("why does [redacted] fail")).toBe(true);
    expect(d.q.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX);
    expect(r.details).not.toContain(token);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBe(1);
  });

  it("stores only the count when there is no query text", async () => {
    const { auditRequest, recordSearchOutcome } = await import("../lib/request-audit");
    const { getDb } = await import("../lib/db");
    const id = await auditRequest({ actor: { id: "ada@example.com", name: null, email: null }, method: "GET", path: "/api/learnings", via: "mcp" });
    recordSearchOutcome(id, { results: 4, query: "   " });
    const r = getDb().prepare("SELECT details FROM audit_log WHERE id = ?").get(id) as { details: string };
    expect(JSON.parse(r.details)).toEqual({ results: 4 });
  });
});

describe("auditRequest: identity source (P1.2, device since 2026-10-01)", () => {
  it("records details.source when the actor carries one, so header callers can be told from device callers", async () => {
    const { auditRequest } = await import("../lib/request-audit");
    const { getDb } = await import("../lib/db");
    await auditRequest({
      actor: { id: "ada@example.com", name: "Ada", email: "ada@example.com", source: "device" },
      method: "POST",
      path: "/api/inbox",
      via: "mcp",
    });
    await auditRequest({
      actor: { id: "bob@example.com", name: "Bob", email: "bob@example.com", source: "declared" },
      method: "POST",
      path: "/api/inbox",
      via: "mcp",
    });
    const rows = getDb().prepare("SELECT actor_id, details FROM audit_log ORDER BY id").all() as {
      actor_id: string;
      details: string | null;
    }[];
    expect(rows.map((r) => [r.actor_id, JSON.parse(r.details ?? "null")])).toEqual([
      ["ada@example.com", { source: "device" }],
      ["bob@example.com", { source: "declared" }],
    ]);
  });

  it("writes no details for an actor without a source, and for the anonymous viewer", async () => {
    const { auditRequest } = await import("../lib/request-audit");
    const { getDb } = await import("../lib/db");
    await auditRequest({ actor: { id: "ada@example.com", name: null, email: null }, method: "GET", path: "/x", via: "ui" });
    await auditRequest({ actor: null, method: "GET", path: "/y", via: "ui" });
    const rows = getDb().prepare("SELECT details FROM audit_log").all() as { details: string | null }[];
    expect(rows.every((r) => r.details === null)).toBe(true);
  });
});
