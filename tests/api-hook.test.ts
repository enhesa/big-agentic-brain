import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * GET /api/hook is the whole delivery mechanism now: the SessionStart and
 * UserPromptSubmit hooks are a bare `curl` at this route, so whatever it returns is
 * the only thing a colleague's session ever learns about waiting messages. Everything
 * the old hook.mjs decided locally, the server decides here.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-hook-test-"));
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

function mockIdentity(email: string, name: string) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": email, "x-bab-actor-name": name }),
  }));
}

function mockNoIdentity() {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
}

const req = (query = "") => new Request(`https://bab.example.com/api/hook${query}`);

async function call(query = "") {
  const { GET } = await import("../app/api/hook/route");
  return GET(req(query) as never);
}

async function seedUnread() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice.a@example.com", email: "alice.a@example.com", name: "Alice", roles: [] });
  upsertUser({ id: "bob.b@example.com", email: "bob.b@example.com", name: "Bob", roles: [] });
  const { send } = await import("../lib/messages");
  return send({
    fromId: "alice.a@example.com",
    to: "bob.b@example.com",
    subject: "Kafka",
    body: "What is our max message size?",
  });
}

describe("GET /api/hook", () => {
  it("carries the public origin, so a client can build links without a host of its own", async () => {
    await seedUnread();
    mockIdentity("bob.b@example.com", "Bob");
    const body = await (await call()).json();
    expect(body.origin).toBe("https://bab.example.com");
  });

  it("returns the documented hook envelope, not bare text", async () => {
    await seedUnread();
    mockIdentity("bob.b@example.com", "Bob");
    const body = await (await call()).json();
    expect(body.hookSpecificOutput.hookEventName).toBeTruthy();
    expect(typeof body.hookSpecificOutput.additionalContext).toBe("string");
  });

  // Claude Code rejects an envelope whose hookEventName is not the event that fired:
  // "Hook returned incorrect event name: expected 'UserPromptSubmit' but got
  // 'SessionStart'", on every single prompt. A bare curl cannot read the event off
  // stdin, so the caller names it in the query string and we echo it back.
  it("names the event the caller says fired", async () => {
    mockIdentity("alice.a@example.com", "Alice");
    const body = await (await call("?event=UserPromptSubmit")).json();
    expect(body.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  it("still says SessionStart when nobody asked for an event", async () => {
    mockIdentity("alice.a@example.com", "Alice");
    const body = await (await call()).json();
    expect(body.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  // Echoing an arbitrary string back would let a typo produce the very error this
  // fixes, and put unvalidated input in the envelope. Only the two events this route
  // is installed on are accepted; anything else falls back to today's behaviour.
  it("falls back to SessionStart for an event it does not serve", async () => {
    mockIdentity("alice.a@example.com", "Alice");
    for (const q of ["?event=PreToolUse", "?event=nonsense", "?event="]) {
      const body = await (await call(q)).json();
      expect(body.hookSpecificOutput.hookEventName).toBe("SessionStart");
    }
  });

  // This route trusts a self-asserted header, so anyone who types a colleague email
  // would read their mail. It now says how many, never who or what.
  it("tells the recipient how many are unread, with no sender and no body", async () => {
    await seedUnread();
    mockIdentity("bob.b@example.com", "Bob");
    const text = (await (await call()).json()).hookSpecificOutput.additionalContext;
    expect(text).toContain("1 unread message");
    expect(text).not.toContain("alice.a@example.com");
    expect(text).not.toContain("What is our max message size?");
  });

  it("says nothing about messages to someone with none", async () => {
    await seedUnread();
    mockIdentity("alice.a@example.com", "Alice");
    const text = (await (await call()).json()).hookSpecificOutput.additionalContext;
    expect(text).not.toContain("unread message");
  });

  it("always carries the version, so the agent can compare it to its own", async () => {
    mockIdentity("alice.a@example.com", "Alice");
    const { getInstructions } = await import("../lib/instructions");
    const { version } = getInstructions("https://bab.example.com");
    const text = (await (await call()).json()).hookSpecificOutput.additionalContext;
    expect(text).toContain(version);
    expect(text).toContain("Install guide: https://bab.example.com/instructions/install.md");
    expect(text).not.toContain("Steps:");
    // What the legacy install left behind, named in the hook itself since install.md no longer lists it.
    expect(text).toContain("permissions.ask");
    expect(text).toContain("~/.claude/skills/big-agentic-brain");
  });

  // A hook that 401s would make Claude Code report an error on every prompt for anyone
  // who has not finished installing. Staying quiet is the only acceptable behaviour.
  it("stays quiet instead of erroring when there is no identity", async () => {
    mockNoIdentity();
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});
