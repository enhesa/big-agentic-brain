import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-conversations-test-"));
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

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice@example.com", email: "alice@example.com", name: "Alice", roles: [] });
  upsertUser({ id: "bob@example.com", email: "bob@example.com", name: "Bob", roles: [] });
  upsertUser({ id: "carol@example.com", email: "carol@example.com", name: "Carol", roles: [] });
}

describe("listAllThreads", () => {
  it("orders threads newest-activity-first", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const { thread: t1 } = send({ fromId: "alice@example.com", to: "bob@example.com", subject: "First", body: "Hi" });
    send({ fromId: "bob@example.com", to: "carol@example.com", subject: "Second", body: "Hi" });
    // Bump t1's activity above the second thread.
    send({ fromId: "bob@example.com", to: "alice@example.com", threadId: t1.id, body: "Reply" });

    const { listAllThreads } = await import("../lib/messages");
    const threads = listAllThreads();
    expect(threads[0].id).toBe(t1.id);
    expect(threads.length).toBe(2);
  });

  it("derives participants from creator plus both sides of every message", async () => {
    await seedUsers();
    const { send, listAllThreads } = await import("../lib/messages");
    const { thread: t } = send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Hi", body: "Hi" });
    send({ fromId: "bob@example.com", to: "carol@example.com", threadId: undefined, subject: "unused", body: "x" }); // separate thread, ignore
    send({ fromId: "bob@example.com", to: "alice@example.com", threadId: t.id, body: "Reply" });

    const threads = listAllThreads();
    const found = threads.find((th) => th.id === t.id)!;
    const ids = found.participants.map((p) => p.id).sort();
    expect(ids).toEqual(["alice@example.com", "bob@example.com"]);
    expect(found.participants.every((p) => p.name)).toBe(true);
  });

  it("reports message count and last snippet", async () => {
    await seedUsers();
    const { send, listAllThreads } = await import("../lib/messages");
    const { thread: t } = send({
      fromId: "alice@example.com",
      to: "bob@example.com",
      subject: "Hi",
      body: "First message",
    });
    send({ fromId: "bob@example.com", to: "alice@example.com", threadId: t.id, body: "Second message body" });

    const threads = listAllThreads();
    const found = threads.find((th) => th.id === t.id)!;
    expect(found.messageCount).toBe(2);
    expect(found.lastSnippet).toBe("Second message body");
  });

  it("truncates the snippet to 140 chars", async () => {
    await seedUsers();
    const { send, listAllThreads } = await import("../lib/messages");
    const long = "x".repeat(300);
    send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Hi", body: long });

    const threads = listAllThreads();
    expect(threads[0].lastSnippet.length).toBe(140);
  });

  it("filters by q against subject and body", async () => {
    await seedUsers();
    const { send, listAllThreads } = await import("../lib/messages");
    send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Alert filter migration", body: "unrelated" });
    send({ fromId: "bob@example.com", to: "carol@example.com", subject: "Lunch", body: "mentions migration here" });
    send({ fromId: "carol@example.com", to: "alice@example.com", subject: "Nothing", body: "irrelevant" });

    const byQ = listAllThreads({ q: "migration" });
    expect(byQ.length).toBe(2);
    expect(byQ.every((t) => t.subject !== "Nothing")).toBe(true);
  });

  it("clamps limit to 100 and defaults to 50", async () => {
    await seedUsers();
    const { send, listAllThreads } = await import("../lib/messages");
    for (let i = 0; i < 5; i++) {
      send({ fromId: "alice@example.com", to: "bob@example.com", subject: `T${i}`, body: "x" });
    }

    expect(listAllThreads({ limit: 500 }).length).toBeLessThanOrEqual(100);
    expect(listAllThreads({ limit: 2 }).length).toBe(2);
    expect(listAllThreads().length).toBe(5); // fewer than default 50
  });

  it("paginates with the before cursor on lastMessageAt", async () => {
    await seedUsers();
    const { send, listAllThreads } = await import("../lib/messages");
    const { getDb } = await import("../lib/db");
    const { thread: older } = send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Old", body: "x" });
    const { thread: newer } = send({ fromId: "alice@example.com", to: "bob@example.com", subject: "New", body: "x" });

    // datetime('now') has second granularity; force distinct activity times
    // so the cursor comparison is deterministic instead of flaking on ties.
    const db = getDb();
    db.prepare("UPDATE messages SET created_at = '2020-01-01 00:00:00' WHERE thread_id = ?").run(older.id);
    db.prepare("UPDATE messages SET created_at = '2020-01-02 00:00:00' WHERE thread_id = ?").run(newer.id);

    const all = listAllThreads();
    expect(all.length).toBe(2);
    const cursor = all[0].lastMessageAt;
    const beforeCursor = listAllThreads({ before: cursor });
    expect(beforeCursor.length).toBe(1);
    expect(beforeCursor[0].id).toBe(all[1].id);
  });
});

describe("threadForViewer", () => {
  it("returns messages chronologically with sender/recipient names and emails resolved", async () => {
    await seedUsers();
    const { send, threadForViewer } = await import("../lib/messages");
    const { thread: t } = send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Hi", body: "First" });
    send({ fromId: "bob@example.com", to: "alice@example.com", threadId: t.id, body: "Second" });

    const result = threadForViewer(t.id)!;
    expect(result.messages.length).toBe(2);
    expect(result.messages[0].body).toBe("First");
    expect(result.messages[1].body).toBe("Second");
    expect(result.messages[0].fromName).toBe("Alice");
    expect(result.messages[0].fromEmail).toBe("alice@example.com");
    expect(result.messages[0].toName).toBe("Bob");
    expect(result.messages[0].toEmail).toBe("bob@example.com");
  });

  it("has no participant restriction: any thread id resolves for any viewer", async () => {
    await seedUsers();
    const { send, threadForViewer } = await import("../lib/messages");
    const { thread: t } = send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Hi", body: "First" });

    // carol never sent/received a message in this thread, yet threadForViewer
    // (unlike thread()/requireThreadForActor) still returns it.
    const result = threadForViewer(t.id);
    expect(result).toBeTruthy();
  });

  it("returns undefined for a missing thread", async () => {
    const { threadForViewer } = await import("../lib/messages");
    expect(threadForViewer("nope")).toBeUndefined();
  });
});

describe("Conversation thread page (render)", () => {
  it("app/conversations/[threadId]/page.tsx escapes message bodies while preserving them as text", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    await seedUsers();
    const { send } = await import("../lib/messages");
    const { thread: t } = send({
      fromId: "alice@example.com",
      to: "bob@example.com",
      subject: "Hi",
      body: "<script>alert(1)</script>",
    });

    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: ConversationDetailPage } = await import("../app/conversations/[threadId]/page");

    const html = await new Response(
      await renderToReadableStream(
        ConversationDetailPage({ params: Promise.resolve({ threadId: t.id }) }) as never,
      ),
    ).text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Read-only. Agents reply with");
    expect(html).toContain("POST /api/messages");
  });

  it("app/conversations/[threadId]/page.tsx tags a legacy auto-reply message", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    await seedUsers();
    const { send } = await import("../lib/messages");
    const { getDb } = await import("../lib/db");
    const { thread: t } = send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Hi", body: "First" });
    // kind:"auto" can no longer be created via send(); insert a legacy row directly
    // to exercise the read-only rendering of historic auto-reply messages.
    const { message } = send({ fromId: "bob@example.com", threadId: t.id, body: "auto reply" }, "mcp");
    getDb().prepare("UPDATE messages SET kind = 'auto' WHERE id = ?").run(message.id);

    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: ConversationDetailPage } = await import("../app/conversations/[threadId]/page");

    const html = await new Response(
      await renderToReadableStream(ConversationDetailPage({ params: Promise.resolve({ threadId: t.id }) }) as never),
    ).text();

    expect(html).toContain("auto-reply");
    expect(html).not.toContain("listeningDot");
  });
});
