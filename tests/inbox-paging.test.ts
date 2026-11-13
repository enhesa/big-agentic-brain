import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The inbox pages and counts in SQL (inboxFor options, inboxCounts), the hook counts unread with
 * one COUNT row, and downvotedLive filters by author in SQL. Each must answer what the old
 * load-everything-then-filter code answered.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-inbox-paging-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

const ME = "pat@example.com";
const OTHER = "sam@example.com";

async function seedInbox(): Promise<string[]> {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ME, email: ME, name: "Pat", roles: [] });
  upsertUser({ id: OTHER, email: OTHER, name: "Sam", roles: [] });
  const { send, markRead } = await import("../lib/messages");
  const { getDb } = await import("../lib/db");
  const ids: string[] = [];
  // Seven threads, oldest first: threads 1, 3 and 5 are read, the rest stay unread.
  for (let i = 0; i < 7; i++) {
    const { thread } = send({ fromId: OTHER, to: ME, subject: `Topic ${i}`, body: `Body ${i}` });
    getDb().prepare("UPDATE messages SET created_at = ? WHERE thread_id = ?").run(`2026-01-0${i + 1} 10:00:00`, thread.id);
    if (i % 2 === 1) markRead(thread.id, ME, "mcp");
    ids.push(thread.id);
  }
  // One thread I only sent: listed for me, never unread for me, unread for the other person.
  const { thread } = send({ fromId: ME, to: OTHER, subject: "Mine", body: "Sent by me" });
  getDb().prepare("UPDATE messages SET created_at = ? WHERE thread_id = ?").run("2026-01-08 10:00:00", thread.id);
  ids.push(thread.id);
  return ids;
}

describe("inbox paging in SQL", () => {
  it("pages and filters the same as slicing the whole list", async () => {
    await seedInbox();
    const { inboxFor } = await import("../lib/messages");
    const all = inboxFor(ME);
    expect(all).toHaveLength(8);
    const unread = all.filter((t) => t.unreadCount > 0);
    expect(unread).toHaveLength(4);

    const ids = (ts: { thread: { id: string } }[]) => ts.map((t) => t.thread.id);
    expect(ids(inboxFor(ME, { limit: 3, offset: 0 }))).toEqual(ids(all.slice(0, 3)));
    expect(ids(inboxFor(ME, { limit: 3, offset: 6 }))).toEqual(ids(all.slice(6, 9)));
    expect(ids(inboxFor(ME, { unreadOnly: true, limit: 2, offset: 1 }))).toEqual(ids(unread.slice(1, 3)));
    expect(ids(inboxFor(ME, { unreadOnly: true }))).toEqual(ids(unread));
    // The shape is unchanged: the last message keeps its full body.
    expect(inboxFor(ME, { limit: 1 })[0].lastMessage.body).toBe(all[0].lastMessage.body);
  });

  it("counts threads and unread threads without loading them", async () => {
    await seedInbox();
    const { inboxCounts, unreadCountFor } = await import("../lib/messages");
    expect(inboxCounts(ME)).toEqual({ threads: 8, unreadThreads: 4 });
    expect(inboxCounts(OTHER)).toEqual({ threads: 8, unreadThreads: 1 });
    expect(unreadCountFor(ME)).toBe(4);
    expect(inboxCounts("nobody@example.com")).toEqual({ threads: 0, unreadThreads: 0 });
  });

  it("bab_inbox answers total, readThreads and nextOffset from the counts", async () => {
    await seedInbox();
    const { findTool } = await import("../lib/mcp");
    const actor = { id: ME, email: ME, name: "Pat", roles: [] } as never;
    const inbox = findTool("bab_inbox")!;
    const page1 = JSON.parse(await inbox.run(actor, { limit: 3 }));
    expect(page1.total).toBe(4);
    expect(page1.threads).toHaveLength(3);
    expect(page1.nextOffset).toBe(3);
    expect(page1.readThreads).toBe(4);

    const page2 = JSON.parse(await inbox.run(actor, { includeRead: true, limit: 5, offset: 5 }));
    expect(page2.total).toBe(8);
    expect(page2.threads).toHaveLength(3);
    expect(page2.nextOffset).toBeNull();
    const readOnPage = page2.threads.filter((t: { unreadCount: number }) => t.unreadCount === 0).length;
    expect(page2.readThreads).toBe(4 - readOnPage);
  });
});

describe("downvotedLive by author", () => {
  it("returns only that author's memories, the same rows as filtering the whole list", async () => {
    const { upsertUser } = await import("../lib/users");
    const voters = ["v1@example.com", "v2@example.com", "v3@example.com"];
    for (const id of [ME, OTHER, ...voters]) upsertUser({ id, email: id, name: id.split("@")[0], roles: [] });
    const { create, vote } = await import("../lib/learnings");
    const mine = create({ authorId: ME, title: "Builds run on the shared runner", body: "Unique body qxmine", confirmNotDuplicate: true });
    const theirs = create({ authorId: OTHER, title: "Releases are tagged by the pipeline", body: "Unique body qxtheirs", confirmNotDuplicate: true });
    for (const v of voters) {
      vote(mine.id, v, "not_helpful", "mcp");
      vote(theirs.id, v, "not_helpful", "mcp");
    }
    const { downvotedLive } = await import("../lib/swarm-gc");
    const { getDb } = await import("../lib/db");
    const all = downvotedLive(getDb());
    expect(all.map((m) => m.id).sort()).toEqual([mine.id, theirs.id].sort());
    expect(downvotedLive(getDb(), ME)).toEqual(all.filter((m) => m.author_id === ME));
    expect(downvotedLive(getDb(), "nobody@example.com")).toEqual([]);
  });
});
