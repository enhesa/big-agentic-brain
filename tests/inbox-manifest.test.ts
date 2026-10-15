import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { _resetConfigForTests } from "@/lib/config";

describe("GET /inbox/manifest", () => {
  afterEach(() => {
    delete process.env.BAB_INBOX_PAGE;
    _resetConfigForTests();
  });

  it("is an installable web app manifest that starts at /inbox", async () => {
    const { GET } = await import("../app/inbox/manifest/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    const m = await res.json();
    expect(m).toMatchObject({
      id: "/inbox",
      name: "Big Agentic Brain Inbox",
      short_name: "BAB Inbox",
      start_url: "/inbox",
      scope: "/",
      display: "standalone",
    });
    expect(m.icons.map((i: { src: string }) => i.src)).toEqual([
      "/icons/bab-inbox-192.png",
      "/icons/bab-inbox-512.png",
      "/branding/icon.svg",
      "/branding/apple-icon.png",
    ]);
    expect(m.icons[0]).toMatchObject({ sizes: "192x192", type: "image/png" });
    expect(m.icons[1]).toMatchObject({ sizes: "512x512", type: "image/png" });
    expect(m.icons[2]).toMatchObject({ sizes: "any", type: "image/svg+xml" });
  });

  it("lists PNG files that exist and really are 192 and 512 pixels square", async () => {
    // A manifest that points at a missing or mis-sized icon fails Chrome's install check silently.
    const { GET } = await import("../app/inbox/manifest/route");
    const m = await (await GET()).json();
    for (const [size, src] of [
      [192, "/icons/bab-inbox-192.png"],
      [512, "/icons/bab-inbox-512.png"],
    ] as const) {
      expect(m.icons.some((i: { src: string }) => i.src === src)).toBe(true);
      const bytes = readFileSync(path.join(process.cwd(), "public", src));
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      // IHDR: width and height are the two big-endian ints at bytes 16 and 20.
      expect(bytes.readUInt32BE(16)).toBe(size);
      expect(bytes.readUInt32BE(20)).toBe(size);
    }
  });

  it("is 503 while switched off", async () => {
    process.env.BAB_INBOX_PAGE = "0";
    _resetConfigForTests();
    const { GET } = await import("../app/inbox/manifest/route");
    const res = await GET();
    expect(res.status).toBe(503);
    // A switched-off answer must not be cached, or the install would outlive the switch.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
