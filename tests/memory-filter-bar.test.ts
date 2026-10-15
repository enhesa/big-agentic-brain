import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The /memory page and its filter bar, server rendered (no DOM here: the interaction rules are
 *  in memory-filter-controller.test.ts). */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-memory-filter-bar-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

async function renderList(searchParams: Record<string, string>): Promise<string> {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
  const { default: MemoryPage } = await import("../app/memory/page");
  const { renderToReadableStream } = await import("react-dom/server.edge");
  return new Response(await renderToReadableStream(MemoryPage({ searchParams: Promise.resolve(searchParams) }) as never)).text();
}

describe("/memory filter bar", () => {
  it("renders with no params: one GET form, every field labelled, no Search or Apply button", async () => {
    const html = await renderList({});
    expect(html).toContain("Memory");
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toMatch(/<form[^>]*role="search"[^>]*action="\/memory"[^>]*method="get"/);
    for (const id of ["project", "status", "kind", "applies"]) {
      expect(html).toContain(`<label for="memory-filter-${id}"`);
      expect(html).toContain(`id="memory-filter-${id}"`);
    }
    expect(html).toContain('aria-label="Search memories"');
    // The only button is the visually hidden one that Enter presses without JavaScript.
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatch(/class="[^"]*srOnly/);
    expect(html).not.toMatch(/>Search<\/button>|>Apply<\/button>/);
  });

  it("announces the result count politely", async () => {
    const html = await renderList({});
    expect(html).toMatch(/<p[^>]*aria-live="polite"[^>]*>0 memories<\/p>/);
  });

  it("shows the current filters in the form, and keeps tag and repo as hidden inputs", async () => {
    const html = await renderList({ q: "flags", tag: "dev", repo: "bab", status: "archived" });
    expect(html).toMatch(/<input[^>]*name="q"[^>]*value="flags"/);
    expect(html).toMatch(/<option value="archived" selected/);
    expect(html).toMatch(/<input type="hidden" name="tag" value="dev"/);
    expect(html).toMatch(/<input type="hidden" name="repo" value="bab"/);
  });
});
