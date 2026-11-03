import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Command Center backfill: bab_command_center action=backfill_link mints a single-use link, and
 * POST /api/command-center/backfill/<token> takes one upload of historic worked lines for the
 * person who minted it. Each test gets its own DATA_DIR and a fresh database.
 */

let dataDir: string;
const OWNER = "owner.one@example.com";
const OTHER = "other.two@example.com";
const ORIGIN = "https://bab.example.com";
const NOW = Date.parse("2026-03-02T10:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const APP_TOKEN = randomBytes(24).toString("hex");

type Cc = typeof import("../lib/command-center");
let cc: Cc;

const device = (id: string) => ({ id, email: id, name: "Some One", source: "device" as const, deviceId: "dev-1" });
const ME = device(OWNER);

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-cc-backfill-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_PUBLIC_ORIGIN = ORIGIN;
  process.env.BAB_COMMAND_CENTER_EXPORT_APPS = `reports=${APP_TOKEN}`;
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  cc = await import("../lib/command-center");
  cc._resetCommandCenterForTests();
  (await import("../lib/rate-limit")).resetForTests();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: OWNER, email: OWNER, name: "Owner One", roles: [] });
  upsertUser({ id: OTHER, email: OTHER, name: "Other Two", roles: [] });
  cc.ccSetSwitch(OWNER, true);
});

afterEach(async () => {
  vi.useRealTimers();
  cc._resetCommandCenterForTests();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_PUBLIC_ORIGIN;
  delete process.env.BAB_COMMAND_CENTER;
  delete process.env.BAB_COMMAND_CENTER_EXPORT_APPS;
  delete process.env.BAB_MAX_BODY_BYTES;
  (await import("../lib/config"))._resetConfigForTests();
  vi.resetModules();
});

function mint(actor: Parameters<Cc["runCommandCenter"]>[0] = ME): { url: string; expiresAt: string; maxEntries: number; maxCurrent: number; maxBytes: number; how: string } {
  return cc.runCommandCenter(actor, { action: "backfill_link" }, "mcp", ORIGIN) as ReturnType<typeof mint>;
}

const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

function entry(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `s-1:${1_700_000_000_000 + n}`,
    initiative: "billing-export",
    worked: `Built part ${n} of the export`,
    size: "small",
    at: new Date(NOW - (n + 1) * DAY).toISOString(),
    session: "s-1",
    machine: "laptop-1",
    ...extra,
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const { POST } = await import("../app/api/command-center/backfill/[token]/route");
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const res = await POST(new Request(url, { method: "POST", body: raw, headers: { "content-type": "application/json", ...headers } }), {
    params: Promise.resolve({ token: tokenOf(url) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const upload = (entries: unknown[]) => ({ v: 1, entries });
const backfilled = (owner = OWNER) => cc.ccLogOf(owner).filter((e) => e.source === "backfill");

async function auditRows(action: string) {
  const { getDb } = await import("../lib/db");
  return getDb().prepare("SELECT actor_id, details FROM audit_log WHERE action = ?").all(action) as { actor_id: string; details: string }[];
}

async function linkRows() {
  const { getDb } = await import("../lib/db");
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM command_center_backfill_links").get() as { n: number }).n);
}

/** A live record stored directly, to fill the initiative cap without the per-minute rate limit. */
async function storeRecord(owner: string, id: string, title = "Some initiative") {
  const { getDb } = await import("../lib/db");
  const rec = { v: 1, id, title, area: null, key: null, state: "active", kind: "project", cadence: null, deadline: null, priority: null, tasks: [], questions: [], health: null, links: [], source: null, updatedAt: new Date(NOW).toISOString(), seq: 1, publishedBy: "token", writers: [] };
  const json = JSON.stringify(rec);
  getDb()
    .prepare("INSERT INTO command_center_initiatives (owner_id, id, record, seq, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(owner, id, json, 1, Buffer.byteLength(json), rec.updatedAt);
}

describe("backfill_link", () => {
  it("answers a link with its limits and stores only the token's hash", async () => {
    const link = mint();
    expect(link.url).toMatch(/^https:\/\/bab\.example\.com\/api\/command-center\/backfill\/[0-9a-f]{64}$/);
    expect(link).toMatchObject({ expiresAt: new Date(NOW + 15 * MINUTE).toISOString(), maxEntries: 2000, maxCurrent: 100, maxBytes: 1024 * 1024 });
    expect(link.how).toMatch(/upload mode/);
    const { getDb } = await import("../lib/db");
    const rows = getDb().prepare("SELECT * FROM command_center_backfill_links").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_id).toBe(OWNER);
    expect(JSON.stringify(rows)).not.toContain(tokenOf(link.url));
    const minted = await auditRows("cc_backfill_link");
    expect(minted).toHaveLength(1);
    expect(minted[0].details).not.toContain(tokenOf(link.url));
    expect(minted[0].details).not.toContain(String(rows[0].token_hash));
  });

  it("accepts the session ids and machine names the local tool sends", async () => {
    // The tool sends a transcript's session id (a UUID) and a host name cut to 20 characters.
    const sessions = Array.from({ length: 20 }, () => crypto.randomUUID());
    const entries = sessions.map((session, n) => entry(n, { id: `${session}:${1_700_000_000_000 + n}`, session, machine: "dev-box-01.local" }));
    const res = await post(mint().url, upload(entries));
    expect(res.json.refused).toEqual([]);
    expect(res.json.accepted).toBe(20);
  });

  it("takes no other fields", () => {
    expect(() => cc.runCommandCenter(ME, { action: "backfill_link", id: "x" }, "mcp", ORIGIN)).toThrow(/unknown field 'id' for backfill_link/);
  });

  it("refuses a header-only identity (403) and a person who is off (403)", () => {
    const declared = { id: OWNER, email: OWNER, name: "Owner One", source: "declared" as const };
    expect(() => mint(declared)).toThrow(/needs an identity BAB remembers or checks/);
    expect(() => mint(device(OTHER))).toThrow(/Command Center is off for Other Two/);
  });

  it("caps unused, unexpired links per person (429)", () => {
    for (let i = 0; i < cc.CC_BACKFILL_LINKS_PER_OWNER; i++) cc.createBackfillLink(OWNER, ORIGIN, "mcp");
    let status = 0;
    try {
      cc.createBackfillLink(OWNER, ORIGIN, "mcp");
    } catch (err) {
      status = (err as { status: number }).status;
    }
    expect(status).toBe(429);
    vi.setSystemTime(NOW + 16 * MINUTE);
    expect(cc.createBackfillLink(OWNER, ORIGIN, "mcp").url).toContain("/api/command-center/backfill/");
  });

  it("sweeps used and expired links", async () => {
    const used = mint();
    mint();
    expect((await post(used.url, upload([entry(1)]))).status).toBe(200);
    expect(await linkRows()).toBe(2);
    cc.sweepCommandCenter(NOW + MINUTE);
    expect(await linkRows()).toBe(1);
    cc.sweepCommandCenter(NOW + 16 * MINUTE);
    expect(await linkRows()).toBe(0);
  });

  it("reserves the id backfill: no initiative can be named that", () => {
    expect(() => cc.runCommandCenter(ME, { action: "publish", v: 1, id: "backfill", title: "x" }, "mcp", ORIGIN)).toThrow(/id 'backfill' is reserved/);
  });
});

describe("POST /api/command-center/backfill/:token", () => {
  it("stores the entries as worked lines from backfill under the minting person, with normalised times", async () => {
    await storeRecord(OWNER, "billing-export", "Billing export");
    const link = mint();
    const at = "2026-02-20T09:30:00+02:00";
    const res = await post(link.url, upload([entry(1, { at }), entry(2, { size: undefined })]));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ accepted: 2, duplicate: 0, refused: [], created: [], reassigned: [], syncCreated: 0, syncSkipped: 0, syncRefused: [] });
    const log = backfilled();
    expect(log).toHaveLength(2);
    expect(log.every((e) => e.kind === "worked" && e.initiative === "billing-export" && e.title === "Billing export")).toBe(true);
    expect(log.find((e) => e.text === "Built part 1 of the export")!.at).toBe("2026-02-20T07:30:00.000Z");
    expect(log[0].id).toBe(cc.ccEntryId("backfill", String(entry(1).id)));
    const rows = await auditRows("cc_backfill");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details)).toEqual({ accepted: 2, duplicate: 0, refused: 0, created: 0, reassigned: 0, syncCreated: 0, syncSkipped: 0, syncRefused: 0 });
    expect(rows[0].details).not.toContain("Built part");
  });

  it("is single use: a second POST is 404 and names the fix", async () => {
    const link = mint();
    expect((await post(link.url, upload([entry(1)]))).status).toBe(200);
    const again = await post(link.url, upload([entry(2)]));
    expect(again.status).toBe(404);
    expect(again.json.error).toMatch(/make a new one with bab_command_center action=backfill_link/);
    expect(backfilled()).toHaveLength(1);
    expect((await post(`${ORIGIN}/api/command-center/backfill/not-a-token`, upload([entry(3)]))).status).toBe(404);
  });

  it("expires after 15 minutes: 404 and nothing stored", async () => {
    const link = mint();
    vi.setSystemTime(NOW + 16 * MINUTE);
    const res = await post(link.url, upload([entry(1)]));
    expect(res.status).toBe(404);
    expect(backfilled()).toEqual([]);
  });

  it("is bound to the person who minted it: another person's records and log are untouched", async () => {
    cc.ccSetSwitch(OTHER, true);
    await storeRecord(OTHER, "billing-export", "Their billing");
    const link = mint();
    const res = await post(link.url, upload([entry(1)]), { "x-bab-actor-email": OTHER, "x-bab-actor-name": "Other Two" });
    expect(res.status).toBe(200);
    expect(res.json.reassigned).toEqual([{ index: 0, id: entry(1).id, reason: expect.stringMatching(/no initiative 'billing-export'/) }]);
    expect(backfilled(OWNER).map((e) => e.initiative)).toEqual(["unassigned"]);
    expect(cc.ccLogOf(OTHER)).toEqual([]);
    expect(cc.ccGet(OTHER, "billing-export")).toMatchObject({ title: "Their billing", seq: 1 });
  });

  it("is idempotent: the same upload through a second link is all duplicate and changes nothing", async () => {
    const entries = [entry(1, { initiative: "unassigned" }), entry(2, { initiative: "unassigned" })];
    expect((await post(mint().url, upload(entries))).json).toMatchObject({ accepted: 2, duplicate: 0 });
    const before = cc.ccLogOf(OWNER);
    const changed = entries.map((e) => ({ ...e, worked: "Different words" }));
    expect((await post(mint().url, upload(changed))).json).toMatchObject({ accepted: 0, duplicate: 2, refused: [] });
    expect(cc.ccLogOf(OWNER)).toEqual(before);
    const twice = await post(mint().url, upload([entry(5, { initiative: "unassigned" }), entry(5, { initiative: "unassigned" })]));
    expect(twice.json).toMatchObject({ accepted: 1, duplicate: 1 });
  });

  it("refuses more than 2000 entries (413) and spends the link", async () => {
    const link = mint();
    const many = Array.from({ length: 2001 }, (_, i) => entry(i % 300, { id: `e-${i}`, initiative: "unassigned" }));
    const res = await post(link.url, upload(many));
    expect(res.status).toBe(413);
    expect(res.json.error).toMatch(/at most 2000 per upload/);
    expect(backfilled()).toEqual([]);
    expect((await post(link.url, upload([entry(1)]))).status).toBe(404);
  });

  it("refuses a body over 1 MB with 413 after spending the link (no declared length)", async () => {
    const link = mint();
    const big = JSON.stringify(upload([entry(1, { worked: "x".repeat(1024 * 1024) })]));
    const res = await post(link.url, big);
    expect(res.status).toBe(413);
    expect(backfilled()).toEqual([]);
    expect((await post(link.url, upload([entry(1)]))).status).toBe(404);
  });

  it("refuses a declared Content-Length over 1 MB before spending the link: the gate first, the route when the gate allows more", async () => {
    const link = mint();
    const over = String(1024 * 1024 + 1);
    // Default BAB_MAX_BODY_BYTES is 1 MB too: the gate answers 413.
    expect((await post(link.url, upload([entry(1)]), { "content-length": over })).status).toBe(413);
    // With a larger gate cap, the route's own check answers 413, still before the link is spent.
    process.env.BAB_MAX_BODY_BYTES = String(4 * 1024 * 1024);
    (await import("../lib/config"))._resetConfigForTests();
    const res = await post(link.url, upload([entry(1)]), { "content-length": over });
    expect(res.status).toBe(413);
    expect(res.json.error).toMatch(/at most 1048576 bytes per backfill upload/);
    expect((await post(link.url, upload([entry(1)]))).status).toBe(200);
  });

  it("refuses a bad top level as a whole: unknown fields, v, empty entries, bad JSON", async () => {
    for (const body of [{ v: 1, entries: [entry(1)], owner: OTHER }, { v: 2, entries: [entry(1)] }, { v: 1, entries: [] }, "{not json", "[1]"]) {
      const res = await post(mint().url, body);
      expect(res.status).toBe(400);
      expect(typeof res.json.error).toBe("string");
    }
    expect(backfilled()).toEqual([]);
  });

  it("checks timestamps: more than 5 minutes ahead, older than the log keeps, and no zone are refused", async () => {
    const res = await post(
      mint().url,
      upload([
        entry(1, { at: new Date(NOW + 6 * MINUTE).toISOString() }),
        entry(2, { at: new Date(NOW - 401 * DAY).toISOString() }),
        entry(3, { at: "2026-02-20T09:30:00" }),
        entry(4, { at: new Date(NOW + 4 * MINUTE).toISOString() }),
      ]),
    );
    expect(res.status).toBe(200);
    const refused = res.json.refused as { index: number; reason: string }[];
    expect(refused.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(refused[0].reason).toMatch(/entries\[0\]\.at is in the future/);
    expect(refused[1].reason).toMatch(/older than the 400 days/);
    expect(refused[2].reason).toMatch(/with a zone/);
    expect(res.json.accepted).toBe(1);
  });

  it("refuses smuggled source, kind and seq fields per entry, naming the field", async () => {
    const res = await post(
      mint().url,
      upload([entry(1, { source: "live" }), entry(2, { kind: "note" }), entry(3, { seq: 9 }), entry(4, { initiative: "unassigned" })]),
    );
    expect(res.status).toBe(200);
    const refused = res.json.refused as { index: number; id: string; reason: string }[];
    expect(refused.map((r) => r.reason)).toEqual([
      expect.stringMatching(/^unknown field 'entries\[0\]\.source'/),
      expect.stringMatching(/^unknown field 'entries\[1\]\.kind'/),
      expect.stringMatching(/^unknown field 'entries\[2\]\.seq'/),
    ]);
    expect(refused[0].id).toBe(entry(1).id);
    expect(backfilled().map((e) => [e.kind, e.source])).toEqual([["worked", "backfill"]]);
  });

  it("refuses sensitive text in worked and never echoes it", async () => {
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const res = await post(mint().url, upload([entry(1, { worked: `used ${token} here`, initiative: "unassigned" })]));
    expect(res.status).toBe(200);
    expect(res.json.accepted).toBe(0);
    expect((res.json.refused as { reason: string }[])[0].reason).toMatch(/^worked holds .+, and Command Center never keeps confidential data/);
    expect(JSON.stringify(res.json)).not.toContain(token);
    expect(backfilled()).toEqual([]);
  });

  it("creates a parked record for an unknown initiative with a title, once, and counts it against the 100 cap", async () => {
    for (let i = 0; i < cc.CC_MAX_INITIATIVES - 1; i++) await storeRecord(OWNER, `init-${i}`);
    const res = await post(
      mint().url,
      upload([
        entry(1, { initiative: "new-thing", title: "A new thing", key: "KEY-1" }),
        entry(2, { initiative: "new-thing", title: "A new thing" }),
        entry(3, { initiative: "one-too-many", title: "Over the cap" }),
      ]),
    );
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ accepted: 3, created: ["new-thing"] });
    expect(res.json.reassigned).toEqual([{ index: 2, id: entry(3).id, reason: expect.stringMatching(/'one-too-many' could not be created/) }]);
    const rec = cc.ccGet(OWNER, "new-thing");
    expect(rec).toMatchObject({ state: "parked", kind: "project", title: "A new thing", key: "KEY-1", seq: 1, publishedBy: "backfill", tasks: [] });
    expect(cc.ccList(OWNER).usage.initiatives).toBe(cc.CC_MAX_INITIATIVES);
    expect(backfilled().map((e) => e.initiative).sort()).toEqual(["new-thing", "new-thing", "unassigned"]);
  });

  it("creates at most 20 initiatives per upload: further unknown ones go under unassigned with a reason", async () => {
    const extra = 3;
    const entries = Array.from({ length: cc.CC_BACKFILL_MAX_CREATED + extra }, (_, i) => entry(i, { initiative: `new-${i}`, title: `New ${i}` }));
    const res = await post(mint().url, upload(entries));
    expect(res.status).toBe(200);
    expect(res.json.accepted).toBe(cc.CC_BACKFILL_MAX_CREATED + extra);
    expect(res.json.created).toHaveLength(cc.CC_BACKFILL_MAX_CREATED);
    const reassigned = res.json.reassigned as { index: number; reason: string }[];
    const max = cc.CC_BACKFILL_MAX_CREATED;
    expect(reassigned.map((r) => r.index)).toEqual([max, max + 1, max + 2]);
    expect(reassigned.every((r) => r.reason.includes(`one upload creates at most ${max} initiatives`))).toBe(true);
    expect(cc.ccList(OWNER).usage.initiatives).toBe(cc.CC_BACKFILL_MAX_CREATED);
    expect(backfilled().filter((e) => e.initiative === "unassigned")).toHaveLength(extra);
  });

  it("audits the spent link with the verified client address before reading the body, also when the upload then fails", async () => {
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    try {
      (await import("../lib/config"))._resetConfigForTests();
      const link = mint();
      const res = await post(link.url, "{not json", { "x-real-ip": "203.0.113.9" });
      expect(res.status).toBe(400);
      const { getDb } = await import("../lib/db");
      const rows = getDb().prepare("SELECT actor_id, ip, details FROM audit_log WHERE action = 'cc_backfill_link_used'").all() as { actor_id: string; ip: string | null; details: string | null }[];
      expect(rows).toEqual([{ actor_id: OWNER, ip: "203.0.113.9", details: null }]);
      expect(await auditRows("cc_backfill")).toEqual([]);
      // A refused (unknown) link writes no such row.
      await post(link.url, upload([entry(1)]), { "x-real-ip": "203.0.113.9" });
      expect(await auditRows("cc_backfill_link_used")).toHaveLength(1);
    } finally {
      delete process.env.BAB_CLIENT_IP_HEADER;
    }
  });

  it("puts an unknown initiative without a title under unassigned", async () => {
    const res = await post(mint().url, upload([entry(1, { initiative: "nobody-knows" })]));
    expect(res.json).toMatchObject({ accepted: 1, created: [], reassigned: [{ index: 0, id: entry(1).id }] });
    expect(backfilled()[0]).toMatchObject({ initiative: "unassigned", title: "Unassigned" });
    expect(() => cc.ccGet(OWNER, "nobody-knows")).toThrow(/No initiative/);
  });

  it("is 403 when the person switched off after minting, and stores nothing", async () => {
    const link = mint();
    cc.ccSetSwitch(OWNER, false);
    const res = await post(link.url, upload([entry(1, { initiative: "unassigned" })]));
    expect(res.status).toBe(403);
    expect(res.json.error).toMatch(/Command Center is off for Owner One/);
    expect(backfilled()).toEqual([]);
  });

  it("is 404 when Command Center is switched off on this BAB, without spending the link", async () => {
    const link = mint();
    process.env.BAB_COMMAND_CENTER = "false";
    (await import("../lib/config"))._resetConfigForTests();
    expect((await post(link.url, upload([entry(1)]))).status).toBe(404);
    delete process.env.BAB_COMMAND_CENTER;
    (await import("../lib/config"))._resetConfigForTests();
    expect((await post(link.url, upload([entry(1, { initiative: "unassigned" })]))).status).toBe(200);
  });

  it("caps backfilled entries per person: the rest are refused with a reason", async () => {
    const { getDb } = await import("../lib/db");
    const stmt = getDb().prepare(
      "INSERT INTO command_center_log (owner_id, entry_id, initiative_id, title, key, kind, text, size, session, machine, source, at) VALUES (?, ?, 'unassigned', 'Unassigned', NULL, 'worked', 'x', NULL, NULL, NULL, 'backfill', ?)",
    );
    const at = new Date(NOW - DAY).toISOString();
    for (let i = 0; i < cc.CC_BACKFILL_MAX_PER_PERSON - 1; i++) stmt.run(OWNER, `fill-${i}`, at);
    const res = await post(mint().url, upload([entry(1, { initiative: "unassigned" }), entry(2, { initiative: "unassigned" })]));
    expect(res.json).toMatchObject({ accepted: 1 });
    expect((res.json.refused as { reason: string }[])[0].reason).toMatch(/at most 20000 backfilled entries per person/);
  });
});

describe("log entries without a record (unassigned)", () => {
  it("ccList, ccView, ccRecentLog, ccExportOwn and ccExportForApp cope with them", async () => {
    await post(mint().url, upload([entry(1, { initiative: "unassigned" }), entry(2, { initiative: "unassigned", size: "large" })]));
    expect(cc.ccList(OWNER).initiatives).toEqual([]);
    const view = cc.ccView(OWNER);
    expect(view.records).toEqual([]);
    expect(view.stamp).toContain("log:2:");
    expect(cc.ccRecentLog(OWNER, "unassigned")).toHaveLength(2);
    const own = cc.ccExportOwn(OWNER);
    expect(own.entries.map((e) => [e.initiative, e.title, e.source])).toEqual([
      ["unassigned", "Unassigned", "backfill"],
      ["unassigned", "Unassigned", "backfill"],
    ]);
    cc.ccGrantExport(OWNER, "reports", "aggregate");
    const app = cc.ccExportForApp("reports", {});
    const rows = app.people[0].rows!;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.initiative === "unassigned" && r.title === "Unassigned" && r.worked === 1 && r.backfilled === 1)).toBe(true);
  });
});

describe("current: open initiatives to create if absent", () => {
  const ISO_NOW = new Date(NOW).toISOString();
  const record = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: `Title of ${id}`,
    area: "platform",
    key: "KEY-7",
    state: "active",
    tasks: [
      { id: "t-1", text: "First task", status: "pending" },
      { id: "t-2", text: "Second task", status: "in_progress" },
      { id: "t-3", text: "Third task", status: "done" },
    ],
    questions: [{ id: "q-1", text: "Which months?", options: ["Jan", "Feb"] }],
    links: [{ label: "PR", url: "https://example.com/pr/1" }],
    ...extra,
  });
  const syncUpload = (current: unknown[], entries?: unknown[]) => ({ v: 1, current, ...(entries ? { entries } : {}) });
  const synced = (owner = OWNER) => cc.ccLogOf(owner).filter((e) => e.kind === "synced");
  const rawRecord = async (id: string) => {
    const { getDb } = await import("../lib/db");
    return getDb().prepare("SELECT record, seq, bytes, updated_at FROM command_center_initiatives WHERE owner_id = ? AND id = ?").get(OWNER, id);
  };

  it("creates an active record with server times and one synced log entry; a body with only current is valid", async () => {
    const res = await post(mint().url, syncUpload([record("alpha"), record("beta", { tasks: [], questions: [], links: [], area: undefined, key: undefined })]));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ accepted: 0, duplicate: 0, refused: [], created: [], reassigned: [], syncCreated: 2, syncSkipped: 0, syncRefused: [] });
    const rec = cc.ccGet(OWNER, "alpha");
    expect(rec).toMatchObject({ v: 1, id: "alpha", title: "Title of alpha", area: "platform", key: "KEY-7", state: "active", kind: "project", seq: 1, publishedBy: "backfill", updatedAt: ISO_NOW, writers: [], health: null, source: null });
    expect(rec.tasks).toEqual([
      { id: "t-1", text: "First task", status: "pending", startedAt: null, finishedAt: null },
      { id: "t-2", text: "Second task", status: "in_progress", startedAt: ISO_NOW, finishedAt: null },
      { id: "t-3", text: "Third task", status: "done", startedAt: ISO_NOW, finishedAt: ISO_NOW },
    ]);
    expect(rec.questions).toEqual([{ id: "q-1", text: "Which months?", options: ["Jan", "Feb"], askedAt: ISO_NOW, clearedAt: null, session: null }]);
    expect(rec.links).toEqual([{ label: "PR", url: "https://example.com/pr/1" }]);
    expect(cc.ccGet(OWNER, "beta")).toMatchObject({ area: null, key: null, tasks: [], questions: [], links: [] });
    expect(synced().map((e) => [e.initiative, e.title, e.key, e.source, e.at, e.text])).toEqual([
      ["alpha", "Title of alpha", "KEY-7", "backfill", ISO_NOW, null],
      ["beta", "Title of beta", null, "backfill", ISO_NOW, null],
    ]);
    // Only the synced entry: no derived task or question entries.
    expect(cc.ccLogOf(OWNER)).toHaveLength(2);
    expect(cc.ccRecentLog(OWNER, "alpha").map((e) => e.kind)).toEqual(["synced"]);
    const view = cc.ccView(OWNER);
    expect(view.records.map((r) => r.id).sort()).toEqual(["alpha", "beta"]);
    expect(view.records.find((r) => r.id === "alpha")!.log.map((e) => e.kind)).toEqual(["synced"]);
    expect(view.needsYou.map((n) => n.question.id)).toEqual(["q-1"]);
    expect(cc.CC_LOG_KINDS).toContain("synced");
  });

  it("takes no client times: time fields are refused, and server time is stamped", async () => {
    const withTimes = record("alpha", { tasks: [{ id: "t-1", text: "x", status: "done", finishedAt: "2020-01-01T00:00:00Z" }] });
    const res = await post(mint().url, syncUpload([withTimes]));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/unknown field 'current\[0\]\.tasks\[0\]\.finishedAt'/);
    vi.setSystemTime(NOW + 3 * MINUTE);
    expect((await post(mint().url, syncUpload([record("alpha")]))).status).toBe(200);
    const later = new Date(NOW + 3 * MINUTE).toISOString();
    const rec = cc.ccGet(OWNER, "alpha");
    expect(rec.updatedAt).toBe(later);
    expect(rec.tasks[2].finishedAt).toBe(later);
    expect(rec.questions[0].askedAt).toBe(later);
    expect(synced()[0].at).toBe(later);
  });

  it("skips an id the person already has: the live record is unchanged and the skip is counted", async () => {
    cc.ccPublish(device(OWNER), OWNER, { v: 1, id: "alpha", title: "Live title", tasks: [{ id: "a", text: "Live task", status: "in_progress" }], source: { machine: "m1", session: "s-live" } }, "mcp");
    const before = await rawRecord("alpha");
    const logBefore = cc.ccLogOf(OWNER);
    vi.setSystemTime(NOW + 2 * MINUTE);
    const res = await post(mint().url, syncUpload([record("alpha", { title: "Other title" }), record("gamma")]));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ syncCreated: 1, syncSkipped: 1, syncRefused: [] });
    expect(await rawRecord("alpha")).toEqual(before);
    expect(cc.ccGet(OWNER, "alpha")).toMatchObject({ title: "Live title", seq: 1 });
    expect(cc.ccLogOf(OWNER).filter((e) => e.initiative === "alpha")).toEqual(logBefore);
    expect(synced().map((e) => e.initiative)).toEqual(["gamma"]);
    // The same upload again: everything skipped, nothing new logged.
    const again = await post(mint().url, syncUpload([record("alpha"), record("gamma", { title: "Changed" })]));
    expect(again.json).toMatchObject({ syncCreated: 0, syncSkipped: 2 });
    expect(cc.ccGet(OWNER, "gamma").title).toBe("Title of gamma");
    expect(synced()).toHaveLength(1);
  });

  it("never overwrites a record written between the read and the insert (insert-if-absent)", async () => {
    // A racing writer: the row appears after the upload read the person's records, right before its insert.
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const orig = db.prepare.bind(db);
    let injected = false;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (!injected && sql.includes("ON CONFLICT(owner_id, id) DO NOTHING")) {
        injected = true;
        const rec = { v: 1, id: "alpha", title: "Racing live", area: null, key: null, state: "active", kind: "project", cadence: null, deadline: null, priority: null, tasks: [], questions: [], health: null, links: [], source: null, updatedAt: ISO_NOW, seq: 4, publishedBy: "token", writers: [] };
        const json = JSON.stringify(rec);
        orig("INSERT INTO command_center_initiatives (owner_id, id, record, seq, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(OWNER, "alpha", json, 4, Buffer.byteLength(json), ISO_NOW);
      }
      return orig(sql);
    });
    try {
      const res = await post(mint().url, syncUpload([record("alpha")]));
      expect(res.json).toMatchObject({ syncCreated: 0, syncSkipped: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(cc.ccGet(OWNER, "alpha")).toMatchObject({ title: "Racing live", seq: 4, publishedBy: "token" });
    expect(synced()).toEqual([]);
  });

  it("refuses an invalid record as a whole upload (400), naming the field, and stores nothing", async () => {
    // Many links: minted directly, past the per-minute pace of the MCP tool.
    const mint = () => cc.createBackfillLink(OWNER, ORIGIN, "mcp");
    const cases: [Record<string, unknown>, RegExp][] = [
      [record("alpha", { tasks: [{ id: "t-1", text: "x", status: "blocked" }] }), /current\[0\]\.tasks\[0\]\.status must be pending, in_progress or done/],
      [record("alpha", { owner: OTHER }), /unknown field 'current\[0\]\.owner'/],
      [record("alpha", { kind: "recurring" }), /unknown field 'current\[0\]\.kind'/],
      [record("alpha", { updatedAt: ISO_NOW }), /unknown field 'current\[0\]\.updatedAt'/],
      [record("alpha", { questions: [{ id: "q-1", text: "x", askedAt: ISO_NOW }] }), /unknown field 'current\[0\]\.questions\[0\]\.askedAt'/],
      [record("backfill"), /current\[0\]\.id 'backfill' is reserved/],
      [record("export"), /current\[0\]\.id 'export' is reserved/],
      [record("Not A Slug"), /current\[0\]\.id must be a slug/],
      [record("alpha", { state: "done" }), /current\[0\]\.state must be "active"/],
      [record("alpha", { state: undefined }), /current\[0\]\.state must be "active"/],
      [record("alpha", { title: "" }), /current\[0\]\.title is required/],
      [record("alpha", { title: "x".repeat(121) }), /current\[0\]\.title is 121 characters; at most 120/],
      [record("alpha", { key: "not-a-key" }), /current\[0\]\.key must be a ticket key/],
      [record("alpha", { links: [{ label: "x", url: "http://example.com" }] }), /current\[0\]\.links\[0\]\.url must start with https:\/\//],
      [record("alpha", { questions: Array.from({ length: 6 }, (_, i) => ({ id: `q-${i}`, text: "x" })) }), /current\[0\]\.questions: at most 5 open/],
      [record("alpha", { tasks: Array.from({ length: 51 }, (_, i) => ({ id: `t-${i}`, text: "x", status: "pending" })) }), /current\[0\]\.tasks: at most 50 tasks/],
      [record("alpha", { tasks: [{ id: "t", text: "x", status: "pending" }, { id: "t", text: "y", status: "pending" }] }), /tasks\[1\]\.id 't' is used twice/],
      [record("alpha", { questions: [{ id: "q", text: "x", options: ["a", "b", "c", "d", "e"] }] }), /options: at most 4 options/],
    ];
    for (const [rec, msg] of cases) {
      const res = await post(mint().url, syncUpload([record("fine"), rec], [entry(1, { initiative: "unassigned" })]));
      expect(res.status, String(msg)).toBe(400);
      expect(String(res.json.error).replace("current[1]", "current[0]")).toMatch(msg);
    }
    const dup = await post(mint().url, syncUpload([record("alpha"), record("alpha")]));
    expect(dup.status).toBe(400);
    expect(dup.json.error).toMatch(/current\[1\]\.id 'alpha' is used twice/);
    for (const body of [{ v: 1, current: "x" }, { v: 1, current: [] }, { v: 1, entries: [], current: [] }, { v: 1, current: ["x"] }, { v: 1, entries: "x", current: [record("alpha")] }]) {
      expect((await post(mint().url, body)).status).toBe(400);
    }
    expect(cc.ccList(OWNER).initiatives).toEqual([]);
    expect(cc.ccLogOf(OWNER)).toEqual([]);
    expect(await auditRows("cc_backfill")).toEqual([]);
  });

  it("refuses more than 100 records (413) and spends the link", async () => {
    const link = mint();
    const res = await post(link.url, syncUpload(Array.from({ length: 101 }, (_, i) => record(`r-${i}`))));
    expect(res.status).toBe(413);
    expect(res.json.error).toMatch(/current: at most 100 records per upload/);
    expect(cc.ccList(OWNER).initiatives).toEqual([]);
    expect((await post(link.url, syncUpload([record("alpha")]))).status).toBe(404);
  });

  it("refuses secret-shaped text like publish does, without echoing it", async () => {
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    for (const rec of [
      record("alpha", { tasks: [{ id: "t-1", text: `use ${token}`, status: "pending" }] }),
      record("alpha", { title: `token ${token}` }),
      record("alpha", { questions: [{ id: "q-1", text: `is ${token} ok?` }] }),
      record("alpha", { links: [{ label: "x", url: `https://example.com/?t=${token}` }] }),
    ]) {
      const res = await post(mint().url, syncUpload([rec]));
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/holds .+, and Command Center never keeps confidential data/);
      expect(JSON.stringify(res.json)).not.toContain(token);
    }
    // Publish refuses the same text the same way.
    expect(() => cc.ccPublish(device(OWNER), OWNER, { v: 1, id: "alpha", title: "x", tasks: [{ id: "t-1", text: `use ${token}`, status: "pending" }] }, "mcp")).toThrow(/tasks\[0\]\.text holds/);
    expect(cc.ccList(OWNER).initiatives).toEqual([]);
  });

  it("shares the 20 new initiatives per upload with entries: current first, then entries go to unassigned", async () => {
    const current = Array.from({ length: 15 }, (_, i) => record(`cur-${i}`));
    const entries = Array.from({ length: 10 }, (_, i) => entry(i, { initiative: `log-${i}`, title: `Log ${i}` }));
    const res = await post(mint().url, syncUpload(current, entries));
    expect(res.status).toBe(200);
    expect(res.json.syncCreated).toBe(15);
    expect(res.json.created).toHaveLength(5);
    expect((res.json.reassigned as { index: number; reason: string }[]).map((r) => r.index)).toEqual([5, 6, 7, 8, 9]);
    expect(cc.ccList(OWNER).usage.initiatives).toBe(20);

    // Over the cap in current itself: the rest are listed in syncRefused; skips do not count.
    await storeRecord(OWNER, "already-here");
    const many = [record("already-here"), ...Array.from({ length: 22 }, (_, i) => record(`more-${i}`))];
    const res2 = await post(mint().url, syncUpload(many));
    expect(res2.json).toMatchObject({ syncCreated: 20, syncSkipped: 1 });
    const refused = res2.json.syncRefused as { index: number; id: string; reason: string }[];
    expect(refused.map((r) => [r.index, r.id])).toEqual([
      [21, "more-20"],
      [22, "more-21"],
    ]);
    expect(refused.every((r) => r.reason.includes("one upload creates at most 20 initiatives"))).toBe(true);
  });

  it("respects the 100 initiative cap per person: the rest go to syncRefused", async () => {
    for (let i = 0; i < cc.CC_MAX_INITIATIVES - 1; i++) await storeRecord(OWNER, `init-${i}`);
    const res = await post(mint().url, syncUpload([record("last-one"), record("one-too-many")]));
    expect(res.json).toMatchObject({ syncCreated: 1, syncSkipped: 0 });
    expect(res.json.syncRefused).toEqual([{ index: 1, id: "one-too-many", reason: expect.stringMatching(/could not be created: You have 100 initiatives/) }]);
    expect(() => cc.ccGet(OWNER, "one-too-many")).toThrow(/No initiative/);
  });

  it("an entry for an initiative created by current in the same upload lands under it", async () => {
    const res = await post(mint().url, syncUpload([record("alpha")], [entry(1, { initiative: "alpha" })]));
    expect(res.json).toMatchObject({ accepted: 1, created: [], reassigned: [], syncCreated: 1 });
    expect(backfilled().map((e) => [e.initiative, e.kind, e.title, e.key])).toEqual(
      expect.arrayContaining([
        ["alpha", "worked", "Title of alpha", "KEY-7"],
        ["alpha", "synced", "Title of alpha", "KEY-7"],
      ]),
    );
  });

  it("audits counts only, never titles or task text", async () => {
    await storeRecord(OWNER, "already-here");
    await post(mint().url, syncUpload([record("alpha"), record("already-here")], [entry(1, { initiative: "unassigned" })]));
    const rows = await auditRows("cc_backfill");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details)).toEqual({ accepted: 1, duplicate: 0, refused: 0, created: 0, reassigned: 0, syncCreated: 1, syncSkipped: 1, syncRefused: 0 });
    for (const s of ["Title of alpha", "First task", "Which months?", "alpha", "example.com"]) expect(rows[0].details).not.toContain(s);
  });

  it("keeps the opt-in gate: off after minting is 403 and nothing is created", async () => {
    const link = mint();
    cc.ccSetSwitch(OWNER, false);
    const res = await post(link.url, syncUpload([record("alpha")]));
    expect(res.status).toBe(403);
    expect(cc.ccLogOf(OWNER)).toEqual([]);
    cc.ccSetSwitch(OWNER, true);
    expect(() => cc.ccGet(OWNER, "alpha")).toThrow(/No initiative/);
  });

  it("exports synced entries: counted in entries and backfilled, not in worked", async () => {
    await post(mint().url, syncUpload([record("alpha")], [entry(1, { initiative: "alpha", at: ISO_NOW })]));
    expect(cc.ccExportOwn(OWNER).entries.map((e) => e.kind).sort()).toEqual(["synced", "worked"]);
    cc.ccGrantExport(OWNER, "reports", "aggregate");
    const rows = cc.ccExportForApp("reports", {}).people[0].rows!;
    expect(rows).toEqual([{ initiative: "alpha", title: "Title of alpha", key: "KEY-7", day: ISO_NOW.slice(0, 10), entries: 2, worked: 1, backfilled: 2, sizes: { small: 1, medium: 0, large: 0 } }]);
  });
});
