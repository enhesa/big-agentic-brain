import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;
const OWNER = "owner.one@example.com";
const OTHER = "other.two@example.com";
let actor: { email: string; name: string } | null = null;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-files-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";
  vi.resetModules();
  actor = null;
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers(actor ? { "x-bab-actor-email": actor.email, "x-bab-actor-name": actor.name } : {}),
  }));
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
  vi.doUnmock("next/headers");
  vi.resetModules();
});

const as = (email: string, name: string) => {
  actor = { email, name };
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function upload(name: string, body: Uint8Array, query = "") {
  const { POST } = await import("../app/api/files/route");
  const req = new Request(`http://x/api/files?name=${encodeURIComponent(name)}${query}`, {
    method: "POST",
    body: body as unknown as BodyInit,
    headers: { "content-length": String(body.length), "content-type": "application/octet-stream" },
  });
  return POST(req as never);
}

describe("/api/files", () => {
  it("401s without an identity", async () => {
    const { GET } = await import("../app/api/files/route");
    expect((await GET(new Request("http://x/api/files"))).status).toBe(401);
    expect((await upload("a.txt", new Uint8Array([1]))).status).toBe(401);
  });

  it("uploads, lists, fetches by id and by link, shares and deletes", async () => {
    as(OWNER, "Owner One");
    const body = new TextEncoder().encode("hello files\n");
    const res = await upload("hello.txt", body, "&expiresInDays=2");
    expect(res.status).toBe(201);
    const put = await res.json();
    expect(put.file.sha256).toBe(sha(body));
    expect(put.usage.usedBytes).toBe(body.length);

    const { GET: LIST } = await import("../app/api/files/route");
    const list = await (await LIST(new Request("http://x/api/files"))).json();
    expect(list.files.map((f: { id: string }) => f.id)).toEqual([put.file.id]);
    expect(list.usage).toMatchObject({ usedBytes: body.length, quotaBytes: 100 * 1024 * 1024 });

    const { GET: CONTENT } = await import("../app/api/files/[id]/content/route");
    const content = await CONTENT(new Request("http://x") as never, ctx(put.file.id));
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("application/octet-stream");
    expect(content.headers.get("content-disposition")).toContain('attachment; filename="hello.txt"');
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("cache-control")).toBe("no-store");
    expect(sha(new Uint8Array(await content.arrayBuffer()))).toBe(put.file.sha256);

    const { GET: META, PATCH, DELETE } = await import("../app/api/files/[id]/route");
    const meta = await (await META(new Request("http://x") as never, ctx(put.file.id))).json();
    expect(meta.file.id).toBe(put.file.id);
    const token = meta.download.url.split("/").pop();

    // The link works without any identity.
    actor = null;
    const { GET: DL } = await import("../app/api/files/dl/[token]/route");
    const dl = await DL(new Request("http://x"), { params: Promise.resolve({ token }) });
    expect(dl.status).toBe(200);
    expect(sha(new Uint8Array(await dl.arrayBuffer()))).toBe(put.file.sha256);
    expect((await DL(new Request("http://x"), { params: Promise.resolve({ token: "nope" }) })).status).toBe(404);

    // Another person cannot see it until it is shared.
    as(OTHER, "Other Two");
    expect((await CONTENT(new Request("http://x") as never, ctx(put.file.id))).status).toBe(404);
    as(OWNER, "Owner One");
    const patched = await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ shareWith: [OTHER] }) }) as never, ctx(put.file.id));
    expect(patched.status).toBe(200);
    as(OTHER, "Other Two");
    expect((await CONTENT(new Request("http://x") as never, ctx(put.file.id))).status).toBe(200);
    // Only the owner deletes.
    expect((await DELETE(new Request("http://x", { method: "DELETE" }) as never, ctx(put.file.id))).status).toBe(403);
    as(OWNER, "Owner One");
    const del = await DELETE(new Request("http://x", { method: "DELETE" }) as never, ctx(put.file.id));
    expect(del.status).toBe(200);
    expect((await del.json()).usage.usedBytes).toBe(0);
    expect((await META(new Request("http://x") as never, ctx(put.file.id))).status).toBe(404);
  });

  it("answers 400 for a bad PATCH body and 413 for an oversized upload", async () => {
    as(OWNER, "Owner One");
    const put = await (await upload("a.txt", new Uint8Array([1, 2, 3]))).json();
    const { PATCH } = await import("../app/api/files/[id]/route");
    expect((await PATCH(new Request("http://x", { method: "PATCH", body: "nope" }) as never, ctx(put.file.id))).status).toBe(400);
    expect((await PATCH(new Request("http://x", { method: "PATCH", body: "{}" }) as never, ctx(put.file.id))).status).toBe(400);
    const { POST } = await import("../app/api/files/route");
    const big = new Request("http://x/api/files?name=big.txt", { method: "POST", body: new Uint8Array(10), headers: { "content-length": String(26 * 1024 * 1024) } });
    expect((await POST(big as never)).status).toBe(413);
  });
});

describe("download headers", () => {
  it("encodes the name for Content-Disposition without breaking the header", async () => {
    const { downloadHeaders } = await import("../lib/file-download");
    const h = downloadHeaders({ id: "a".repeat(32), owner_id: OWNER, name: "rapport (final)'é\"x;.txt", size: 1, sha256: "0", org_visible: 0, created_at: "", expires_at: "", deleted_at: null, removed_at: null });
    const cd = h.get("content-disposition")!;
    expect(cd).toContain(`filename="rapport (final)'__x_.txt"`);
    expect(cd).toContain("filename*=UTF-8''rapport%20%28final%29%27%C3%A9%22x%3B.txt");
  });
});

describe("proxy", () => {
  it("leaves POST /api/files out of the request proxy, so Next never buffers an upload, and keeps every other API path in", async () => {
    const { config } = await import("../proxy");
    expect(config.matcher).toEqual(["/api", "/api/((?!files$).*)", "/mcp"]);
    const re = new RegExp("^/api/((?!files$).*)$");
    expect(re.test("/api/files")).toBe(false);
    for (const p of ["/api/files/abc", "/api/files/abc/content", "/api/files/dl/x", "/api/learnings", "/api/filesx"]) expect(re.test(p), p).toBe(true);
  });

  it("runs the gate inside the upload route: a token is required in token mode", async () => {
    process.env.BAB_API_TOKENS = "t0ken-for-tests-only";
    (await import("../lib/db"))._resetDbForTests();
    vi.resetModules();
    as(OWNER, "Owner One");
    const { POST, GET } = await import("../app/api/files/route");
    const res = await POST(new Request("http://x/api/files?name=a.txt", { method: "POST", body: "abc", headers: { "content-length": "3" } }) as never);
    expect(res.status).toBe(401);
    expect((await GET(new Request("http://x/api/files"))).status).toBe(401);
    const ok = await POST(new Request("http://x/api/files?name=a.txt", { method: "POST", body: "abc", headers: { "content-length": "3", authorization: "Bearer t0ken-for-tests-only" } }) as never);
    expect(ok.status).toBe(201);
    delete process.env.BAB_API_TOKENS;
  });
});

describe("gate", () => {
  it("lets a file upload through up to the per-file cap and nothing else", async () => {
    const { gate } = await import("../lib/gate");
    const req = (p: string, len: number) => new Request(`http://x${p}`, { method: "POST", headers: { "content-length": String(len) } });
    expect(gate(req("/api/files", 20 * 1024 * 1024))).toBeNull();
    expect(gate(req("/api/files", 26 * 1024 * 1024))?.status).toBe(413);
    expect(gate(req("/api/learnings", 20 * 1024 * 1024))?.status).toBe(413);
    expect(gate(req("/api/files/abc", 20 * 1024 * 1024))?.status).toBe(413);
  });

  it("keeps download links public in token mode, and nothing else under /api/files", async () => {
    const { isPublicPath } = await import("../lib/public-paths");
    expect(isPublicPath("/api/files/dl/abc")).toBe(true);
    expect(isPublicPath("/api/files")).toBe(false);
    expect(isPublicPath("/api/files/abc/content")).toBe(false);
  });
});
