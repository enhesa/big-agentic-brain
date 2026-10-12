import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CHANGELOG } from "../lib/changelog";

/**
 * The changelog is dated, not versioned (owner, 2026-09-24): one entry per day, newest
 * first.
 */

describe("CHANGELOG", () => {
  it("lists ISO dates, newest first, one entry per day", () => {
    for (const entry of CHANGELOG) expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(CHANGELOG[i - 1].date > CHANGELOG[i].date).toBe(true);
    }
  });

  it("gives every entry a title and short, plain lines", () => {
    for (const entry of CHANGELOG) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.changes.length).toBeGreaterThan(0);
      for (const line of [entry.title, ...entry.changes]) {
        expect(line).not.toContain("—");
        expect(line.split(/\s+/).length).toBeLessThanOrEqual(20);
      }
    }
  });
});

describe("/changelog", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "bab-changelog-test-"));
    process.env.DATA_DIR = dataDir;
    vi.resetModules();
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
  });

  afterEach(async () => {
    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    vi.doUnmock("next/headers");
    vi.resetModules();
  });

  it("renders every entry without an identity, with a date anchor each", async () => {
    const { default: ChangelogPage } = await import("../app/changelog/page");
    const html = renderToStaticMarkup(await ChangelogPage());
    expect(html).toContain("News");
    for (const entry of CHANGELOG) {
      expect(html).toContain(`id="${entry.date}"`);
      expect(html).toContain(entry.title);
    }
    expect(html).not.toMatch(/behind the scenes/i);
    expect(html).not.toContain('type="checkbox"');
  });

  it("marks the entry dated today with a Today pill, and no other", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(`${CHANGELOG[0].date}T12:00:00Z`));
      const { default: ChangelogPage } = await import("../app/changelog/page");
      const html = renderToStaticMarkup(await ChangelogPage());
      expect(html.match(/>Today</g)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
