import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-memory-project-ui-test-"));
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

async function renderHtml(node: unknown): Promise<string> {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  return new Response(await renderToReadableStream(node as never)).text();
}

async function seed() {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice@example.com", email: "alice@example.com", name: "Alice", roles: [] });
  const { create } = await import("../lib/learnings");
  const bab = create({ authorId: "alice@example.com", title: "Bab deploy notes", body: "Deploy steps for bab.", project: "bab" });
  const forge = create({
    authorId: "alice@example.com",
    title: "Forge deploy notes",
    body: "Deploy steps for forge2.",
    project: "forge2",
    confirmNotDuplicate: true,
  });
  return { bab, forge };
}

/** Two authors, two projects, two tags: enough spread to exercise every filter and
 *  their combinations without any of them accidentally matching by coincidence. */
async function seedFilterBar() {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice@example.com", email: "alice@example.com", name: "Alice", roles: [] });
  upsertUser({ id: "bob@example.com", email: "bob@example.com", name: "Bob", roles: [] });
  const { create } = await import("../lib/learnings");
  const babAlice = create({
    authorId: "alice@example.com",
    title: "Bab deploy notes",
    body: "Deploy steps for bab.",
    project: "bab",
    tags: ["engineering"],
  });
  const forgeBob = create({
    authorId: "bob@example.com",
    title: "Forge deploy notes",
    body: "Deploy steps for forge2.",
    project: "forge2",
    tags: ["marketing"],
    confirmNotDuplicate: true,
  });
  return { babAlice, forgeBob };
}

/** Inserts a learning straight into the DB (bypassing create(), which always writes
 *  status='active') so tests can exercise the archived/deleted status filter. */
async function insertRawLearning(row: {
  id: string;
  authorId: string;
  title: string;
  project?: string | null;
  status: string;
}) {
  const { getDb } = await import("../lib/db");
  getDb()
    .prepare(
      "INSERT INTO learnings (id, author_id, title, body, tags, project, status) VALUES (?, ?, ?, 'raw body', '[]', ?, ?)",
    )
    .run(row.id, row.authorId, row.title, row.project ?? null, row.status);
}

/** Finds the href of the <a aria-label="..."> pill/link — used to check that removing
 *  one active filter preserves the others (they end up as the surviving query params). */
function linkHrefByAriaLabel(html: string, ariaLabel: string): string {
  const escaped = ariaLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagMatch = html.match(new RegExp(`<a [^>]*aria-label="${escaped}"[^>]*>`));
  if (!tagMatch) throw new Error(`No link found with aria-label "${ariaLabel}" in:\n${html}`);
  const hrefMatch = tagMatch[0].match(/href="([^"]+)"/);
  if (!hrefMatch) throw new Error(`Link with aria-label "${ariaLabel}" has no href:\n${tagMatch[0]}`);
  return hrefMatch[1];
}

describe("/memory shows project as its own chip, distinct from tags", () => {
  it("renders each row's project as a link to the filtered list", async () => {
    const { bab } = await seed();
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain(`href="/memory?project=bab"`);
    expect(html).toMatch(/>\s*bab\s*</);
    // Sanity: the learning itself is actually present on the page.
    expect(html).toContain(bab.title);
  });

  it("renders a project filter dropdown (topProjects) alongside the tag chips", async () => {
    await seed();
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain(`id="memory-filter-project"`);
    expect(html).toContain("All projects");
    expect(html).toContain(`<option value="bab">bab (1)</option>`);
    expect(html).toContain(`<option value="forge2">forge2 (1)</option>`);
  });

  it("filters the list to one project via ?project=", async () => {
    const { bab, forge } = await seed();
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ project: "bab" }) }));

    expect(html).toContain(bab.title);
    expect(html).not.toContain(forge.title);
  });
});

describe("/memory pagination", () => {
  async function seedManyLearnings(n: number) {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "alice@example.com", email: "alice@example.com", name: "Alice", roles: [] });
    for (let i = 0; i < n; i++) {
      await insertRawLearning({ id: `bulk-${i}`, authorId: "alice@example.com", title: `Bulk note ${i}`, status: "active" });
    }
  }

  it("shows only the first page (20) by default, with a Next link and no Previous", async () => {
    await seedManyLearnings(25);
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Showing 1-20 of 25 memories");
    expect(html).toContain('href="/memory?page=2"');
    expect(html).not.toMatch(/href="[^"]*"[^>]*>\s*Previous\s*</);
  });

  it("page=2 shows the remainder, with a Previous link and no Next", async () => {
    await seedManyLearnings(25);
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ page: "2" }) }));

    expect(html).toContain("Showing 21-25 of 25 memories");
    expect(html).toContain('href="/memory">Previous');
    expect(html).not.toMatch(/href="[^"]*"[^>]*>\s*Next\s*</);
  });

  it("a page past the end shows the last page instead of an empty one", async () => {
    await seedManyLearnings(25);
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ page: "999999999" }) }));

    expect(html).toContain("Showing 21-25 of 25 memories");
  });

  it("preserves other filters across the page link", async () => {
    await seedManyLearnings(25);
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ author: "alice@example.com" }) }));

    expect(html).toContain('href="/memory?author=alice%40example.com&amp;page=2"');
  });

  it("an out-of-range page collapses to page 1 rather than erroring", async () => {
    await seedManyLearnings(3);
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ page: "not-a-number" }) }));

    expect(html).toContain("Showing 1-3 of 3 memories");
  });
});

describe("age and expiry text (Change 1: show how fresh a memory is)", () => {
  it("shows 'Saved N ago' plus expiry on the /memory list row", async () => {
    const { bab } = await seed();
    const { getDb } = await import("../lib/db");
    getDb()
      .prepare("UPDATE learnings SET created_at = datetime('now', '-150 days'), expires_at = date('now', '+30 days') WHERE id = ?")
      .run(bab.id);

    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Saved 5 months ago");
    expect(html).toContain("valid for 30 more days");
  });

  it("shows 'past its valid-until date' once expires_at has passed, on both list and detail", async () => {
    const { bab } = await seed();
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET expires_at = date('now', '-3 days') WHERE id = ?").run(bab.id);

    const { default: MemoryPage } = await import("../app/memory/page");
    const listHtml = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ status: "all" }) }));
    expect(listHtml).toContain("past its valid-until date");

    const { default: LearningDetailPage } = await import("../app/memory/[id]/page");
    const detailHtml = await renderHtml(LearningDetailPage({ params: Promise.resolve({ id: bab.id }) }));
    expect(detailHtml).toContain("past its valid-until date");
  });

  it("shows age and expiry on the /memory/[id] detail page", async () => {
    const { bab } = await seed();
    const { getDb } = await import("../lib/db");
    getDb()
      .prepare("UPDATE learnings SET created_at = datetime('now', '-10 days'), expires_at = date('now', '+2 days') WHERE id = ?")
      .run(bab.id);

    const { default: LearningDetailPage } = await import("../app/memory/[id]/page");
    const html = await renderHtml(LearningDetailPage({ params: Promise.resolve({ id: bab.id }) }));

    expect(html).toContain("Saved 10 days ago");
    expect(html).toContain("valid for 2 more days");
  });
});

describe("/memory/[id] shows project in the byline", () => {
  it("links the project to the filtered memory list", async () => {
    const { bab } = await seed();
    const { default: LearningDetailPage } = await import("../app/memory/[id]/page");
    const html = await renderHtml(LearningDetailPage({ params: Promise.resolve({ id: bab.id }) }));

    expect(html).toContain(`href="/memory?project=bab"`);
    expect(html).toMatch(/>\s*bab\s*</);
  });

  it("omits the project chip when the learning has none", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "alice@example.com", email: "alice@example.com", name: "Alice", roles: [] });
    const { create } = await import("../lib/learnings");
    const l = create({ authorId: "alice@example.com", title: "No project note", body: "Company-wide." });

    const { default: LearningDetailPage } = await import("../app/memory/[id]/page");
    const html = await renderHtml(LearningDetailPage({ params: Promise.resolve({ id: l.id }) }));

    expect(html).not.toContain("/memory?project=");
  });
});

describe("/memory filter bar", () => {
  it("narrows the list by project", async () => {
    const { babAlice, forgeBob } = await seedFilterBar();
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ project: "bab" }) }));

    expect(html).toContain(babAlice.title);
    expect(html).not.toContain(forgeBob.title);
  });

  it("narrows the list by author", async () => {
    const { babAlice, forgeBob } = await seedFilterBar();
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ author: "bob@example.com" }) }));

    expect(html).toContain(forgeBob.title);
    expect(html).not.toContain(babAlice.title);
  });

  it("narrows the list by tag", async () => {
    const { babAlice, forgeBob } = await seedFilterBar();
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ tag: "marketing" }) }));

    expect(html).toContain(forgeBob.title);
    expect(html).not.toContain(babAlice.title);
  });

  it("combines project and author filters (AND, not OR)", async () => {
    const { babAlice, forgeBob } = await seedFilterBar();
    const { default: MemoryPage } = await import("../app/memory/page");

    const matching = await renderHtml(
      MemoryPage({ searchParams: Promise.resolve({ project: "bab", author: "alice@example.com" }) }),
    );
    expect(matching).toContain(babAlice.title);
    expect(matching).not.toContain(forgeBob.title);

    // bab's author is Alice, not Bob: crossing project and author from different
    // learnings must match nothing, proving the filters AND together.
    const crossed = await renderHtml(
      MemoryPage({ searchParams: Promise.resolve({ project: "bab", author: "bob@example.com" }) }),
    );
    expect(crossed).not.toContain(babAlice.title);
    expect(crossed).not.toContain(forgeBob.title);
    expect(crossed).toContain("Nothing matches.");
  });

  it("defaults to active/expiring, offers archived-only and include-archived", async () => {
    const { babAlice } = await seedFilterBar();
    await insertRawLearning({ id: "arch-1", authorId: "alice@example.com", title: "Old archived note", status: "archived" });
    await insertRawLearning({ id: "del-1", authorId: "alice@example.com", title: "Deleted note", status: "deleted" });

    const { default: MemoryPage } = await import("../app/memory/page");

    const byDefault = await renderHtml(MemoryPage({ searchParams: Promise.resolve({}) }));
    expect(byDefault).toContain(babAlice.title);
    expect(byDefault).not.toContain("Old archived note");
    expect(byDefault).not.toContain("Deleted note");

    const archivedOnly = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ status: "archived" }) }));
    expect(archivedOnly).toContain("Old archived note");
    expect(archivedOnly).not.toContain(babAlice.title);
    expect(archivedOnly).not.toContain("Deleted note");

    const includeArchived = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ status: "all" }) }));
    expect(includeArchived).toContain(babAlice.title);
    expect(includeArchived).toContain("Old archived note");
    expect(includeArchived).not.toContain("Deleted note");
  });

  it("shows 'Showing X-Y of N memories' for the current filters", async () => {
    await seedFilterBar();
    const { default: MemoryPage } = await import("../app/memory/page");

    const unfiltered = await renderHtml(MemoryPage({ searchParams: Promise.resolve({}) }));
    expect(unfiltered).toContain("Showing 1-2 of 2 memories");

    const filteredHtml = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ project: "bab" }) }));
    expect(filteredHtml).toContain("Showing 1-1 of 1 memory");
  });

  it("shows each active filter as a removable pill with an accessible name, preserving the others on removal", async () => {
    const { babAlice } = await seedFilterBar();
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(
      MemoryPage({ searchParams: Promise.resolve({ project: "bab", author: "alice@example.com", tag: "engineering" }) }),
    );

    expect(html).toContain(babAlice.title);
    expect(html).toContain('aria-label="remove project filter bab"');
    expect(html).toContain('aria-label="remove author filter Alice"');
    expect(html).toContain('aria-label="remove tag filter engineering"');

    // Removing the project pill must keep author and tag in the resulting link.
    const withoutProject = linkHrefByAriaLabel(html, "remove project filter bab");
    expect(withoutProject).not.toContain("project=");
    expect(withoutProject).toContain("tag=engineering");
    expect(withoutProject).toContain("author=alice%40example.com");
  });

  it("shows 'Clear all' only once more than one filter is active, and it clears everything", async () => {
    await seedFilterBar();
    const { default: MemoryPage } = await import("../app/memory/page");

    const onlyOne = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ project: "bab" }) }));
    expect(onlyOne).not.toContain("Clear all");

    const twoActive = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ project: "bab", tag: "engineering" }) }));
    expect(twoActive).toContain(">Clear all<");
    expect(twoActive).toContain('href="/memory">Clear all');
  });

  it("mentions the active filters in the empty state when nothing matches", async () => {
    await seedFilterBar();
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(
      MemoryPage({ searchParams: Promise.resolve({ project: "bab", author: "bob@example.com" }) }),
    );

    expect(html).toContain("Nothing matches.");
    expect(html).toContain("project: bab");
    expect(html).toContain("author: Bob");
    expect(html).toContain("clear the filters");
  });

  it("keeps the project dropdown when no memory has a real project key yet, offering General instead of hiding it", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "alice@example.com", email: "alice@example.com", name: "Alice", roles: [] });
    const { create } = await import("../lib/learnings");
    create({ authorId: "alice@example.com", title: "No project note", body: "Company-wide." });

    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain(`id="memory-filter-project"`);
    expect(html).toContain(`id="memory-filter-author"`);
    expect(html).toContain(`id="memory-filter-status"`);
    expect(html).toContain("All projects");
    expect(html).toContain(`<option value="_general">General (1)</option>`);
    expect(html).not.toMatch(/>\s*null\s*</i);
  });

  it("filters to no-project memories via ?project=_general, and never shows 'null' as an option", async () => {
    const { bab } = await seed();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "carol@example.com", email: "carol@example.com", name: "Carol", roles: [] });
    const { create } = await import("../lib/learnings");
    const general = create({ authorId: "carol@example.com", title: "Company-wide note", body: "No scope here." });

    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ project: "_general" }) }));

    expect(html).toContain(general.title);
    expect(html).not.toContain(bab.title);
    expect(html).toContain("project: General");

    // A real project key still filters exactly as before.
    const babOnly = await renderHtml(MemoryPage({ searchParams: Promise.resolve({ project: "bab" }) }));
    expect(babOnly).toContain(bab.title);
    expect(babOnly).not.toContain(general.title);
  });
});
