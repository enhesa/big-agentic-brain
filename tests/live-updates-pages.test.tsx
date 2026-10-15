import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-live-updates-pages-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

/** Every page LiveUpdates is wired into renders its own <span class="wrap ..."> status dot. */
async function renderHtml(node: unknown): Promise<string> {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  return new Response(await renderToReadableStream(node as never)).text();
}

describe("LiveUpdates is wired into the read-only pages", () => {
  it("renders on app/memory/page.tsx", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await renderHtml(MemoryPage({ searchParams: Promise.resolve({}) }));
    expect(html).toMatch(/title="Reconnecting"|title="Live"/);
  });

  it("renders on app/memory/[id]/page.tsx", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "alice@example.com", email: "alice@example.com", name: "Alice", roles: [] });
    const { create } = await import("../lib/learnings");
    const learning = create({ authorId: "alice@example.com", title: "T", body: "B", tags: [] });

    const { default: LearningDetailPage } = await import("../app/memory/[id]/page");
    const html = await renderHtml(LearningDetailPage({ params: Promise.resolve({ id: learning.id }) }));
    expect(html).toMatch(/title="Reconnecting"|title="Live"/);
  });

  it("is gone from the Users section of app/usage/page.tsx (it only followed presence)", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    vi.doMock("@/app/components/shell/Shell", () => ({ default: ({ children }: { children: unknown }) => children }));
    const { default: UsagePage } = await import("../app/usage/page");
    const html = await renderHtml(await UsagePage());
    expect(html).toContain('id="users"');
    expect(html).not.toMatch(/id="users"[\s\S]*(title="Reconnecting"|title="Live")/);
  });

  it("renders on app/conversations/[threadId]/page.tsx, for a signed-in participant", async () => {
    // The thread page is for its participants, signed in through the proxy with a long-form address.
    const ALICE = "alice.a@example.com";
    const BOB = "bob.b@example.com";
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    vi.doMock("next/headers", () => ({
      headers: async () =>
        new Headers({
          "x-auth-request-user": "proxy-alice",
          "x-auth-request-email": ALICE,
          "x-auth-request-preferred-username": "Alice A",
        }),
    }));
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: ALICE, email: ALICE, name: "Alice A", roles: [] });
    upsertUser({ id: BOB, email: BOB, name: "Bob B", roles: [] });
    const { send } = await import("../lib/messages");
    const { thread } = send({ fromId: ALICE, to: BOB, subject: "Hi", body: "Hi" });

    const { default: ConversationDetailPage } = await import("../app/conversations/[threadId]/page");
    const html = await renderHtml(ConversationDetailPage({ params: Promise.resolve({ threadId: thread.id }) }));
    expect(html).toMatch(/title="Reconnecting"|title="Live"/);
  });
});
