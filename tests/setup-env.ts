import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Example-organization deployment values for the test runs. The app's own defaults are neutral, so tests that
// exercise organization-specific behaviour get it from here. Shared with tests/e2e/global-setup.ts so the unit and
// e2e environments cannot drift.
//
// BAB_PUBLIC_ORIGIN is deliberately NOT here either: today's code reads it live and several tests
// assert the request-origin fallback when it is unset. Add it once the later tasks route through config().
// BAB_TRUST_PROXY_IDENTITY is deliberately NOT here: existing tests (device-session) rely on the
// proxy-trust flag being unset by default and set it themselves; e2e adds it in global-setup.
export const ACME_ENV: Record<string, string> = {
  BAB_IDENTITY_EMAIL_PATTERN: String.raw`^[a-z]+(?:[-'][a-z]+)*\.[a-z]+(?:[-'.][a-z]+)*@example\.com$`,
  BAB_IDENTITY_ALIAS_PATTERN: String.raw`^[a-z0-9._%+-]+@example\.com$`,
  BAB_IDENTITY_HINT: "first.last@example.com",
  BAB_REDACT_DOMAINS: "example.com,example.org",
  BAB_SOURCE_HOSTS: "wiki.example.com",
  BAB_PROJECT_KEY_PREFIXES: "acme.,acmecorp.",
  BAB_ORG_NAME: "Acme",
  BAB_PLUGIN_MARKETPLACE: "acme/claude-plugins",
  BAB_PLUGIN_MARKETPLACE_NAME: "acme-plugins",
  BAB_TRUST_PROXY: "1",
};

for (const [k, v] of Object.entries(ACME_ENV)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

// Many tests turn BAB_TRUST_PROXY_IDENTITY on without a proxy secret; config refuses that unless acknowledged.
// tests/config.test.ts clears every BAB_* variable first, so it still covers the refusal.
// Kept out of ACME_ENV: the e2e server sets it in global-setup, and config-fail.e2e must not inherit it.
if (process.env.BAB_TRUST_PROXY_WITHOUT_SECRET === undefined) process.env.BAB_TRUST_PROXY_WITHOUT_SECRET = "1";

// Isolated data dir by default. lib/db.ts defaults to /data (for containers), which is unwritable on Linux CI.
// Tests that need their own dir still set DATA_DIR themselves. One process per file (forks), so one dir per file.
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bab-test-"));
}
