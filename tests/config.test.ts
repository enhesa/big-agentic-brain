import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, _resetConfigForTests, config, logEffectiveConfig } from "@/lib/config";

const saved = { ...process.env };

function clearBab() {
  for (const k of Object.keys(process.env)) if (k.startsWith("BAB_")) delete process.env[k];
}

beforeEach(() => {
  clearBab();
  _resetConfigForTests();
});

afterEach(() => {
  clearBab();
  for (const [k, v] of Object.entries(saved)) if (k.startsWith("BAB_") && v !== undefined) process.env[k] = v;
  _resetConfigForTests();
  vi.restoreAllMocks();
});

function logged(): string[] {
  const lines: string[] = [];
  logEffectiveConfig((l) => lines.push(l));
  return lines;
}

describe("config", () => {
  it("defaults are neutral", () => {
    const c = config();
    expect(c.identity.emailPattern.test("someone@example.org")).toBe(true);
    expect(c.identity.aliasPattern).toBeNull();
    expect(c.identity.hint).toBe("you@example.com");
    expect(c.identity.allowedEmails).toBeNull();
    expect(c.identity.maintainers.size).toBe(0);
    expect(c.proxy).toEqual({
      trustIdentity: false,
      headerUserId: "x-auth-request-user",
      headerEmail: "x-auth-request-email",
      headerName: "x-auth-request-preferred-username",
      headerRoles: "x-auth-request-groups",
      secret: null,
      trustForwarded: false,
    });
    expect(c.network).toEqual({ publicOrigin: null, maxBodyBytes: 1048576 });
    expect(c.tokens).toBeNull();
    expect(c.tokenIdentities.size).toBe(0);
    expect(c.redact).toEqual({ pii: true, domains: [] });
    expect(c.sourceHosts).toBeNull();
    expect(c.projectKeyPrefixes).toEqual([]);
    expect(c.branding).toEqual({
      orgName: "BAB",
      accentColor: "#1a3360",
      pluginMarketplace: "enhesa/big-agentic-brain",
      pluginMarketplaceName: "big-agentic-brain",
      locale: "en",
      timeZone: "UTC",
    });
    expect(c.retention).toEqual({ staleAfterDays: 90, auditDays: 365 });
    expect(c.devices).toBe(true);
    expect(c.inboxPage).toBe(true);
    expect(c.clientIpHeader).toBeNull();
  });

  it("invalid regex throws ConfigError naming BAB_IDENTITY_EMAIL_PATTERN", () => {
    process.env.BAB_IDENTITY_EMAIL_PATTERN = "([";
    expect(() => config()).toThrow(ConfigError);
    expect(() => config()).toThrow(/BAB_IDENTITY_EMAIL_PATTERN/);
  });

  it("invalid accent colour throws", () => {
    process.env.BAB_ACCENT_COLOR = "red";
    expect(() => config()).toThrow(/BAB_ACCENT_COLOR/);
  });

  it("accent colour is lowercased before validation", () => {
    process.env.BAB_ACCENT_COLOR = "#1A3360";
    expect(config().branding.accentColor).toBe("#1a3360");
  });

  it("an unrecognised BAB_CLIENT_IP_HEADER does not throw and reads as unset", () => {
    process.env.BAB_CLIENT_IP_HEADER = "Bogus";
    expect(config().clientIpHeader).toBeNull();
    expect(config().clientIpHeaderInvalid).toBe("bogus");
  });

  it("BAB_CLIENT_IP_HEADER is lowercased", () => {
    process.env.BAB_CLIENT_IP_HEADER = "X-Forwarded-For-Rightmost";
    expect(config().clientIpHeader).toBe("x-forwarded-for-rightmost");
  });

  it("invalid timezone throws", () => {
    process.env.BAB_TIMEZONE = "Mars/Base";
    expect(() => config()).toThrow(ConfigError);
    expect(() => config()).toThrow(/BAB_TIMEZONE/);
  });

  it("invalid locale throws", () => {
    process.env.BAB_LOCALE = "not_a_locale!";
    expect(() => config()).toThrow(ConfigError);
    expect(() => config()).toThrow(/BAB_LOCALE/);
  });

  it("BAB_PUBLIC_ORIGIN keeps origin only", () => {
    process.env.BAB_PUBLIC_ORIGIN = "https://x.example/path";
    expect(config().network.publicOrigin).toBe("https://x.example");
  });

  it("BAB_PUBLIC_ORIGIN without a scheme throws instead of becoming the origin \"null\"", () => {
    process.env.BAB_PUBLIC_ORIGIN = "localhost:3000";
    expect(() => config()).toThrow(ConfigError);
    expect(() => config()).toThrow(/BAB_PUBLIC_ORIGIN/);
  });

  it("BAB_EXTRA_APPLIES_TO is empty by default and is lowercased, trimmed and de-duplicated", () => {
    expect(config().extraAppliesTo).toEqual([]);
    process.env.BAB_EXTRA_APPLIES_TO = " Forge, my-platform ,forge";
    _resetConfigForTests();
    expect(config().extraAppliesTo).toEqual(["forge", "my-platform"]);
  });

  it("BAB_EXTRA_APPLIES_TO refuses a label that is not lowercase letters and hyphens, or is reserved", () => {
    for (const bad of ["bad label", "x'y", "UPPER_CASE", "a--b", "-a", "everywhere"]) {
      process.env.BAB_EXTRA_APPLIES_TO = bad;
      _resetConfigForTests();
      expect(() => config(), bad).toThrow(/BAB_EXTRA_APPLIES_TO/);
    }
  });

  it("the removed BAB_TRUST_FORGE_HEADERS alias no longer enables proxy identity", () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    expect(config().proxy.trustIdentity).toBe(false);
  });

  it("refuses to start when proxy identity is trusted without BAB_PROXY_SECRET", () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    expect(() => config()).toThrow(ConfigError);
    expect(() => config()).toThrow(
      "BAB_TRUST_PROXY_IDENTITY needs BAB_PROXY_SECRET, or BAB_TRUST_PROXY_WITHOUT_SECRET=1 when the proxy is the only way to reach BAB",
    );
  });

  it("only warns when BAB_TRUST_PROXY_WITHOUT_SECRET=1 acknowledges it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    process.env.BAB_TRUST_PROXY_WITHOUT_SECRET = "1";
    expect(config().proxy.trustIdentity).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("without a shared secret"))).toBe(true);
  });

  it("neither throws nor warns about the secret when BAB_PROXY_SECRET is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    process.env.BAB_PROXY_SECRET = "s";
    expect(config().proxy.trustIdentity).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("without a shared secret"))).toBe(false);
  });

  it("BAB_TRUST_PROXY_WITHOUT_SECRET alone changes nothing when the proxy is not trusted", () => {
    process.env.BAB_TRUST_PROXY_WITHOUT_SECRET = "1";
    expect(config().proxy.trustIdentity).toBe(false);
  });

  it("BAB_API_TOKENS rejects a token=email whose email fails the identity pattern", () => {
    process.env.BAB_IDENTITY_EMAIL_PATTERN = "^[a-z]+[.][a-z]+@example[.]com$";
    process.env.BAB_API_TOKENS = "def=nobody@example.com";
    expect(() => config()).toThrow(/BAB_API_TOKENS/);
    process.env.BAB_API_TOKENS = "def=jane.doe@example.com";
    _resetConfigForTests();
    expect(config().tokenIdentities.get("def")).toBe("jane.doe@example.com");
  });

  it("BAB_API_TOKENS parses bare and token=email entries", () => {
    process.env.BAB_API_TOKENS = "abc, def=Jane.Doe@Example.com ,ghi";
    const c = config();
    expect([...c.tokens!]).toEqual(["abc", "ghi"]);
    expect(c.tokenIdentities.get("def")).toBe("jane.doe@example.com");
  });

  it("BAB_API_TOKENS holding only whitespace throws instead of turning token mode off", () => {
    process.env.BAB_API_TOKENS = "   ";
    expect(() => config()).toThrow(ConfigError);
    expect(() => config()).toThrow(/BAB_API_TOKENS is set but holds no token/);
  });

  it("BAB_API_TOKENS holding only separators throws", () => {
    process.env.BAB_API_TOKENS = ",, ";
    expect(() => config()).toThrow(ConfigError);
    expect(() => config()).toThrow(/BAB_API_TOKENS is set but holds no token/);
  });

  describe("BAB_API_TOKENS_FILE", () => {
    function withFile(content: string, run: () => void) {
      const dir = mkdtempSync(path.join(tmpdir(), "bab-cfg-"));
      try {
        const file = path.join(dir, "tokens");
        writeFileSync(file, content);
        process.env.BAB_API_TOKENS_FILE = file;
        run();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("an empty file throws", () => {
      withFile("", () => {
        expect(() => config()).toThrow(ConfigError);
        expect(() => config()).toThrow(/BAB_API_TOKENS_FILE is set but holds no token/);
      });
    });

    it("a file with only a comment throws", () => {
      withFile("# comment\n", () => {
        expect(() => config()).toThrow(ConfigError);
        expect(() => config()).toThrow(/BAB_API_TOKENS_FILE is set but holds no token/);
      });
    });

    it("comment lines are skipped and the token after them is kept", () => {
      withFile("# comment\nabc\n", () => {
        expect([...config().tokens!]).toEqual(["abc"]);
      });
    });

    it("an empty file throws even when BAB_API_TOKENS holds tokens", () => {
      process.env.BAB_API_TOKENS = "inline";
      withFile("", () => {
        expect(() => config()).toThrow(/BAB_API_TOKENS_FILE is set but holds no token/);
      });
    });

    it("inline and file tokens are merged", () => {
      process.env.BAB_API_TOKENS = "inline";
      withFile("# c\nfromfile\n", () => {
        expect([...config().tokens!]).toEqual(["inline", "fromfile"]);
      });
    });
  });

  it("BAB_API_TOKENS_FILE read when set", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bab-cfg-"));
    try {
      const file = path.join(dir, "tokens");
      writeFileSync(file, "aaa\nbbb=x@example.com\n\n");
      process.env.BAB_API_TOKENS_FILE = file;
      const c = config();
      expect([...c.tokens!]).toEqual(["aaa"]);
      expect(c.tokenIdentities.get("bbb")).toBe("x@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maintainers stays live", () => {
    const c = config();
    expect(c.identity.maintainers.size).toBe(0);
    process.env.BAB_MAINTAINERS = "A@example.com, b@example.com";
    expect([...c.identity.maintainers]).toEqual(["a@example.com", "b@example.com"]);
  });

  it("logEffectiveConfig masks tokens and secret", () => {
    process.env.BAB_PROXY_SECRET = "supersecretvalue";
    process.env.BAB_API_TOKENS = "tok-123456789,tok-abc=a@example.com";
    const text = logged().join("\n");
    expect(text).not.toContain("supersecretvalue");
    expect(text).not.toContain("tok-123456789");
    expect(text).not.toContain("tok-abc");
    expect(text).toContain("secret=set(16 chars, masked)");
    expect(text).toContain("bare=1 (masked)");
    expect(text).toContain("withIdentity=1 (masked)");
    expect(text).not.toContain("open mode");
  });

  it("logEffectiveConfig prints WARN when open", () => {
    const text = logged().join("\n");
    expect(text).toContain("WARN");
    expect(text).toContain("secret=unset");
  });

  it("a bare token with = padding stays a bare token", () => {
    process.env.BAB_API_TOKENS = "abc==,def==alice.example@example.com";
    const c = config();
    expect([...c.tokens!]).toEqual(["abc=="]);
    expect(c.tokenIdentities.get("def=")).toBe("alice.example@example.com");
    expect(c.tokenIdentities.size).toBe(1);
  });

  it("logEffectiveConfig prints no WARN with proxy identity on and tokens set", () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    process.env.BAB_PROXY_SECRET = "s";
    process.env.BAB_API_TOKENS = "tok=alice.example@example.com";
    expect(logged().join("\n")).not.toContain("WARN");
  });

  const SELF_DECLARED_NO_TOKENS =
    "[config] WARN: /api and /mcp accept self-declared identities; bind tokens to people with token=email entries in BAB_API_TOKENS, or keep those paths off the public network";
  const SELF_DECLARED_BARE =
    "[config] WARN: API tokens gate access but do not bind identity: /api and /mcp accept self-declared identities; use token=email entries in BAB_API_TOKENS";

  it("logEffectiveConfig warns that /api and /mcp accept self-declared identities with proxy identity on and no tokens", () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    process.env.BAB_PROXY_SECRET = "s";
    expect(logged()).toContain(SELF_DECLARED_NO_TOKENS);
  });

  it("logEffectiveConfig warns when only bare tokens are set, with or without proxy identity", () => {
    process.env.BAB_API_TOKENS = "bare";
    expect(logged()).toContain(SELF_DECLARED_BARE);
    expect(logged().join("\n")).not.toContain("open mode");
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    process.env.BAB_PROXY_SECRET = "s";
    _resetConfigForTests();
    expect(logged()).toContain(SELF_DECLARED_BARE);
    expect(logged()).not.toContain(SELF_DECLARED_NO_TOKENS);
  });

  it("logEffectiveConfig warns when a bare token sits next to bound ones, since its holder can still declare an unbound address", () => {
    process.env.BAB_API_TOKENS = "bare,tok=alice.example@example.com";
    expect(logged()).toContain(SELF_DECLARED_BARE);
  });

  it("logEffectiveConfig does not warn when every token is bound to a person, or when the app is open", () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    process.env.BAB_PROXY_SECRET = "s";
    process.env.BAB_API_TOKENS = "tok=alice.example@example.com";
    expect(logged()).not.toContain(SELF_DECLARED_NO_TOKENS);
    expect(logged()).not.toContain(SELF_DECLARED_BARE);
    delete process.env.BAB_TRUST_PROXY_IDENTITY;
    delete process.env.BAB_API_TOKENS;
    _resetConfigForTests();
    expect(logged()).not.toContain(SELF_DECLARED_NO_TOKENS);
    expect(logged()).not.toContain(SELF_DECLARED_BARE);
  });
});
