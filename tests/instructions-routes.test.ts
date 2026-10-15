import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { GET as getIndex } from "../app/instructions/route";
import { GET as getVersion } from "../app/instructions/version/route";

const ORIGIN = "https://bab.example.com";

describe("GET /instructions (index)", () => {
  it("responds with markdown content-type and no-store, listing all documents", async () => {
    const req = new Request(`${ORIGIN}/instructions`, { headers: { host: "bab.example.com" } });
    const res = await getIndex(req as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("/instructions/install.md");
    expect(body).toContain("/instructions/skill.md");
    expect(body).toContain("/instructions/version");
    expect(body).toContain("/instructions/version");
  });
});

describe("GET /instructions/version stability", () => {
  it("returns the same version across two separate calls", async () => {
    const res1 = await getVersion();
    const body1 = await res1.json();
    const res2 = await getVersion();
    const body2 = await res2.json();
    expect(body1.version).toBe(body2.version);
    expect(res1.headers.get("Cache-Control")).toBe("no-store");
  });
});
