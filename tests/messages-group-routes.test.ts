import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Group messages through every way in and out: POST /api/messages, GET /api/inbox/[id], the
 * bab_send and bab_inbox MCP tools, the hook digest, the Inbox page stream filter and its list.
 */

process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

let dataDir: string;
/** Who the mocked proxy headers say is calling. A variable, so a route module already loaded follows it. */
let caller = "";
const A = "alice.a@example.com";
const B = "bob.b@example.com";
const C = "carol.c@example.com";
const D = "dave.d@example.com";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-messages-group-routes-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": caller, "x-bab-actor-name": caller.split(".")[0] }),
  }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

function as(email: string) {
  caller = email;
}

async function seed() {
  const { upsertUser } = await import("../lib/users");
  for (const id of [A, B, C, D]) upsertUser({ id, email: id, name: id.split(".")[0], roles: [] });
}

async function postMessage(email: string, payload: unknown): Promise<Response> {
  as(email);
  const { POST } = await import("../app/api/messages/route");
  return POST(
    new Request("https://bab.example.com/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }) as never,
  );
}

async function mcp(email: string, name: string, args: Record<string, unknown>) {
  as(email);
  const { POST } = await import("../app/mcp/route");
  const res = await POST(
    new Request("https://bab.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Bab-Actor-Email": email, "X-Bab-Actor-Name": "x" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const json = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { isError: json.result.isError === true, text: json.result.content[0].text };
}

describe("POST /api/messages", () => {
  it("takes a list in `to` and answers with every recipient", async () => {
    await seed();
    const res = await postMessage(A, { to: [B, C], subject: "Plan", body: "Thoughts?" });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.recipients.map((r: { id: string }) => r.id)).toEqual([B, C]);
    expect(json.message.to_id).toBe(B);
  });

  it("keeps a string `to` exactly as before", async () => {
    await seed();
    const res = await postMessage(A, { to: B, subject: "Plan", body: "Thoughts?" });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.message.to_id).toBe(B);
    expect(json.delivery.note).toMatch(/their BAB inbox\./);
  });

  it("answers 400 for a bad `to`", async () => {
    await seed();
    expect((await postMessage(A, { to: 7, body: "x" })).status).toBe(400);
    const empty = await postMessage(A, { to: [], body: "x" });
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toMatch(/at least one recipient/);
    const unknown = await postMessage(A, { to: [B, "nobody.x@example.com"], body: "x" });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain("nobody.x@example.com");
  });
});

describe("GET /api/inbox/[threadId]", () => {
  it("lists every participant and each message's recipients, and refuses an outsider", async () => {
    await seed();
    const { send } = await import("../lib/messages");
    const sent = send({ fromId: A, to: [B, C], subject: "x", body: "y" });

    as(C);
    const { GET } = await import("../app/api/inbox/[threadId]/route");
    const res = await GET(new Request("https://bab.example.com/x") as never, { params: Promise.resolve({ threadId: sent.thread.id }) });
    const json = await res.json();
    expect(json.participants.map((p: { id: string }) => p.id)).toEqual([A, B, C]);
    expect(json.messages[0].recipients.map((r: { id: string }) => r.id)).toEqual([B, C]);
    expect(json.messages[0].read_at).not.toBeNull();

    as(D);
    const denied = await GET(new Request("https://bab.example.com/x") as never, { params: Promise.resolve({ threadId: sent.thread.id }) });
    expect(denied.status).toBe(403);
  });
});

describe("MCP", () => {
  it("bab_send takes a list, and its schema accepts a string or a list", async () => {
    await seed();
    const sent = await mcp(A, "bab_send", { to: [B, C], subject: "x", body: "y" });
    expect(sent.isError).toBe(false);
    expect(JSON.parse(sent.text).recipients).toHaveLength(2);

    const { TOOLS } = await import("../lib/mcp");
    const tool = TOOLS.find((t) => t.name === "bab_send");
    const to = (tool?.inputSchema.properties as Record<string, { anyOf?: { type: string }[] }>).to;
    expect(to.anyOf?.map((s) => s.type)).toEqual(["string", "array"]);
  });

  it("bab_send refuses an unknown address in a list as a tool error", async () => {
    await seed();
    const sent = await mcp(A, "bab_send", { to: [B, "nobody.x@example.com"], body: "y" });
    expect(sent.isError).toBe(true);
    expect(sent.text).toContain("Nothing was sent");
  });

  it("bab_inbox lists participants and opens a group thread with them", async () => {
    await seed();
    const { send } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "y" });
    const list = JSON.parse((await mcp(B, "bab_inbox", {})).text);
    expect(list.threads[0].participants.map((p: { id: string }) => p.id)).toEqual([A, B, C]);
    const opened = JSON.parse((await mcp(B, "bab_inbox", { threadId: first.thread.id })).text);
    expect(opened.participants.map((p: { id: string }) => p.id)).toEqual([A, B, C]);
    expect(opened.messages[0].recipients.map((r: { id: string }) => r.id)).toEqual([B, C]);
  });

  it("a reply over MCP with no `to` reaches everyone", async () => {
    await seed();
    const { send, unreadCountFor } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "y" });
    const reply = await mcp(B, "bab_send", { threadId: first.thread.id, body: "agreed" });
    expect(reply.isError).toBe(false);
    expect(unreadCountFor(A)).toBe(1);
    expect(unreadCountFor(C)).toBe(2);
  });
});

describe("hook digest", () => {
  it("counts a group message for every recipient's session", async () => {
    await seed();
    const { linkSession } = await import("../lib/sessions");
    linkSession(B, "bob-session");
    linkSession(C, "carol-session");
    const { send } = await import("../lib/messages");
    send({ fromId: A, to: [B, C], subject: "x", body: "y" });

    const { POST } = await import("../app/api/hook/route");
    const hook = async (session: string) => {
      const res = await POST(
        new Request("https://bab.example.com/api/hook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session }),
        }),
      );
      return JSON.stringify(await res.json());
    };
    expect(await hook("bob-session")).toContain("1 unread message");
    expect(await hook("carol-session")).toContain("1 unread message");
  });
});

describe("Inbox page", () => {
  it("streams a group message to every recipient and to no one else", async () => {
    await seed();
    const { send, markRead } = await import("../lib/messages");
    const { eventConcernsViewer } = await import("../lib/inbox-page");
    const sent = send({ fromId: A, to: [B, C], subject: "x", body: "y" });
    const event = { type: "message.created", payload: { id: sent.message.id, kind: "human" } } as never;
    for (const who of [A, B, C]) expect(eventConcernsViewer(event, who)).toEqual({ threadId: sent.thread.id, kind: "message" });
    expect(eventConcernsViewer(event, D)).toBeNull();
    markRead(sent.thread.id, C);
    const read = { type: "message.created", payload: { id: sent.thread.id, kind: "read" } } as never;
    expect(eventConcernsViewer(read, B)).toEqual({ threadId: sent.thread.id, kind: "read" });
    expect(eventConcernsViewer(read, D)).toBeNull();
  });

  it("names a group thread after everyone else", async () => {
    await seed();
    const { send } = await import("../lib/messages");
    const { inboxSummary, groupLabel } = await import("../lib/inbox-page");
    send({ fromId: A, to: [B, C, D], subject: "x", body: "y" });
    const { getUsersByIds } = await import("../lib/users");
    const names = getUsersByIds([A, C]);
    expect(inboxSummary(B).threads[0].otherName).toBe(`${names.get(A)?.name}, ${names.get(C)?.name} +1`);
    expect(groupLabel(["x", "y"])).toBe("x, y");
  });
});
