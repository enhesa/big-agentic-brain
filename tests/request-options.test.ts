import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Answer options on a question request: validation, who may answer, one replaceable answer per
 * recipient, group threads, the agent read shape (bab_inbox and the REST twin) and the answer form
 * on /inbox with its POST route.
 */

let dataDir: string;
let current: Record<string, string> = {};
const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";
const CARL = "carl.c@example.com";
const DANA = "dana.d@example.com";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-request-options-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  current = {};
  vi.resetModules();
  vi.doMock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost", ...current }) }));
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

function asViewer(email: string, name: string) {
  current = { "x-auth-request-user": `proxy-${email}`, "x-auth-request-email": email, "x-auth-request-preferred-username": name };
}
function asAgent(email: string, name: string) {
  current = { "x-bab-actor-email": email, "x-bab-actor-name": name };
}

async function seed() {
  const { upsertUser } = await import("../lib/users");
  for (const [id, name] of [[ALICE, "Alice A"], [BOB, "Bob B"], [CARL, "Carl C"], [DANA, "Dana D"]]) {
    upsertUser({ id, email: id, name, roles: [] });
  }
}

const OPTIONS = ["Ship it", "Wait a week", "Cancel"];
const QUESTION = { kind: "question", goal: "When should we release?", options: OPTIONS };

async function ask(to: string | string[] = BOB) {
  await seed();
  const { send } = await import("../lib/messages");
  return send({ fromId: ALICE, to, subject: "Release", body: "Pick one", request: QUESTION });
}

describe("request.options validation", () => {
  async function validate(request: unknown) {
    const { validateRequest } = await import("../lib/messages");
    return validateRequest(request);
  }
  const base = { kind: "question", goal: "Which?" };

  it("keeps trimmed options, in order", async () => {
    expect((await validate({ ...base, options: [" Yes ", "No"] })).options).toEqual(["Yes", "No"]);
  });

  it("allows options on any kind and leaves them out when absent", async () => {
    expect((await validate({ kind: "review-pr", goal: "Look", options: ["Approve", "Reject"] })).options).toEqual(["Approve", "Reject"]);
    expect("options" in (await validate(base))).toBe(false);
  });

  it("refuses a non-array, too few, too many and bad entries with a ValidationError", async () => {
    const { ValidationError } = await import("../lib/errors");
    const bad: unknown[] = [
      "Yes",
      ["Only one"],
      [],
      ["1", "2", "3", "4", "5", "6", "7"],
      ["Yes", 3],
      ["Yes", "   "],
      ["Yes", "x".repeat(61)],
      ["Yes", "yes"],
      ["Same", "Same"],
    ];
    for (const options of bad) {
      await expect(validate({ ...base, options })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("accepts 6 options and 60 characters", async () => {
    expect((await validate({ ...base, options: ["a", "b", "c", "d", "e", "x".repeat(60)] })).options).toHaveLength(6);
  });

  it("refuses an option that redaction would change instead of altering it", async () => {
    const { ValidationError } = await import("../lib/errors");
    const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
    await expect(validate({ ...base, options: ["Yes", secret] })).rejects.toBeInstanceOf(ValidationError);
  });

  it("never takes answers from the sender", async () => {
    const out = await validate({ ...base, options: ["Yes", "No"], answers: [{ by: BOB, option: "Yes", at: "2026-01-01 00:00:00" }] });
    expect(out.answers).toBeUndefined();
  });

  it("is refused through bab_send as an error result, not a protocol error", async () => {
    await seed();
    asAgent(ALICE, "Alice A");
    const { TOOLS } = await import("../lib/mcp");
    const send = TOOLS.find((t) => t.name === "bab_send")!;
    const { ValidationError } = await import("../lib/errors");
    expect(() =>
      send.run({ id: ALICE, name: "Alice A", email: ALICE, source: "declared" } as never, { to: BOB, body: "x", request: { ...QUESTION, options: ["one"] } }),
    ).toThrow(ValidationError);
    expect(TOOLS).toHaveLength(13);
  });
});

describe("answerRequest", () => {
  it("stores a recipient's pick with a note and the time", async () => {
    const sent = await ask();
    const { answerRequest, thread } = await import("../lib/messages");
    const out = answerRequest(sent.message.id, BOB, { option: "1", note: "  after the freeze  " });
    expect(out.answer).toMatchObject({ by: BOB, option: "Wait a week", note: "after the freeze" });
    expect(out.answer.at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(out.changed).toBe(false);
    const stored = thread(sent.thread.id, ALICE)!.messages[0].request!;
    expect(stored.answers).toEqual([out.answer]);
    expect(stored.options).toEqual(OPTIONS);
  });

  it("takes the option as a number or a numeric string, and refuses anything else", async () => {
    const sent = await ask();
    const { answerRequest } = await import("../lib/messages");
    const { ValidationError } = await import("../lib/errors");
    expect(answerRequest(sent.message.id, BOB, { option: 0 }).answer.option).toBe("Ship it");
    for (const option of [undefined, "", "x", -1, 3, 1.5, "03", "Ship it", null]) {
      expect(() => answerRequest(sent.message.id, BOB, { option }), String(option)).toThrow(ValidationError);
    }
  });

  it("redacts the note and refuses a long or non-string one", async () => {
    const sent = await ask();
    const { answerRequest } = await import("../lib/messages");
    const { ValidationError } = await import("../lib/errors");
    const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
    const out = answerRequest(sent.message.id, BOB, { option: 0, note: `key ${secret}` });
    expect(out.answer.note).not.toContain(secret);
    expect(() => answerRequest(sent.message.id, BOB, { option: 0, note: "x".repeat(301) })).toThrow(ValidationError);
    expect(() => answerRequest(sent.message.id, BOB, { option: 0, note: 5 })).toThrow(ValidationError);
    // An empty note is no note.
    expect(answerRequest(sent.message.id, BOB, { option: 0, note: "  " }).answer.note).toBeUndefined();
  });

  it("is for recipients only: not the sender, not a participant outside the message, not a stranger", async () => {
    const sent = await ask();
    const { answerRequest } = await import("../lib/messages");
    const { ForbiddenError, NotFoundError } = await import("../lib/errors");
    expect(() => answerRequest(sent.message.id, ALICE, { option: 0 })).toThrow(ForbiddenError);
    expect(() => answerRequest(sent.message.id, CARL, { option: 0 })).toThrow(ForbiddenError);
    expect(() => answerRequest("00000000-0000-4000-8000-000000000000", BOB, { option: 0 })).toThrow(NotFoundError);
  });

  it("refuses a note to self: the sender cannot answer their own question even as a recipient", async () => {
    await seed();
    const { send, answerRequest } = await import("../lib/messages");
    const { ForbiddenError } = await import("../lib/errors");
    const own = send({ fromId: ALICE, to: ALICE, subject: "Me", body: "x", request: QUESTION });
    expect(() => answerRequest(own.message.id, ALICE, { option: 0 })).toThrow(ForbiddenError);
  });

  it("refuses a message that has no options", async () => {
    await seed();
    const { send, answerRequest } = await import("../lib/messages");
    const { ValidationError } = await import("../lib/errors");
    const plain = send({ fromId: ALICE, to: BOB, subject: "Plain", body: "x" });
    const noOptions = send({ fromId: ALICE, to: BOB, subject: "Req", body: "x", request: { kind: "question", goal: "Why?" } });
    expect(() => answerRequest(plain.message.id, BOB, { option: 0 })).toThrow(ValidationError);
    expect(() => answerRequest(noOptions.message.id, BOB, { option: 0 })).toThrow(ValidationError);
  });

  it("replaces an earlier answer from the same person and takes the new time", async () => {
    const sent = await ask();
    const { answerRequest, thread } = await import("../lib/messages");
    const { getDb } = await import("../lib/db");
    answerRequest(sent.message.id, BOB, { option: 0, note: "first" });
    const old = "2020-01-01 00:00:00";
    const row = getDb().prepare("SELECT request FROM messages WHERE id = ?").get(sent.message.id) as { request: string };
    const parsed = JSON.parse(row.request);
    parsed.answers[0].at = old;
    getDb().prepare("UPDATE messages SET request = ? WHERE id = ?").run(JSON.stringify(parsed), sent.message.id);

    const again = answerRequest(sent.message.id, BOB, { option: 2 });
    expect(again.changed).toBe(true);
    const answers = thread(sent.thread.id, BOB)!.messages[0].request!.answers!;
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ by: BOB, option: "Cancel" });
    expect(answers[0].note).toBeUndefined();
    expect(answers[0].at > old).toBe(true);
  });

  it("lets each recipient of a group thread answer for themselves", async () => {
    const sent = await ask([BOB, CARL, DANA]);
    const { answerRequest, thread } = await import("../lib/messages");
    answerRequest(sent.message.id, BOB, { option: 0 });
    answerRequest(sent.message.id, CARL, { option: 1 });
    answerRequest(sent.message.id, BOB, { option: 2 });
    const answers = thread(sent.thread.id, ALICE)!.messages[0].request!.answers!;
    expect(answers.map((a) => [a.by, a.option]).sort()).toEqual([[BOB, "Cancel"], [CARL, "Wait a week"]]);
    // Dana has not answered, and every participant sees the same picks.
    expect(thread(sent.thread.id, DANA)!.messages[0].request!.answers).toHaveLength(2);
  });

  it("tells the sender like a reply: an unread message in the thread, and a live event", async () => {
    const sent = await ask();
    const { answerRequest, thread, unreadCountFor } = await import("../lib/messages");
    expect(unreadCountFor(ALICE)).toBe(0);
    answerRequest(sent.message.id, BOB, { option: 1, note: "soon" });
    expect(unreadCountFor(ALICE)).toBe(1);
    let messages = thread(sent.thread.id, ALICE)!.messages;
    expect(messages.at(-1)).toMatchObject({ from_id: BOB, body: "Answer: Wait a week (soon)" });
    answerRequest(sent.message.id, BOB, { option: 0 });
    messages = thread(sent.thread.id, ALICE)!.messages;
    expect(messages.at(-1)!.body).toBe("Changed my answer: Ship it");
  });

  it("writes an audit row for the answer", async () => {
    const sent = await ask();
    const { answerRequest } = await import("../lib/messages");
    const { getDb } = await import("../lib/db");
    answerRequest(sent.message.id, BOB, { option: 0 });
    const row = getDb().prepare("SELECT actor_id, details FROM audit_log WHERE action = 'answer'").get() as { actor_id: string; details: string };
    expect(row.actor_id).toBe(BOB);
    expect(JSON.parse(row.details)).toEqual({ option: 0, replaced: false });
  });
});

describe("what the sender's agent reads", () => {
  it("shows options, answers, who and when in bab_inbox, in the listing and when a thread is opened", async () => {
    const sent = await ask();
    const { answerRequest } = await import("../lib/messages");
    const { TOOLS } = await import("../lib/mcp");
    const inbox = TOOLS.find((t) => t.name === "bab_inbox")!;
    const alice = { id: ALICE, name: "Alice A", email: ALICE, source: "declared" } as never;

    answerRequest(sent.message.id, BOB, { option: 1, note: "next week" });
    const opened = JSON.parse(await inbox.run(alice, { threadId: sent.thread.id }));
    const request = opened.messages[0].request;
    expect(request.options).toEqual(OPTIONS);
    expect(request.answers).toEqual([{ by: BOB, option: "Wait a week", note: "next week", at: expect.any(String) }]);

    // The listing carries the last message: the answer's reply, readable on its own.
    const listing = JSON.parse(await inbox.run(alice, { includeRead: true }));
    expect(listing.threads[0].lastMessage.body).toBe("Answer: Wait a week (next week)");
  });

  it("returns the same shape from GET /api/inbox/[threadId]", async () => {
    const sent = await ask();
    const { answerRequest } = await import("../lib/messages");
    answerRequest(sent.message.id, BOB, { option: 0 });
    asAgent(ALICE, "Alice A");
    const { GET } = await import("../app/api/inbox/[threadId]/route");
    const res = await GET(new Request("http://localhost/api/inbox/x") as never, { params: Promise.resolve({ threadId: sent.thread.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages[0].request.options).toEqual(OPTIONS);
    expect(body.messages[0].request.answers).toEqual([{ by: BOB, option: "Ship it", at: expect.any(String) }]);
  });

  it("POST /api/messages accepts options and refuses a bad list with 400", async () => {
    await seed();
    asAgent(ALICE, "Alice A");
    const { POST } = await import("../app/api/messages/route");
    const post = (request: unknown) =>
      POST(
        new Request("http://localhost/api/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: BOB, subject: "Q", body: "x", request }),
        }) as never,
      );
    const ok = await post(QUESTION);
    expect(ok.status).toBe(201);
    expect((await ok.json()).message.request.options).toEqual(OPTIONS);
    expect((await post({ ...QUESTION, options: ["one"] })).status).toBe(400);
  });
});

describe("the answer form on /inbox", () => {
  async function render(thread: string, extra: Record<string, string> = {}) {
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: InboxPage } = await import("../app/inbox/page");
    const element = await InboxPage({ searchParams: Promise.resolve({ thread, ...extra }) });
    return new Response(await renderToReadableStream(element as never)).text();
  }
  function form(fields: Record<string, string>, opts: { json?: boolean; origin?: string | null } = {}) {
    const headers: Record<string, string> = {
      host: "localhost",
      "content-type": opts.json ? "application/json" : "application/x-www-form-urlencoded",
    };
    if (opts.origin !== null) headers.origin = opts.origin ?? "http://localhost";
    return new Request("http://localhost/inbox/answer", {
      method: "POST",
      headers,
      body: opts.json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    });
  }

  it("shows the recipient a radio per option and a note box, posting to /inbox/answer", async () => {
    const sent = await ask();
    asViewer(BOB, "Bob B");
    const html = await render(sent.thread.id);
    expect(html).toContain('action="/inbox/answer"');
    expect(html).toContain('method="post"');
    expect(html).toContain(`name="messageId" value="${sent.message.id}"`);
    for (const [i, option] of OPTIONS.entries()) {
      expect(html).toContain(`name="option" value="${i}"`);
      expect(html).toContain(option);
    }
    expect(html).toContain('name="note"');
    expect(html).toContain("No answer yet.");
    expect(html).toContain("Send answer");
  });

  it("does not show the sender a form, but shows them the answers", async () => {
    const sent = await ask();
    const { answerRequest } = await import("../lib/messages");
    answerRequest(sent.message.id, BOB, { option: 2, note: "too risky" });
    asViewer(ALICE, "Alice A");
    const html = await render(sent.thread.id);
    expect(html).not.toContain("data-answer-form");
    expect(html).not.toContain('action="/inbox/answer"');
    expect(html).toContain("Bob B");
    expect(html).toContain("Cancel");
    expect(html).toContain("too risky");
  });

  it("preselects the viewer's own answer and offers to change it", async () => {
    const sent = await ask();
    const { answerRequest } = await import("../lib/messages");
    answerRequest(sent.message.id, BOB, { option: 1, note: "later" });
    asViewer(BOB, "Bob B");
    const html = await render(sent.thread.id);
    expect(html).toContain("Change your answer");
    expect(html).toContain("Change answer");
    expect(html).toMatch(/checked=""[^>]*value="1"/);
    expect(html).toContain('value="later"');
  });

  it("renders option and note text as inert text", async () => {
    await seed();
    const { send, answerRequest } = await import("../lib/messages");
    const sent = send({ fromId: ALICE, to: BOB, subject: "X", body: "x", request: { kind: "question", goal: "g", options: ["<b>bold</b>", "<img src=x>"] } });
    answerRequest(sent.message.id, BOB, { option: 0, note: "<script>alert(1)</script>" });
    asViewer(BOB, "Bob B");
    const html = await render(sent.thread.id);
    expect(html).not.toContain("<b>bold</b>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("shows a fixed line for a known ?answered= code and nothing for an unknown one", async () => {
    const sent = await ask();
    asViewer(BOB, "Bob B");
    expect(await render(sent.thread.id, { answered: "saved" })).toContain("Thanks, your answer is sent.");
    const odd = await render(sent.thread.id, { answered: "<b>x</b>" });
    expect(odd).not.toContain("data-answered");
  });

  it("POST saves the answer and answers 303 back to the thread", async () => {
    const sent = await ask();
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/answer/route");
    const res = await POST(form({ messageId: sent.message.id, option: "1", note: "ok" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`http://localhost/inbox?thread=${sent.thread.id}&answered=saved#m-${sent.message.id}`);
    const { thread } = await import("../lib/messages");
    expect(thread(sent.thread.id, ALICE)!.messages[0].request!.answers![0]).toMatchObject({ by: BOB, option: "Wait a week", note: "ok" });

    const again = await POST(form({ messageId: sent.message.id, option: "0" }));
    expect(again.headers.get("location")).toContain("answered=changed");
  });

  it("POST refuses a cross-site post, a missing identity and an agent header", async () => {
    const sent = await ask();
    const { POST } = await import("../app/inbox/answer/route");
    asViewer(BOB, "Bob B");
    expect((await POST(form({ messageId: sent.message.id, option: "0" }, { origin: "https://evil.example.com" }))).status).toBe(403);
    expect((await POST(form({ messageId: sent.message.id, option: "0" }, { origin: null }))).status).toBe(403);
    current = {};
    expect((await POST(form({ messageId: sent.message.id, option: "0" }))).headers.get("location")).toBe("http://localhost/inbox?answered=link");
    expect((await POST(form({ messageId: sent.message.id, option: "0" }, { json: true }))).status).toBe(401);
    asAgent(BOB, "Bob B");
    expect((await POST(form({ messageId: sent.message.id, option: "0" }, { json: true }))).status).toBe(401);
    const { thread } = await import("../lib/messages");
    expect(thread(sent.thread.id, ALICE)!.messages[0].request!.answers).toBeUndefined();
  });

  it("POST by the sender or a non-participant changes nothing and leaks nothing", async () => {
    const sent = await ask();
    const { POST } = await import("../app/inbox/answer/route");
    asViewer(ALICE, "Alice A");
    const own = await POST(form({ messageId: sent.message.id, option: "0" }));
    expect(own.headers.get("location")).toContain("answered=not-yours");
    asViewer(CARL, "Carl C");
    const stranger = await POST(form({ messageId: sent.message.id, option: "0" }));
    expect(stranger.headers.get("location")).toBe("http://localhost/inbox?answered=gone");
    expect((await POST(form({ messageId: sent.message.id, option: "0" }, { json: true }))).status).toBe(404);
    const { thread } = await import("../lib/messages");
    expect(thread(sent.thread.id, ALICE)!.messages[0].request!.answers).toBeUndefined();
  });

  it("POST with a bad option, a bad id or a long note redirects with a fixed code, JSON gets 400", async () => {
    const sent = await ask();
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/answer/route");
    expect((await POST(form({ messageId: sent.message.id, option: "9" }))).headers.get("location")).toContain("answered=invalid");
    expect((await POST(form({ messageId: sent.message.id }))).headers.get("location")).toContain("answered=invalid");
    expect((await POST(form({ messageId: sent.message.id, option: "0", note: "x".repeat(301) }))).headers.get("location")).toContain("answered=long");
    expect((await POST(form({ messageId: "not-an-id", option: "0" }))).headers.get("location")).toBe("http://localhost/inbox?answered=gone");
    expect((await POST(form({ messageId: sent.message.id, option: "9" }, { json: true }))).status).toBe(400);
  });

  it("POST answers JSON callers with the stored answer", async () => {
    const sent = await ask();
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/answer/route");
    const res = await POST(form({ messageId: sent.message.id, option: "2" }, { json: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: false, answer: { by: BOB, option: "Cancel" } });
  });

  it("POST is rate limited per person", async () => {
    const sent = await ask();
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/answer/route");
    const { UI_RATE_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
    let last = 0;
    for (let i = 0; i <= UI_RATE_LIMIT_PER_MINUTE; i++) {
      last = (await POST(form({ messageId: sent.message.id, option: "0" }, { json: true }))).status;
    }
    expect(last).toBe(429);
  });
});

describe("answer follow-ups", () => {
  it("treats an identical re-pick as a no-op: no write, no reply, the old time stays", async () => {
    const sent = await ask();
    const { answerRequest, thread } = await import("../lib/messages");
    const { getDb } = await import("../lib/db");
    const first = answerRequest(sent.message.id, BOB, { option: 1, note: "soon" });
    const row = getDb().prepare("SELECT request FROM messages WHERE id = ?").get(sent.message.id) as { request: string };
    const parsed = JSON.parse(row.request);
    parsed.answers[0].at = "2020-01-01 00:00:00";
    getDb().prepare("UPDATE messages SET request = ? WHERE id = ?").run(JSON.stringify(parsed), sent.message.id);
    const before = thread(sent.thread.id, ALICE)!.messages.length;

    const again = answerRequest(sent.message.id, BOB, { option: "1", note: " soon " });
    expect(first.unchanged).toBe(false);
    expect(again).toMatchObject({ unchanged: true, changed: false, replied: false });
    expect(thread(sent.thread.id, ALICE)!.messages).toHaveLength(before);
    expect(thread(sent.thread.id, ALICE)!.messages[0].request!.answers![0].at).toBe("2020-01-01 00:00:00");
    // A different note is a change.
    expect(answerRequest(sent.message.id, BOB, { option: 1, note: "later" })).toMatchObject({ unchanged: false, changed: true });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'answer'").get()).toEqual({ n: 2 });
  });

  it("the route redirects an identical re-pick with the unchanged code and shows its banner", async () => {
    const sent = await ask();
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/answer/route");
    const body = (o: string) =>
      new Request("http://localhost/inbox/answer", {
        method: "POST",
        headers: { host: "localhost", origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ messageId: sent.message.id, option: o }).toString(),
      });
    await POST(body("0"));
    const res = await POST(body("0"));
    expect(res.headers.get("location")).toContain("answered=unchanged");
    const { answerMessage } = await import("../lib/inbox-answer-web");
    expect(answerMessage("unchanged")?.text).toContain("Nothing changed");
  });

  it("the form says the answer sends a reply", async () => {
    const sent = await ask();
    asViewer(BOB, "Bob B");
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: InboxPage } = await import("../app/inbox/page");
    const html = await new Response(
      await renderToReadableStream((await InboxPage({ searchParams: Promise.resolve({ thread: sent.thread.id }) })) as never),
    ).text();
    expect(html).toContain("Sends a short reply to everyone else in this thread.");
  });

  it("the reply reaches the sender only in a 1:1 thread and every other participant in a group", async () => {
    const one = await ask(BOB);
    const { answerRequest, thread, unreadCountFor } = await import("../lib/messages");
    answerRequest(one.message.id, BOB, { option: 0 });
    expect(unreadCountFor(ALICE)).toBe(1);
    expect(thread(one.thread.id, ALICE)!.messages.at(-1)!.recipients.map((r) => r.id)).toEqual([ALICE]);

    const { send } = await import("../lib/messages");
    const group = send({ fromId: ALICE, to: [BOB, CARL, DANA], subject: "Group", body: "Pick", request: QUESTION });
    answerRequest(group.message.id, BOB, { option: 1 });
    const reply = thread(group.thread.id, ALICE)!.messages.at(-1)!;
    expect(reply.from_id).toBe(BOB);
    expect(reply.recipients.map((r) => r.id).sort()).toEqual([ALICE, CARL, DANA]);
  });

  it("keeps the stored answer and reports success when the reply cannot be sent", async () => {
    const sent = await ask();
    const { getDb } = await import("../lib/db");
    getDb().exec(
      "CREATE TRIGGER no_reply BEFORE INSERT ON messages WHEN NEW.body LIKE 'Answer:%' BEGIN SELECT RAISE(ABORT, 'forced'); END",
    );
    const { answerRequest, thread } = await import("../lib/messages");
    const out = answerRequest(sent.message.id, BOB, { option: 2 });
    expect(out).toMatchObject({ replied: false, unchanged: false });
    expect(thread(sent.thread.id, ALICE)!.messages[0].request!.answers![0].option).toBe("Cancel");
    expect(thread(sent.thread.id, ALICE)!.messages).toHaveLength(1);
  });

  it("refuses a long note with its own error type, which the route maps without reading the text", async () => {
    const sent = await ask();
    const { answerRequest, AnswerNoteTooLongError } = await import("../lib/messages");
    const { ValidationError } = await import("../lib/errors");
    const { answerRefusalCode } = await import("../lib/inbox-answer-web");
    let caught: unknown;
    try {
      answerRequest(sent.message.id, BOB, { option: 0, note: "x".repeat(301) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AnswerNoteTooLongError);
    expect(caught).toBeInstanceOf(ValidationError);
    expect(answerRefusalCode(caught)).toBe("long");
    expect(answerRefusalCode(new ValidationError("something characters or fewer"))).toBe("invalid");
  });

  it("drops answers a sender supplies, through bab_send and POST /api/messages", async () => {
    await seed();
    asAgent(ALICE, "Alice A");
    const forged = [{ by: BOB, option: "Ship it", at: "2026-01-01 00:00:00" }];
    const { TOOLS } = await import("../lib/mcp");
    const sendTool = TOOLS.find((t) => t.name === "bab_send")!;
    const viaMcp = JSON.parse(
      await sendTool.run({ id: ALICE, name: "Alice A", email: ALICE, source: "declared" } as never, {
        to: BOB,
        body: "x",
        subject: "S",
        request: { ...QUESTION, answers: forged },
      }),
    );
    expect(viaMcp.message.request.options).toEqual(OPTIONS);
    expect(viaMcp.message.request.answers).toBeUndefined();

    const { POST } = await import("../app/api/messages/route");
    const res = await POST(
      new Request("http://localhost/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: BOB, subject: "S2", body: "x", request: { ...QUESTION, answers: forged } }),
      }) as never,
    );
    expect(res.status).toBe(201);
    expect((await res.json()).message.request.answers).toBeUndefined();
    const { getDb } = await import("../lib/db");
    const rows = getDb().prepare("SELECT request FROM messages").all() as { request: string }[];
    expect(rows.every((r) => !r.request.includes('"answers"'))).toBe(true);
  });
});
