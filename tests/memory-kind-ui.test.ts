import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-memory-kind-ui-test-"));
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

const SOURCE_URL = "https://wiki.example.com/wiki/spaces/DOCS/pages/42/ADR+3#Decision";

async function seed() {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice@example.com", email: "alice@example.com", name: "Alice", roles: [] });
  const { create } = await import("../lib/learnings");
  const learning = create({
    authorId: "alice@example.com",
    title: "Kiosk gotcha red",
    body: "The red kiosk drops sessions after a deploy.",
    project: "bab",
  });
  const standard = create({
    authorId: "alice@example.com",
    title: "Services extend the shared pipeline",
    body: "Every repository extends the shared pipeline template.",
    kind: "standard",
    project: "bab",
    confirmNotDuplicate: true,
  });
  const decision = create({
    authorId: "alice@example.com",
    title: "Kafka over REST between services",
    body: "Services talk through events, chosen for decoupling.",
    kind: "decision",
    project: "forge2",
    source: "confluence",
    sourceUrl: SOURCE_URL,
    sourceVersion: 3,
    confirmNotDuplicate: true,
  });
  return { learning, standard, decision };
}

async function renderList(searchParams: Record<string, string>) {
  const { default: MemoryPage } = await import("../app/memory/page");
  return renderHtml(MemoryPage({ searchParams: Promise.resolve(searchParams) }));
}

async function renderDetail(id: string) {
  const { default: DetailPage } = await import("../app/memory/[id]/page");
  return renderHtml(await DetailPage({ params: Promise.resolve({ id }) }));
}

describe("/memory kind filter and badge", () => {
  it("?kind=standard lists only standards and shows the kind badge", async () => {
    const { learning, standard } = await seed();
    const html = await renderList({ kind: "standard" });
    expect(html).toContain(standard.title);
    expect(html).not.toContain(learning.title);
    expect(html).toMatch(/>standard<\/span>/);
  });

  it("shows no kind badge for an ordinary learning", async () => {
    const { learning } = await seed();
    const html = await renderList({ kind: "learning" });
    expect(html).toContain(learning.title);
    expect(html).not.toMatch(/>learning<\/span>/);
  });

  it("?kind=bogus shows all kinds instead of failing", async () => {
    const { learning, standard, decision } = await seed();
    const html = await renderList({ kind: "bogus" });
    for (const l of [learning, standard, decision]) expect(html).toContain(l.title);
    expect(html).not.toContain("kind: bogus");
  });

  it("the kind select offers all kinds and keeps the chosen one", async () => {
    await seed();
    const html = await renderList({ kind: "decision" });
    expect(html).toContain(`id="memory-filter-kind"`);
    expect(html).toContain("All kinds");
    for (const label of ["Learning", "Practice", "Standard", "Decision"]) expect(html).toContain(`>${label}</option>`);
    expect(html).toMatch(/<option value="decision" selected[^>]*>Decision<\/option>/);
    expect(html).toContain("kind: decision");
  });

  it("a comma-list kind filter survives a re-render: the select offers it as its own selected option", async () => {
    await seed();
    const html = await renderList({ kind: "standard,decision" });
    expect(html).toMatch(/<option value="standard,decision" selected[^>]*>[^<]*standard, decision<\/option>/);
  });

  it("the kind filter combines with project", async () => {
    const { standard, decision } = await seed();
    const html = await renderList({ kind: "standard,decision", project: "bab" });
    expect(html).toContain(standard.title);
    expect(html).not.toContain(decision.title);
  });

  it("a Confluence mirror carries a Confluence chip in the list", async () => {
    await seed();
    const html = await renderList({ kind: "decision" });
    expect(html).toContain(">Confluence<");
  });
});

describe("/memory/[id] source link", () => {
  it("links a mirror's source with rel noopener noreferrer and shows the version", async () => {
    const { decision } = await seed();
    const html = await renderDetail(decision.id);
    expect(html).toContain(`href="${SOURCE_URL}"`);
    expect(html).toContain(`rel="noopener noreferrer"`);
    expect(html).toContain("v3");
    expect(html).toMatch(/>decision<\/span>/);
  });

  it("omits the version when source_version is null", async () => {
    const { decision } = await seed();
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET source_version = NULL WHERE id = ?").run(decision.id);
    const html = await renderDetail(decision.id);
    expect(html).toContain(`href="${SOURCE_URL}"`);
    expect(html).toContain(">Confluence page<");
    expect(html).not.toContain("vnull");
    expect(html).not.toMatch(/Confluence page, v/);
  });

  it("does not link a source_url that fails the check", async () => {
    const { decision } = await seed();
    const { getDb } = await import("../lib/db");
    // Written around create() on purpose: the page must not trust what is stored.
    getDb().prepare("UPDATE learnings SET source_url = 'javascript:alert(1)' WHERE id = ?").run(decision.id);
    const html = await renderDetail(decision.id);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("Confluence page");
  });

  it("an ordinary learning has no Source fact and no kind badge", async () => {
    const { learning } = await seed();
    const html = await renderDetail(learning.id);
    expect(html).not.toContain("Source");
    expect(html).not.toMatch(/>learning<\/span>/);
  });
});

describe("standing in the Memory pages", () => {
  it("the list shows a standing badge and no longer shows the raw score chip", async () => {
    await seed();
    const html = await renderList({});
    expect(html).toMatch(/>Standing: weak<\/span>/);
    expect(html).toContain('title="Standing: weak (no reactions yet)"');
    expect(html).not.toContain("Trust-weighted score");
  });

  it("the detail page shows the standing badge with its reason and still shows Score", async () => {
    const { standard } = await seed();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob@example.com", email: "bob@example.com", name: "Bob", roles: [] });
    const { confirm } = await import("../lib/learnings");
    confirm(standard.id, "bob@example.com", "src/x.ts, 2026-10-01");
    const html = await renderDetail(standard.id);
    expect(html).toContain("Standing");
    expect(html).toContain("fair (1 confirmation, last today)");
    expect(html).toContain("Score");
  });

  it("names standing and the author's confidence apart, the same words as the list", async () => {
    const { learning } = await seed();
    const detail = (await renderDetail(learning.id)).replace(/&#x27;/g, "'");
    expect(detail).toMatch(/Standing<\/span><span[^>]*>weak \(no reactions yet\)/);
    expect(detail).toMatch(/Author's confidence<\/span><span[^>]*>medium/);
    expect(detail).not.toMatch(/>Confidence</);
    const { standingText, confidenceText } = await import("../lib/standing");
    expect(standingText("weak", "no reactions yet")).toBe("Standing: weak (no reactions yet)");
    expect(confidenceText("high")).toBe("Author's confidence: high");
  });
});

describe("recent confirmations and flags on the detail page", () => {
  async function withNotes(note: string) {
    const { standard } = await seed();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob@example.com", email: "bob@example.com", name: "Bob", roles: [] });
    const { confirm } = await import("../lib/learnings");
    confirm(standard.id, "bob@example.com", note);
    return standard;
  }

  it("lists the notes with who and when, and counts the confirmations", async () => {
    const standard = await withNotes("src/pipeline.yml, 2026-10-01");
    const html = await renderDetail(standard.id);
    expect(html).toContain("Recent confirmations, flags and retirements");
    expect(html).toContain("Bob");
    expect(html).toContain("src/pipeline.yml, 2026-10-01");
    expect(html).toMatch(/Confirmations<\/span><span[^>]*>1</);
  });

  it("renders notes as escaped text", async () => {
    const standard = await withNotes("<script>alert(1)</script> src/x.ts");
    const html = await renderDetail(standard.id);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("shows no notes section when there are none", async () => {
    const { learning } = await seed();
    const html = await renderDetail(learning.id);
    expect(html).not.toContain("Recent confirmations, flags and retirements");
  });
});

describe("the latest retire or restore on the detail page", () => {
  async function retired(note: string) {
    const { learning } = await seed();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob@example.com", email: "bob@example.com", name: "Bob", roles: [] });
    const { retire } = await import("../lib/learnings");
    retire(learning.id, "bob@example.com", "mcp", note);
    return learning;
  }

  it("says who retired it, when and why, under the heading that now covers retirements", async () => {
    const learning = await retired("Replaced by the new pipeline, azure-pipelines.yml 2026-10-02");
    const html = await renderDetail(learning.id);
    expect(html).toContain("Recent confirmations, flags and retirements");
    expect(html).not.toContain("Recent confirmations and flags");
    expect(html).toMatch(/<strong>Retired<\/strong> by Bob,/);
    expect(html).toContain("Replaced by the new pipeline, azure-pipelines.yml 2026-10-02");
    expect(html).toContain("This memory is archived.");
  });

  it("still shows it after five later confirmations and flags filled the shared note list", async () => {
    const learning = await retired("Gone from main, 2026-10-02");
    const { upsertUser } = await import("../lib/users");
    const { confirm, flag } = await import("../lib/learnings");
    for (let i = 1; i <= 3; i++) {
      upsertUser({ id: `c${i}@example.com`, email: `c${i}@example.com`, name: `Checker ${i}`, roles: [] });
      confirm(learning.id, `c${i}@example.com`, `src/c${i}.ts, 2026-10-02`);
    }
    for (let i = 1; i <= 3; i++) {
      upsertUser({ id: `f${i}@example.com`, email: `f${i}@example.com`, name: `Flagger ${i}`, roles: [] });
      flag(learning.id, `f${i}@example.com`, "mcp", `flag note ${i}`);
    }
    const html = await renderDetail(learning.id);
    expect(html).toMatch(/<strong>Retired<\/strong> by Bob,/);
    expect(html).toContain("Gone from main, 2026-10-02");
    // Five of the six later notes are listed; the oldest of them has left the list, the retire has not.
    expect(html.match(/<strong>(confirm|flag)<\/strong>/g)).toHaveLength(5);
  });

  it("shows a restore instead once the memory was restored", async () => {
    const learning = await retired("Looked stale");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "dee@example.com", email: "dee@example.com", name: "Dee", roles: [] });
    const { keepLearning } = await import("../lib/learnings");
    keepLearning(learning.id, "dee@example.com", "mcp", "Still in the repo, src/a.ts 2026-10-02");
    const html = await renderDetail(learning.id);
    expect(html).toMatch(/<strong>Restored<\/strong> by Dee,/);
    expect(html).toContain("Still in the repo, src/a.ts 2026-10-02");
    expect(html).not.toContain("Looked stale");
    expect(html).not.toContain("This memory is archived.");
  });

  it("renders the note as escaped text", async () => {
    const learning = await retired("<script>alert(1)</script> gone");
    const html = await renderDetail(learning.id);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("shows nothing for a deleted memory", async () => {
    const learning = await retired("Gone");
    const { deleteOwn } = await import("../lib/learnings");
    deleteOwn(learning.id, "alice@example.com", "mcp");
    const html = await renderDetail(learning.id);
    expect(html).not.toContain("Recent confirmations, flags and retirements");
    expect(html).not.toContain("Retired");
  });
});

describe("the vote boxes on the detail page", () => {
  it("shows Helpful, Kudos, Not helpful and Flags next to each other, also at zero", async () => {
    const { learning } = await seed();
    let html = await renderDetail(learning.id);
    const box = (label: string, n: number) =>
      new RegExp(`<span class="[^"]*factK[^"]*">${label}</span><span class="[^"]*factV[^"]*">${n}</span>`);
    for (const label of ["Helpful", "Kudos", "Not helpful", "Flags"]) expect(html).toMatch(box(label, 0));

    const { upsertUser } = await import("../lib/users");
    for (const id of ["bob@example.com", "cat@example.com", "dan@example.com"]) upsertUser({ id, email: id, name: id, roles: [] });
    const { vote, flag } = await import("../lib/learnings");
    vote(learning.id, "bob@example.com", "not_helpful", "mcp");
    vote(learning.id, "cat@example.com", "not_helpful", "mcp");
    flag(learning.id, "dan@example.com", "mcp", "Moved to src/x.ts, 2026-10-01");
    html = await renderDetail(learning.id);
    expect(html).toMatch(box("Not helpful", 2));
    expect(html).toMatch(box("Flags", 1));
  });
});
