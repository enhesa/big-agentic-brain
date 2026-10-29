import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionUser } from "../lib/session";

/** Single-use upload links: bab_files action=upload_link, then POST /api/files/up/<token>. */

let dataDir: string;
const OWNER = "owner.one@example.com";
const OTHER = "other.two@example.com";
const ORIGIN = "https://bab.example.com";
const device: SessionUser = { id: OWNER, email: OWNER, name: "Owner One", roles: [], source: "device" };

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-files-up-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_PUBLIC_ORIGIN = ORIGIN;
  vi.resetModules();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: OWNER, email: OWNER, name: "Owner One", roles: [] });
  upsertUser({ id: OTHER, email: OTHER, name: "Other Two", roles: [] });
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_PUBLIC_ORIGIN;
  delete process.env.BAB_API_TOKENS;
  delete process.env.BAB_CLIENT_IP_HEADER;
  for (const k of Object.keys(process.env)) if (k.startsWith("BAB_FILES")) delete process.env[k];
  (await import("../lib/config"))._resetConfigForTests();
  vi.resetModules();
});

async function link(args: Record<string, unknown>, actor: SessionUser = device) {
  const { findTool } = await import("../lib/mcp");
  return JSON.parse(await findTool("bab_files")!.run(actor, { action: "upload_link", ...args }, { origin: ORIGIN }));
}

async function send(url: string, body: Uint8Array, headers: Record<string, string> = {}) {
  const { POST } = await import("../app/api/files/up/[token]/route");
  const token = new URL(url).pathname.split("/").pop()!;
  const req = new Request(url, { method: "POST", body: body as unknown as BodyInit, headers: { "content-length": String(body.length), ...headers } });
  return POST(req, { params: Promise.resolve({ token }) });
}

const text = (s: string) => new TextEncoder().encode(s);

describe("upload links", () => {
  it("stores a file sent with plain curl, once, with everything fixed at creation", async () => {
    const l = await link({ name: "report.md", to: OTHER, note: "for you", expiresInDays: 3 });
    expect(l.url).toMatch(/^https:\/\/bab\.example\.com\/api\/files\/up\/[A-Za-z0-9_-]{43}$/);
    expect(l.how).toContain("curl -X POST --data-binary @");
    const body = text("hello upload link\n");
    const res = await send(l.url, body);
    expect(res.status).toBe(201);
    const put = await res.json();
    expect(put.file).toMatchObject({ name: "report.md", owner: OWNER, size: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    expect(put.delivery.to).toBe(OTHER);
    // Used: a second upload to the same link is refused like an unknown one.
    expect((await send(l.url, body)).status).toBe(404);
  });

  it("ignores query parameters on the link: name, owner and recipient come from the link", async () => {
    const l = await link({ name: "fixed.txt" });
    const res = await send(`${l.url}?name=evil.exe&to=${OTHER}&orgVisible=true`, text("abc"));
    expect(res.status).toBe(201);
    const put = await res.json();
    expect(put.file.name).toBe("fixed.txt");
    expect(put.file.orgVisible).toBe(false);
    expect(put.delivery).toBeUndefined();
  });

  it("refuses an expired, unknown or malformed link the same way", async () => {
    const l = await link({ name: "a.txt" });
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE file_upload_links SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    expect((await send(l.url, text("abc"))).status).toBe(404);
    expect((await send(`${ORIGIN}/api/files/up/${"x".repeat(43)}`, text("abc"))).status).toBe(404);
    expect((await send(`${ORIGIN}/api/files/up/short`, text("abc"))).status).toBe(404);
  });

  it("is made only by a caller the file store serves, and checks the name and recipient up front", async () => {
    await expect(link({ name: "a.txt" }, { ...device, source: "declared" })).rejects.toThrow(/identity BAB remembers or checks/);
    await expect(link({ name: "setup.exe" })).rejects.toThrow(/refused/);
    await expect(link({ name: "a.txt", to: "nobody.here@example.com" })).rejects.toThrow(/Unknown recipient/);
    await expect(link({})).rejects.toThrow(/name is required/);
  });

  it("applies every upload check, and a refused upload spends the link", async () => {
    process.env.BAB_FILES_MAX_FILE_BYTES = "1000";
    process.env.BAB_FILES_USER_QUOTA_BYTES = "1500";
    (await import("../lib/config"))._resetConfigForTests();
    const big = await link({ name: "big.bin" });
    expect((await send(big.url, new Uint8Array(1001).fill(0x61))).status).toBe(413);
    expect((await send(big.url, text("small"))).status).toBe(404);
    // A secret in a text file, and a program, are refused through a link too.
    const sec = await link({ name: "conf.txt" });
    const secRes = await send(sec.url, text("pass" + "word=" + "Zq7" + "Xv9Lm2Rt"));
    expect(secRes.status).toBe(400);
    expect((await secRes.json()).error).toMatch(/secret/);
    const elf = await link({ name: "tool.bin" });
    expect((await send(elf.url, new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1]))).status).toBe(400);
    // The owner's quota applies.
    const a = await link({ name: "a.bin" });
    expect((await send(a.url, new Uint8Array(1000).fill(0x61))).status).toBe(201);
    const b = await link({ name: "b.bin" });
    expect((await send(b.url, new Uint8Array(900).fill(0x61))).status).toBe(507);
  });

  it("caps unused links per person", async () => {
    const { UPLOAD_LINKS_PER_OWNER } = await import("../lib/files");
    for (let i = 0; i < UPLOAD_LINKS_PER_OWNER; i++) await link({ name: `f${i}.txt` });
    await expect(link({ name: "one-more.txt" })).rejects.toThrow(/unused upload links/);
  });

  it("audits the verified client address on use, and never the token", async () => {
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    (await import("../lib/config"))._resetConfigForTests();
    const l = await link({ name: "a.txt" });
    expect((await send(l.url, text("abc"), { "x-real-ip": "203.0.113.5" })).status).toBe(201);
    const { getDb } = await import("../lib/db");
    const rows = getDb().prepare("SELECT action, ip, details FROM audit_log WHERE action IN ('file_upload_link_used', 'file_put') ORDER BY id").all() as { action: string; ip: string; details: string }[];
    expect(rows.map((r) => [r.action, r.ip])).toEqual([
      ["file_upload_link_used", "203.0.113.5"],
      ["file_put", "203.0.113.5"],
    ]);
    const token = l.url.split("/").pop();
    expect(JSON.stringify(getDb().prepare("SELECT * FROM audit_log").all())).not.toContain(token);
    expect(JSON.stringify(getDb().prepare("SELECT * FROM file_upload_links").all())).not.toContain(token);
  });

  it("works without a token in token mode (the link is the credential), and passes the gate for a body over 1 MB", async () => {
    process.env.BAB_API_TOKENS = "t0ken-for-tests-only";
    process.env.BAB_FILES_MAX_FILE_BYTES = String(3 * 1024 * 1024);
    (await import("../lib/db"))._resetDbForTests();
    vi.resetModules();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: OWNER, email: OWNER, name: "Owner One", roles: [] });
    const { isPublicPath } = await import("../lib/public-paths");
    expect(isPublicPath("/api/files/up/abc")).toBe(true);
    const { gate } = await import("../lib/gate");
    const big = (p: string) => new Request(`http://x${p}`, { method: "POST", headers: { "content-length": String(2 * 1024 * 1024) } });
    expect(gate(big("/api/files/up/abc"))).toBeNull();
    expect(gate(big("/mcp"))?.status).toBe(413);
    expect(await gate(big("/mcp"))!.json()).toMatchObject({ error: expect.stringMatching(/upload_link/) });
    const l = await link({ name: "big.bin" });
    const body = new Uint8Array(2 * 1024 * 1024).fill(0x61);
    expect((await send(l.url, body)).status).toBe(201);
  });

  it("maintenance drops used and expired links", async () => {
    const l = await link({ name: "a.txt" });
    await link({ name: "b.txt" });
    await send(l.url, text("abc"));
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE file_upload_links SET expires_at = ? WHERE used_at IS NULL").run("2000-01-01T00:00:00.000Z");
    const { purgeRemovable } = await import("../lib/files");
    purgeRemovable();
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM file_upload_links").get() as { n: number }).n).toBe(0);
  });
});
