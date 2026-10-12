import { describe, it, expect, afterEach, vi } from "vitest";
import { publicOrigin } from "../lib/origin";
import { sameOrigin } from "../lib/feedback-web";
import { _resetConfigForTests } from "../lib/config";

const KEYS = ["BAB_PUBLIC_ORIGIN", "BAB_TRUST_PROXY"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  _resetConfigForTests();
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetConfigForTests();
  vi.restoreAllMocks();
});

describe("publicOrigin", () => {
  it("1. the configured origin wins over every header", () => {
    setEnv({ BAB_PUBLIC_ORIGIN: "https://bab.example", BAB_TRUST_PROXY: "1" });
    const h = new Headers({ host: "internal:3000", "x-forwarded-host": "other.example", "x-forwarded-proto": "https" });
    expect(publicOrigin(h)).toBe("https://bab.example");
  });

  it("keeps the origin only of a configured URL with a path", () => {
    setEnv({ BAB_PUBLIC_ORIGIN: "https://x.example/path" });
    expect(publicOrigin(new Headers({ host: "internal" }))).toBe("https://x.example");
  });

  it("2. with trust on, the forwarded host and proto are used", () => {
    setEnv({ BAB_TRUST_PROXY: "1" });
    const h = new Headers({ host: "internal:3000", "x-forwarded-host": "public.example", "x-forwarded-proto": "https" });
    expect(publicOrigin(h)).toBe("https://public.example");
  });

  it("2. with trust on, the forwarded proto defaults to https", () => {
    setEnv({ BAB_TRUST_PROXY: "1" });
    expect(publicOrigin(new Headers({ host: "internal", "x-forwarded-host": "public.example" }))).toBe("https://public.example");
  });

  it("2. with trust on but no forwarded host, falls through to the host header", () => {
    setEnv({ BAB_TRUST_PROXY: "1" });
    expect(publicOrigin(new Headers({ host: "internal.example" }))).toBe("http://internal.example");
  });

  it("3. with trust off, a forged X-Forwarded-Host is ignored", () => {
    setEnv({});
    const h = new Headers({ host: "bab.real.example", "x-forwarded-host": "evil.example" });
    expect(publicOrigin(h)).toBe("http://bab.real.example");
  });

  it("3. uses the forwarded proto, else http, with the host header", () => {
    setEnv({});
    expect(publicOrigin(new Headers({ host: "localhost:4310" }))).toBe("http://localhost:4310");
    expect(publicOrigin(new Headers({ host: "bab.example", "x-forwarded-proto": "https" }))).toBe("https://bab.example");
  });

  it("ignores a forwarded proto that is not http or https", () => {
    setEnv({});
    expect(publicOrigin(new Headers({ host: "bab.example", "x-forwarded-proto": "javascript" }))).toBe("http://bab.example");
  });

  it("takes the first value of a comma-separated forwarded pair", () => {
    setEnv({ BAB_TRUST_PROXY: "1" });
    const h = new Headers({ "x-forwarded-host": "a.example, b.example", "x-forwarded-proto": "https, http" });
    expect(publicOrigin(h)).toBe("https://a.example");
  });

  it("with no host at all, throws", () => {
    setEnv({});
    expect(() => publicOrigin(new Headers())).toThrow("publicOrigin: no Host header");
  });

  it("accepts an upper-case forwarded proto", () => {
    setEnv({});
    expect(publicOrigin(new Headers({ host: "bab.example", "x-forwarded-proto": "HTTPS" }))).toBe("https://bab.example");
  });

  it("sameOrigin with trust and public origin unset ignores a forged X-Forwarded-Host", () => {
    setEnv({});
    const req = (origin: string) =>
      new Request("http://app.example/x", { headers: { host: "app.example", "x-forwarded-host": "evil.example", origin } });
    expect(sameOrigin(req("http://app.example"))).toBe(true);
    expect(sameOrigin(req("http://evil.example"))).toBe(false);
  });
});
