import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { api, origin, uniqueActor } from "./helpers";

/**
 * The honour-system identity against the real server: an unknown caller
 * connects and gets a session id, every call but bab_identify says BAB does not know who it is,
 * bab_identify is remembered on the device or the connection, the person forgets the device on
 * /me/devices, and it is unknown again. No secret literal sits in this file: it is generated.
 */

async function mcp(method: string, params: unknown, headers: Record<string, string> = {}) {
  return api("/mcp", { method: "POST", headers, body: { jsonrpc: "2.0", id: 1, method, params } });
}
const callTool = (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
  mcp("tools/call", { name, arguments: args }, headers).then((r) => r.json());

const UNKNOWN = /^BAB does not know who you are yet\. Call bab_identify/;

function sso(actor: { email: string; name: string }): Record<string, string> {
  return {
    "x-auth-request-user": `e2e-${actor.email}`,
    "x-auth-request-email": actor.email,
    "x-auth-request-preferred-username": actor.name,
  };
}

describe("e2e: an unknown caller", () => {
  it("initializes (and is given an Mcp-Session-Id), lists tools, and is told to call bab_identify", async () => {
    const init = await mcp("initialize", { protocolVersion: "2025-06-18" });
    expect(init.status).toBe(200);
    expect(init.headers.get("Mcp-Session-Id")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await init.json()).result.instructions).toContain("bab_identify");

    const list = await (await mcp("tools/list", {})).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("bab_identify");

    const out = await callTool("bab_inbox", {});
    expect(out.result.isError).toBe(false);
    expect(out.result.content[0].text).toMatch(UNKNOWN);
    expect(out.result.content[0].text).not.toMatch(/https?:|\/connect\//);
  });

  it("is a plain 401 on /api, which has no bab_identify", async () => {
    expect((await api("/api/me")).status).toBe(401);
  });

  it("a /connect link someone still has says it is no longer needed", async () => {
    const res = await fetch(`${origin()}/connect/${"A".repeat(43)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("This link is no longer needed");
  });
});

describe("e2e: bab_identify is remembered on the device, then forgotten", () => {
  it("identify, act as the person, forget the device on /me/devices, unknown again, identify again", async () => {
    const person = uniqueActor("Devon Path");
    const device = { "X-Bab-Device": randomBytes(32).toString("hex"), "X-Bab-Device-Label": "E2E laptop" };

    // 1. Not known yet.
    expect((await callTool("bab_inbox", {}, device)).result.content[0].text).toMatch(UNKNOWN);

    // 2. Identify: remembered on the device.
    const identified = await callTool("bab_identify", { email: person.email, name: person.name }, device);
    expect(identified.result.isError).toBeFalsy();
    const body = JSON.parse(identified.result.content[0].text);
    expect(body.remembered).toBe("device");
    expect(body.identifiedAs.email).toBe(person.email);

    // 3. The device is the person, on /mcp and on /api, whatever the headers say.
    const served = await callTool("bab_inbox", {}, device);
    expect(served.result.isError).toBeFalsy();
    expect(served.result.content[0].text).not.toMatch(UNKNOWN);
    const me = await api("/api/me", { headers: device, actor: uniqueActor("Someone Else") });
    expect(me.status).toBe(200);
    expect(((await me.json()).actor.email ?? "") as string).toBe(person.email);

    // 4. The person forgets their devices (a form post from the app's own origin).
    const forget = await fetch(`${origin()}/me/devices/revoke`, {
      method: "POST",
      redirect: "manual",
      headers: { ...sso(person), Origin: origin(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "all=1",
    });
    expect(forget.status).toBe(303);

    // 5. Unknown again: no special refusal, the same answer as for a stranger.
    expect((await callTool("bab_inbox", {}, device)).result.content[0].text).toMatch(UNKNOWN);
    expect((await api("/api/me", { headers: device })).status).toBe(401);

    // 6. Identifying binds it again (the honour system).
    const again = await callTool("bab_identify", { email: person.email }, device);
    expect(JSON.parse(again.result.content[0].text).remembered).toBe("device");
    expect((await api("/api/me", { headers: device })).status).toBe(200);
  });

  it("another person can take the device over, and the old owner no longer sees it", async () => {
    const a = uniqueActor("Anna Owner");
    const b = uniqueActor("Boris Taker");
    const device = { "X-Bab-Device": randomBytes(32).toString("hex") };
    await callTool("bab_identify", { email: a.email }, device);
    await callTool("bab_identify", { email: b.email }, device);
    const me = await api("/api/me", { headers: device });
    expect(((await me.json()).actor.email ?? "") as string).toBe(b.email);
  });

  it("a refused address is a tool error and binds nothing", async () => {
    const device = { "X-Bab-Device": randomBytes(32).toString("hex") };
    const out = await callTool("bab_identify", { email: "aexample@example.com" }, device);
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toMatch(/first\.last@example.com/);
    expect((await api("/api/me", { headers: device })).status).toBe(401);
  });
});

describe("e2e: bab_identify is remembered on the connection when there is no device", () => {
  it("the session id from initialize carries the identity to the next calls, and only those", async () => {
    const person = uniqueActor("Conny Ection");
    const sessionId = (await mcp("initialize", {})).headers.get("Mcp-Session-Id")!;
    const sess = { "Mcp-Session-Id": sessionId };

    const identified = await callTool("bab_identify", { email: person.email }, sess);
    expect(JSON.parse(identified.result.content[0].text).remembered).toBe("connection");
    expect((await callTool("bab_inbox", {}, sess)).result.content[0].text).not.toMatch(UNKNOWN);
    expect((await api("/api/me", { headers: sess })).status).toBe(200);

    // Another connection, and no connection at all, are still strangers.
    const other = (await mcp("initialize", {})).headers.get("Mcp-Session-Id")!;
    expect((await callTool("bab_inbox", {}, { "Mcp-Session-Id": other })).result.content[0].text).toMatch(UNKNOWN);
    expect((await callTool("bab_inbox", {})).result.content[0].text).toMatch(UNKNOWN);
  });

  it("an unknown session id is tolerated: no 404, just no connection", async () => {
    const res = await mcp("tools/list", {}, { "Mcp-Session-Id": "u".repeat(43) });
    expect(res.status).toBe(200);
  });

  it("with neither, identify works for the one call and says so", async () => {
    const out = await callTool("bab_identify", { email: uniqueActor("Once Only").email });
    const body = JSON.parse(out.result.content[0].text);
    expect(body.remembered).toBe("none");
    expect(body.note).toMatch(/^BAB cannot remember you in this app/);
    expect(body.note).toContain("do not retry bab_identify in this session");
    expect(body.note).toContain("your work address");
  });
});

describe("e2e: header callers are unaffected", () => {
  it("valid X-Bab-Actor-* still works, on /api and /mcp, with no tip and no link", async () => {
    const actor = uniqueActor("Header Caller");
    expect((await api("/api/me", { actor })).status).toBe(200);
    const out = await api("/mcp", {
      method: "POST",
      actor,
      headers: { "X-Bab-Device": randomBytes(32).toString("hex") },
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bab_inbox", arguments: {} } },
    }).then((r) => r.json());
    expect(out.result.isError).toBeFalsy();
    expect(JSON.stringify(out)).not.toMatch(/Tip:|\/connect\/|does not know/);
  });
});

describe("e2e: the instructions fit under the 2048 character cut", () => {
  it("initialize answers instructions of at most 2000 characters that still hold the identify rule", async () => {
    const res = await mcp("initialize", {});
    const instructions: string = (await res.json()).result.instructions;
    expect(instructions.length).toBeLessThanOrEqual(2000);
    expect(instructions).toContain("call bab_identify with the user's own work email");
    expect(instructions.endsWith("/instructions/skill.md")).toBe(true);
  });
});

describe("e2e: GET and DELETE on /mcp (clients send them once a server issues session ids)", () => {
  // This transport has no server-initiated stream and no session to tear down, so the answer is a
  // plain 405 (the MCP spec allows it), never an HTML 404 page or a 500.
  const sessions: [string, Record<string, string>][] = [
    ["no session id", {}],
    ["an unknown session id", { "Mcp-Session-Id": "u".repeat(43) }],
    ["a garbage session id", { "Mcp-Session-Id": "garbage" }],
  ];

  it.each(["GET", "DELETE"])("%s answers a clean 405 with or without Mcp-Session-Id, and never HTML or a 500", async (method) => {
    for (const [label, headers] of sessions) {
      const res = await fetch(`${origin()}/mcp`, { method, headers: { Accept: "text/event-stream, application/json", ...headers } });
      expect(res.status, `${method} with ${label}`).toBe(405);
      expect(res.headers.get("content-type") ?? "", `${method} with ${label}`).not.toMatch(/text\/html/);
      expect((await res.text()).toLowerCase(), `${method} with ${label}`).not.toContain("<html");
    }
  });

  it("a real session id from initialize gets the same clean 405 on GET and DELETE", async () => {
    const id = (await mcp("initialize", {})).headers.get("Mcp-Session-Id")!;
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${origin()}/mcp`, { method, headers: { "Mcp-Session-Id": id } });
      expect(res.status).toBe(405);
    }
  });
});
