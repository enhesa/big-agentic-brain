import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionUser } from "../lib/session";

/**
 * The anonymous link routes (upload, download, backfill) check the per-address bucket before the
 * token lookup, and spend a process-wide bucket only after a failed lookup. A flood of wrong tokens
 * must not lock out a caller with a good link, and every 429 says when to retry.
 */

let dataDir: string;
const OWNER = "owner.one@example.com";
const ORIGIN = "https://bab.example.com";
const device: SessionUser = { id: OWNER, email: OWNER, name: "Owner One", roles: [], source: "device" };
const BAD_TOKEN = "A".repeat(43);

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-link-rate-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_PUBLIC_ORIGIN = ORIGIN;
  vi.resetModules();
  (await import("../lib/rate-limit")).resetForTests();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: OWNER, email: OWNER, name: "Owner One", roles: [] });
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  (await import("../lib/rate-limit")).resetForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_PUBLIC_ORIGIN;
  delete process.env.BAB_CLIENT_IP_HEADER;
  (await import("../lib/config"))._resetConfigForTests();
  vi.resetModules();
});

async function fill(key: string, limit: number) {
  const { checkRateLimit } = await import("../lib/rate-limit");
  for (let i = 0; i < limit; i++) checkRateLimit(key, limit);
}

async function uploadLink(name: string): Promise<string> {
  const { findTool } = await import("../lib/mcp");
  const l = JSON.parse(await findTool("bab_files")!.run(device, { action: "upload_link", name }, { origin: ORIGIN }));
  return new URL(l.url).pathname.split("/").pop()!;
}

async function upload(token: string, headers: Record<string, string> = {}) {
  const { POST } = await import("../app/api/files/up/[token]/route");
  const body = new TextEncoder().encode("hello");
  const req = new Request(`${ORIGIN}/api/files/up/${token}`, { method: "POST", body: body as unknown as BodyInit, headers: { "content-length": String(body.length), ...headers } });
  return POST(req, { params: Promise.resolve({ token }) });
}

async function download(token: string) {
  const { GET } = await import("../app/api/files/dl/[token]/route");
  return GET(new Request(`${ORIGIN}/api/files/dl/${token}`), { params: Promise.resolve({ token }) });
}

async function backfill(token: string) {
  const { POST } = await import("../app/api/command-center/backfill/[token]/route");
  const body = JSON.stringify({ v: 1, entries: [], current: [] });
  const req = new Request(`${ORIGIN}/api/command-center/backfill/${token}`, { method: "POST", body, headers: { "content-type": "application/json" } });
  return POST(req, { params: Promise.resolve({ token }) });
}

describe("upload links", () => {
  it("a wrong token spends the route's own bucket; a good link still works once it is spent", async () => {
    const { ANON_GLOBAL_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
    expect((await upload(BAD_TOKEN)).status).toBe(404);
    await fill("anon-link-miss:files-up", ANON_GLOBAL_LIMIT_PER_MINUTE);
    const refused = await upload(BAD_TOKEN);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    // The old shared anonymous bucket is no longer spent here, and a good link passes.
    await fill("anon-global", ANON_GLOBAL_LIMIT_PER_MINUTE);
    expect((await upload(await uploadLink("ok.txt"))).status).toBe(201);
  });

  it("keeps the per-address limit before the lookup, with Retry-After", async () => {
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    (await import("../lib/config"))._resetConfigForTests();
    const { ANON_RATE_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
    const token = await uploadLink("a.txt");
    await fill("anon:203.0.113.9", ANON_RATE_LIMIT_PER_MINUTE);
    const refused = await upload(token, { "x-real-ip": "203.0.113.9" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
    // The refused request did not spend the link: another address can still use it.
    expect((await upload(token, { "x-real-ip": "203.0.113.10" })).status).toBe(201);
  });
});

describe("download links", () => {
  it("a good link passes while wrong tokens have spent the miss bucket, and is capped per file", async () => {
    const { ANON_GLOBAL_LIMIT_PER_MINUTE, ANON_RATE_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
    const put = await upload(await uploadLink("d.txt"));
    const fileId = (await put.json()).file.id as string;
    const { createDownloadLink } = await import("../lib/files");
    const token = createDownloadLink(OWNER, fileId, ORIGIN).url.split("/").pop()!;

    await fill("anon-link-miss:files-dl", ANON_GLOBAL_LIMIT_PER_MINUTE);
    const miss = await download(BAD_TOKEN);
    expect(miss.status).toBe(429);
    expect(miss.headers.get("retry-after")).toBeTruthy();
    expect((await download(token)).status).toBe(200);

    await fill(`anon-link-file:${fileId}`, ANON_RATE_LIMIT_PER_MINUTE);
    const capped = await download(token);
    expect(capped.status).toBe(429);
    expect(capped.headers.get("retry-after")).toBeTruthy();
  });
});

describe("backfill links", () => {
  it("a wrong token gets 404 until the route's miss bucket is spent, then 429; a good link still works", async () => {
    const { ANON_GLOBAL_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
    expect((await backfill(BAD_TOKEN)).status).toBe(404);
    await fill("anon-link-miss:cc-backfill", ANON_GLOBAL_LIMIT_PER_MINUTE);
    const refused = await backfill(BAD_TOKEN);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();

    const { runCommandCenter } = await import("../lib/command-center");
    const minted = runCommandCenter(device, { action: "backfill_link" }, "mcp", ORIGIN) as { url: string };
    // The good link is found and spent: whatever the body's verdict, it is neither 404 nor 429.
    const res = await backfill(minted.url.split("/").pop()!);
    expect([404, 429]).not.toContain(res.status);
  });
});

describe("retryAfterSeconds", () => {
  it("counts down to the end of the bucket's window", async () => {
    const rl = await import("../lib/rate-limit");
    let now = 1_000_000;
    rl._setClockForTests(() => now);
    expect(rl.retryAfterSeconds("none")).toBe(1);
    rl.checkRateLimit("k", 1);
    expect(rl.retryAfterSeconds("k")).toBe(60);
    now += 45_500;
    expect(rl.retryAfterSeconds("k")).toBe(15);
    now += 20_000;
    expect(rl.retryAfterSeconds("k")).toBe(1);
  });
});
