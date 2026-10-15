import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { redact, containsSensitive } from "../lib/redact";

// Fixtures are assembled at runtime so no credential-shaped literal sits in the repo.
const j = (...parts: string[]) => parts.join("");

describe("redact: secrets", () => {
  it("masks a JWT", () => {
    const jwt = j("ey", "J", "h".repeat(16), ".", "ey", "J", "z".repeat(20), ".", "s".repeat(40));
    expect(redact(`token was ${jwt} ok`)).toBe("token was [redacted] ok");
  });

  it("masks a PEM private key block but keeps surrounding text", () => {
    const pk = j("PRI", "VATE ", "KEY");
    const pem = j("-----BEGIN RSA ", pk, "-----\nMIIEow\nABC\n-----END RSA ", pk, "-----");
    expect(redact(`before\n${pem}\nafter`)).toBe("before\n[redacted]\nafter");
  });

  it("masks credentials embedded in a URL but keeps scheme and host", () => {
    expect(redact(j("postg", "res://", "app:", "pw".repeat(4), "@db.internal:5432/x"))).toBe("postgres://[redacted]@db.internal:5432/x");
    expect(redact("https://db.internal/path")).toBe("https://db.internal/path");
  });

  it("masks Azure storage keys and SAS signatures", () => {
    const key = "A".repeat(44) + "==";
    expect(redact(j("DefaultEndpointsProtocol=https;AccountName=x;Account", "Key=", key, ";"))).toBe(
      "DefaultEndpointsProtocol=https;AccountName=x;[redacted];",
    );
    expect(redact(j("?sv=2022&si", "g=", "B".repeat(40), "%3D"))).toBe("?sv=2022&[redacted]");
  });

  it("masks vendor-prefixed keys", () => {
    for (const k of [
      j("sk-", "ant-", "a".repeat(30)),
      j("sk-", "b".repeat(30)),
      j("sk_", "live_", "c".repeat(20)),
      j("AI", "za", "D".repeat(35)),
      j("gl", "pat-", "e".repeat(24)),
      j("github_", "pat_", "f".repeat(30)),
      j("hv", "s.", "g".repeat(30)),
    ]) {
      expect(redact(`x ${k} y`), k).toBe("x [redacted] y");
    }
  });

  it("masks header-style and env-style credentials", () => {
    expect(redact(j("X-Api-", "Key: ", "abc123def"))).toBe("[redacted]");
    expect(redact(j("client_", "secret=", "zzz"))).toBe("[redacted]");
    expect(redact(j("AWS_SECRET_", "ACCESS_KEY=", "w".repeat(13)))).toBe("[redacted]");
  });
});

describe("redact: personal data", () => {
  it("masks third-party emails but keeps colleagues", () => {
    expect(redact("mail jane.doe@customer-corp.com or alice.example@example.com")).toBe(
      "mail [redacted email] or alice.example@example.com",
    );
  });

  it("masks phone numbers in international and national formats", () => {
    expect(redact("call +32 470 12 34 56 today")).toBe("call [redacted phone] today");
    expect(redact("call 0470/12.34.56 today")).toBe("call [redacted phone] today");
    expect(redact("call (0)20 7946 0958")).toBe("call [redacted phone]");
    expect(redact("call +1-202-555-0143")).toBe("call [redacted phone]");
  });

  it("masks Luhn-valid card numbers only", () => {
    const visa = j("4111 ", "1111 ", "1111 ", "1111");
    const visaBad = visa.slice(0, -1) + "2"; // last digit changed: fails Luhn
    expect(redact(`card ${visa} exp 12/27`)).toBe("card [redacted card] exp 12/27");
    expect(redact(`card ${visa.replace(/ /g, "")}`)).toBe("card [redacted card]");
    expect(redact(`card ${visaBad}`)).toBe(`card ${visaBad}`);
  });

  it("masks valid IBANs only", () => {
    expect(redact(j("pay BE68 ", "5390 ", "0754 ", "7034 please"))).toBe("pay [redacted iban] please");
    expect(redact(j("pay BE68", "5390", "0754", "7034 please"))).toBe("pay [redacted iban] please");
    expect(redact(j("pay BE68 ", "5390 ", "0754 ", "7035 please"))).toBe(j("pay BE68 ", "5390 ", "0754 ", "7035 please"));
  });

  it("masks national identifiers", () => {
    expect(redact(j("ssn 123-", "45-", "6789"))).toBe("ssn [redacted id]");
    expect(redact(j("rijksregister 85.07.30", "-033.28"))).toBe("rijksregister [redacted id]");
    expect(redact("NI QQ 12 34 56 C")).toBe("NI [redacted id]");
  });

  it("containsSensitive reflects whether anything would change", () => {
    expect(containsSensitive("nothing here")).toBe(false);
    expect(containsSensitive("mail a@b.io")).toBe(true);
  });
});

describe("redact: things that must survive", () => {
  const keep = [
    "commit 9677beefc0ffee1234567890abcdef1234567890 fixed it",
    "released on 2026-09-17 and 17/09/2026 at 13:45",
    "ticket PROJ-109 and BILLING-1234",
    "version 10.0.26200 of Windows, .NET 8 -> 10",
    "epoch 1726574400000 and 1726574400",
    "p95 latency 25.02ms, budget 40ms, 5000 learnings, 500 users",
    "port 5432, PR #17, release 12, 45k pairs",
    "Jira key: EHS-123, the key idea is caching",
    "tests pass: 404 passed, 0 failed",
    "IP 10.0.0.12 and CIDR 10.0.0.0/16",
    "invoice INV-2026-000123 total 1 234,56 EUR",
    "GUID 3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  ];
  for (const text of keep) {
    it(`keeps: ${text}`, () => {
      expect(redact(text)).toBe(text);
    });
  }
});

describe("redaction on write paths", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "bab-redact-pii-test-"));
    process.env.DATA_DIR = dataDir;
  });
  afterEach(async () => {
    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();
    delete process.env.DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("display names are redacted on first sight and on rename", async () => {
    const { upsertUser, renameUser, getUser } = await import("../lib/users");
    upsertUser({ id: "eve.adams@example.com", email: "eve.adams@example.com", name: "Eve Adams", roles: [] });
    renameUser("eve.adams@example.com", j("Eve token=", "abcdef"));
    expect(getUser("eve.adams@example.com")?.name).toBe("Eve [redacted]");
  });

  it("the maintenance sweep re-redacts rows stored before a pattern existed", async () => {
    const { getDb } = await import("../lib/db");
    const { upsertUser } = await import("../lib/users");
    const { redactStoredRows } = await import("../lib/maintenance");
    upsertUser({ id: "eve.adams@example.com", email: "eve.adams@example.com", name: "Eve Adams", roles: [] });
    const db = getDb();
    // Bypass the write path, as if written under an older pattern set.
    db.prepare(
      `INSERT INTO learnings (id, author_id, title, body, tags, repo, confidence, status)
       VALUES ('l1', 'eve.adams@example.com', 'Customer contact', 'call jane@customer-corp.com', '[]', NULL, 'medium', 'active')`,
    ).run();
    db.prepare(`INSERT INTO threads (id, subject, created_by) VALUES ('t1', 'Card ' || '4111 ' || '1111 ' || '1111 ' || '1111', 'eve.adams@example.com')`).run();

    expect(redactStoredRows(db)).toBe(2);
    const l = db.prepare("SELECT body FROM learnings WHERE id = 'l1'").get() as { body: string };
    const t = db.prepare("SELECT subject FROM threads WHERE id = 't1'").get() as { subject: string };
    expect(l.body).toBe("call [redacted email]");
    expect(t.subject).toBe("Card [redacted card]");
    expect(redactStoredRows(db)).toBe(0); // idempotent
  });
});

describe("redactStoredRows email masking depends on the domain list", () => {
  const saved = process.env.BAB_REDACT_DOMAINS;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bab-redact-sweep-test-"));
    process.env.DATA_DIR = dir;
  });
  afterEach(async () => {
    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();
    delete process.env.DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.BAB_REDACT_DOMAINS;
    else process.env.BAB_REDACT_DOMAINS = saved;
    (await import("../lib/config"))._resetConfigForTests();
  });

  async function seed() {
    const { getDb } = await import("../lib/db");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "eve.adams@example.com", email: "eve.adams@example.com", name: "Eve Adams", roles: [] });
    const db = getDb();
    db.prepare(
      `INSERT INTO learnings (id, author_id, title, body, tags, repo, confidence, status)
       VALUES ('l9', 'eve.adams@example.com', 'Contact', 'ask someone@example.com or other@gmail.com', '[]', NULL, 'medium', 'active')`,
    ).run();
    return db;
  }

  it("keeps stored emails when BAB_REDACT_DOMAINS is unset", async () => {
    delete process.env.BAB_REDACT_DOMAINS;
    (await import("../lib/config"))._resetConfigForTests();
    const { redactStoredRows } = await import("../lib/maintenance");
    const db = await seed();
    expect(redactStoredRows(db)).toBe(0);
    const l = db.prepare("SELECT body FROM learnings WHERE id = 'l9'").get() as { body: string };
    expect(l.body).toBe("ask someone@example.com or other@gmail.com");
  });

  it("still masks an external address with the domain list set", async () => {
    process.env.BAB_REDACT_DOMAINS = "example.com";
    (await import("../lib/config"))._resetConfigForTests();
    const { redactStoredRows } = await import("../lib/maintenance");
    const db = await seed();
    expect(redactStoredRows(db)).toBe(1);
    const l = db.prepare("SELECT body FROM learnings WHERE id = 'l9'").get() as { body: string };
    expect(l.body).toBe("ask someone@example.com or [redacted email]");
  });
});

describe("redact: configured domains and PII switch", () => {
  const saved = { d: process.env.BAB_REDACT_DOMAINS, p: process.env.BAB_REDACT_PII };
  afterEach(async () => {
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore("BAB_REDACT_DOMAINS", saved.d);
    restore("BAB_REDACT_PII", saved.p);
    (await import("../lib/config"))._resetConfigForTests();
  });

  it("redact keeps configured domains only", async () => {
    process.env.BAB_REDACT_DOMAINS = "example.com";
    (await import("../lib/config"))._resetConfigForTests();
    expect(redact("a@other.test b@example.com c@sub.example.com")).toBe("[redacted email] b@example.com c@sub.example.com");
  });

  it("BAB_REDACT_PII=0 keeps emails but still masks secrets", async () => {
    process.env.BAB_REDACT_PII = "0";
    (await import("../lib/config"))._resetConfigForTests();
    const jwt = j("ey", "J", "h".repeat(16), ".", "ey", "J", "z".repeat(20), ".", "s".repeat(40));
    expect(redact(`x@customer-corp.com ${jwt}`)).toBe("x@customer-corp.com [redacted]");
  });
});
