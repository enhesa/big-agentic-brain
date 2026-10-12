import { describe, it, expect } from "vitest";
import { origin } from "./helpers";

describe("e2e: instructions routes", () => {
  it("install.md: 200, text/markdown, mentions the served origin", async () => {
    const res = await fetch(`${origin()}/instructions/install.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    const text = await res.text();
    expect(text).toContain(origin());
  });

  it("skill.md: 200, text/markdown", async () => {
    const res = await fetch(`${origin()}/instructions/skill.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
  });

  it("version: 200 JSON", async () => {
    const res = await fetch(`${origin()}/instructions/version`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/json/);
    const body = await res.json();
    expect(body.version).toBeTruthy();
    expect(body.updatedAt).toBeTruthy();
  });
});
