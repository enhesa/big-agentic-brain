import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The "Applies to" chips on a memory page and the filter on the /memory list. */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-memory-applies-ui-test-"));
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
  const dotnet = create({
    authorId: "alice@example.com",
    title: "Flags in dotnet",
    body: "Use IsEnabledAsync.",
    appliesTo: ["dotnet", "aks"],
    confirmNotDuplicate: true,
  });
  const anywhere = create({
    authorId: "alice@example.com",
    title: "Write short commit messages",
    body: "Say what changed in one line.",
    confirmNotDuplicate: true,
  });
  const python = create({
    authorId: "alice@example.com",
    title: "Pin the python base image",
    body: "Only 3-slim and 3.10-slim exist.",
    appliesTo: ["python"],
    confirmNotDuplicate: true,
  });
  return { dotnet, anywhere, python };
}

async function renderList(searchParams: Record<string, string>) {
  const { default: MemoryPage } = await import("../app/memory/page");
  return renderHtml(MemoryPage({ searchParams: Promise.resolve(searchParams) }));
}

async function renderDetail(id: string) {
  const { default: DetailPage } = await import("../app/memory/[id]/page");
  return renderHtml(await DetailPage({ params: Promise.resolve({ id }) }));
}

describe("memory page chips", () => {
  it("shows one chip per label, linking to the filter", async () => {
    const { dotnet } = await seed();
    const html = await renderDetail(dotnet.id);
    expect(html).toContain("Applies to:");
    expect(html).toMatch(/href="\/memory\?applies=dotnet"[^>]*>dotnet<\/a>/);
    expect(html).toMatch(/href="\/memory\?applies=aks"[^>]*>aks<\/a>/);
    expect(html).not.toContain(">everywhere<");
  });

  it("says everywhere when there are no labels", async () => {
    const { anywhere } = await seed();
    const html = await renderDetail(anywhere.id);
    expect(html).toContain("Applies to:");
    expect(html).toMatch(/>everywhere<\/span>/);
  });
});

describe("/memory applies-to filter", () => {
  it("lists only memories with that label, and shows the active-filter pill", async () => {
    const { dotnet, anywhere, python } = await seed();
    const html = await renderList({ applies: "dotnet" });
    expect(html).toContain(dotnet.title);
    expect(html).not.toContain(anywhere.title);
    expect(html).not.toContain(python.title);
    expect(html).toContain("applies to: dotnet");
  });

  it("normalises an alias, and everywhere lists the unlabelled ones", async () => {
    const { dotnet, anywhere } = await seed();
    const aliased = await renderList({ applies: "c#" });
    expect(aliased).toContain(dotnet.title);
    expect(aliased).not.toContain(anywhere.title);
    const everywhere = await renderList({ applies: "everywhere" });
    expect(everywhere).toContain(anywhere.title);
    expect(everywhere).not.toContain(dotnet.title);
  });

  it("a bad ?applies= shows everything instead of failing", async () => {
    const { dotnet, anywhere, python } = await seed();
    const html = await renderList({ applies: "rust" });
    for (const l of [dotnet, anywhere, python]) expect(html).toContain(l.title);
  });

  it("the filter bar offers every label and keeps the choice through search", async () => {
    await seed();
    const html = await renderList({ applies: "python" });
    expect(html).toContain('id="memory-filter-applies"');
    expect(html).toMatch(/<option value="python" selected/);
    for (const label of ["dotnet", "aks", "terraform", "macos"]) expect(html).toContain(`<option value="${label}"`);
    expect(html).toContain('<option value="everywhere"');
    // It is the one form's own select, so a new search sends it along and does not drop it.
    expect(html.match(/<form/g)).toHaveLength(1);
  });

  it("list rows show the labels as chips", async () => {
    await seed();
    const html = await renderList({});
    expect(html).toContain('title="Applies to dotnet"');
  });
});
