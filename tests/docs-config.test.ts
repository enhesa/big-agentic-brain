import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// plain ESM script, typed by allowJs
import { checkDocs, generate } from "../scripts/docs-config.mjs";
import { CONFIG_SPEC, _resetConfigForTests, config } from "@/lib/config";

const script = path.resolve(__dirname, "..", "scripts", "docs-config.mjs");
const committed = path.resolve(__dirname, "..", "docs", "configuration.md");
const tmp = mkdtempSync(path.join(os.tmpdir(), "bab-docs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("docs/configuration.md", () => {
  it("committed file equals the generated one, LF only", () => {
    const text = readFileSync(committed, "utf8");
    expect(text).toBe(generate());
    expect(text).not.toContain("\r");
  });

  it("generating to a temp path reproduces the committed file", () => {
    const out = path.join(tmp, "gen.md");
    execFileSync(process.execPath, [script, "--file", out]);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(committed, "utf8"));
  });

  it("table is sorted by env name and no longer lists the removed alias", () => {
    const names = [...generate().matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
    expect(names).toEqual([...names].sort());
    expect(names.length).toBe(CONFIG_SPEC.length);
    expect(generate()).not.toContain("BAB_TRUST_FORGE_HEADERS");
  });

  it("--check passes on the committed file and fails when it is modified", () => {
    const ok = path.join(tmp, "ok.md");
    writeFileSync(ok, readFileSync(committed));
    expect(spawnSync(process.execPath, [script, "--check", "--file", ok]).status).toBe(0);
    const stale = path.join(tmp, "stale.md");
    writeFileSync(stale, readFileSync(committed, "utf8") + "hand edit\n");
    const r = spawnSync(process.execPath, [script, "--check", "--file", stale], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pnpm docs:config");
    expect(checkDocs("x")).toBe(false);
  });
});

describe("CONFIG_SPEC", () => {
  it("matches the BAB_ names lib/config.ts references, both ways", () => {
    const src = readFileSync(path.resolve(__dirname, "..", "lib", "config.ts"), "utf8");
    const literals = new Set([...src.matchAll(/BAB_[A-Z][A-Z_]*/g)].map((m) => m[0]));
    const spec = new Set<string>();
    for (const e of CONFIG_SPEC) {
      if (e.env.startsWith("BAB_")) spec.add(e.env);
    }
    expect([...literals].sort()).toEqual([...spec].sort());
  });

  it("has unique names and a description each", () => {
    expect(new Set(CONFIG_SPEC.map((e) => e.env)).size).toBe(CONFIG_SPEC.length);
    for (const e of CONFIG_SPEC) expect(e.description.length).toBeGreaterThan(5);
  });
});

describe("CONFIG_SPEC defaults", () => {
  it("equal what the parser resolves from an empty environment", () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("BAB_")) delete process.env[k];
    _resetConfigForTests();
    const c = config();
    const def = (env: string) => CONFIG_SPEC.find((e) => e.env === env)!.default;
    expect(def("BAB_HEADER_USER_ID")).toBe(c.proxy.headerUserId);
    expect(def("BAB_MAX_BODY_BYTES")).toBe(String(c.network.maxBodyBytes));
    expect(def("BAB_STALE_AFTER_DAYS")).toBe(String(c.retention.staleAfterDays));
    expect(def("BAB_AUDIT_RETENTION_DAYS")).toBe(String(c.retention.auditDays));
    expect(def("BAB_LOCALE")).toBe(c.branding.locale);
    expect(def("BAB_TIMEZONE")).toBe(c.branding.timeZone);
    expect(def("BAB_ACCENT_COLOR")).toBe(c.branding.accentColor);
    expect(def("BAB_ORG_NAME")).toBe(c.branding.orgName);
    expect(def("BAB_PLUGIN_MARKETPLACE")).toBe(c.branding.pluginMarketplace);
    expect(def("BAB_PLUGIN_MARKETPLACE_NAME")).toBe(c.branding.pluginMarketplaceName);
    expect(def("BAB_IDENTITY_EMAIL_PATTERN")).toBe(c.identity.emailPattern.source);
    _resetConfigForTests();
  });
});
