import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * /command-center and its viewer routes: the signed-in viewer only, agent text as inert React
 * text, the switch flippable only from the page, and the served command-center skill.
 */

let dataDir: string;
const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";
const ORIGIN = "http://localhost:4310";
const NOW = Date.parse("2026-03-02T10:00:00Z");
const DAY = 86_400_000;
let current: Record<string, string> = {};

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-cc-page-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  current = {};
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.doMock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:4310", ...current }) }));
  (await import("../lib/command-center"))._resetCommandCenterForTests();
  (await import("../lib/rate-limit")).resetForTests();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ALICE, email: ALICE, name: "Alice A", roles: [] });
  upsertUser({ id: BOB, email: BOB, name: "Bob B", roles: [] });
});

afterEach(async () => {
  vi.useRealTimers();
  (await import("../lib/command-center"))._resetCommandCenterForTests();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  delete process.env.BAB_COMMAND_CENTER;
  (await import("../lib/config"))._resetConfigForTests();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

function asViewer(email: string, name: string) {
  current = { "x-auth-request-user": `proxy-${email}`, "x-auth-request-email": email, "x-auth-request-preferred-username": name };
}

async function render(): Promise<string> {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const { default: Page } = await import("../app/command-center/page");
  const element = await Page();
  // React separates text parts with empty comments; drop them so a test can match a sentence.
  return (await new Response(await renderToReadableStream(element as never)).text()).replaceAll("<!-- -->", "");
}

const agent = (email: string) => ({ id: email, email, name: "Agent", roles: [], source: "device" as const, deviceId: "d1" });

async function seedAlice(extra: Record<string, unknown> = {}) {
  const cc = await import("../lib/command-center");
  cc.ccSetSwitch(ALICE, true);
  cc.ccPublish(
    agent(ALICE),
    ALICE,
    {
      v: 1,
      id: "billing-export",
      title: "Billing <b>export</b>",
      area: "finance",
      tasks: [
        { id: "a", text: "Design", status: "done" },
        { id: "b", text: "Build", status: "in_progress" },
      ],
      questions: [{ id: "q1", text: "<script>alert(1)</script> Which months?", options: ["All"] }],
      links: [{ label: "PR", url: "https://git.example.com/acme/x/pull/1" }],
      source: { machine: "laptop-1", session: "s-1" },
      ...extra,
    },
    "mcp",
  );
}

function form(pathname: string, fields: Record<string, string>, origin = ORIGIN) {
  return new Request(ORIGIN + pathname, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded", host: "localhost:4310" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("/command-center page", () => {
  it("asks an anonymous visitor to sign in and shows no records", async () => {
    await seedAlice();
    const html = await render();
    expect(html).toContain("Sign in to BAB");
    expect(html).not.toContain("Which months?");
  });

  it("shows the off-state with the Enable button and the skill hint", async () => {
    asViewer(BOB, "Bob B");
    const html = await render();
    expect(html).toContain("Command Center is off. Switch it on to let your Claude sessions publish their initiatives here.");
    expect(html).toContain('action="/command-center/enable"');
    expect(html).toContain("/instructions/command-center.md");
  });

  it("shows the on-state: needs-you first, the initiative grouped by area, percent and links", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html.indexOf("Needs you")).toBeLessThan(html.indexOf("finance"));
    expect(html).toContain("50%");
    expect(html).toContain('href="https://git.example.com/acme/x/pull/1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('action="/command-center/dismiss"');
    expect(html).toContain("Last push just now");
    expect(html).not.toContain("possibly stale");
  });

  it("renders agent text as text, never HTML", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; Which months?");
    expect(html).not.toContain("<b>export</b>");
  });

  it("tags a question possibly stale after 3 days", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    vi.setSystemTime(NOW + 3 * DAY + 60_000);
    const html = await render();
    expect(html).toContain("possibly stale");
    expect(html).toContain("asked 3 days ago");
  });

  it("never shows another person's records", async () => {
    await seedAlice();
    (await import("../lib/command-center")).ccSetSwitch(BOB, true);
    asViewer(BOB, "Bob B");
    const html = await render();
    expect(html).not.toContain("Which months?");
    expect(html).not.toContain("Billing");
    expect(html).toContain("No initiatives yet");
  });

  it("shows kept-until and Delete now when off with data left", async () => {
    await seedAlice();
    (await import("../lib/command-center")).ccSetSwitch(ALICE, false);
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toContain("Your records are kept until 2026-04-01");
    expect(html).toContain('action="/command-center/delete"');
  });

  it("says so when switched off on the server", async () => {
    process.env.BAB_COMMAND_CENTER = "0";
    (await import("../lib/config"))._resetConfigForTests();
    asViewer(ALICE, "Alice A");
    expect(await render()).toContain("switched off on this BAB");
  });

  it("is not in the navbar or the footer", async () => {
    const { NAV_ITEMS } = await import("../app/components/nav-items");
    expect(NAV_ITEMS.map((i) => i.href as string)).not.toContain("/command-center");
    expect(readFileSync(path.join(process.cwd(), "app/components/landing/Footer.tsx"), "utf8")).not.toContain("/command-center");
  });
});

describe("viewer routes", () => {
  it("enable, dismiss, disable and delete work for the viewer with a 303", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    const cc = await import("../lib/command-center");
    const dismiss = await (await import("../app/command-center/dismiss/route")).POST(form("/command-center/dismiss", { id: "billing-export", questionId: "q1" }));
    expect(dismiss.status).toBe(303);
    expect(cc.ccView(ALICE).needsYou).toEqual([]);
    expect((await (await import("../app/command-center/disable/route")).POST(form("/command-center/disable", {}))).status).toBe(303);
    expect(cc.ccSwitch(ALICE).enabledAt).toBeNull();
    expect((await (await import("../app/command-center/enable/route")).POST(form("/command-center/enable", {}))).status).toBe(303);
    expect(cc.ccSwitch(ALICE).enabledAt).not.toBeNull();
    expect((await (await import("../app/command-center/delete/route")).POST(form("/command-center/delete", {}))).status).toBe(303);
    expect(cc.ccView(ALICE).records).toEqual([]);
  });

  it("refuses a cross-site post and an agent identity", async () => {
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/command-center/enable/route");
    expect((await POST(form("/command-center/enable", {}, "https://evil.example.com"))).status).toBe(403);
    current = { "x-bab-actor-email": BOB, "x-bab-actor-name": "Bob B" };
    const res = await POST(new Request(ORIGIN + "/command-center/enable", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", host: "localhost:4310" }, body: "{}" }));
    expect(res.status).toBe(401);
    const cc = await import("../lib/command-center");
    expect(cc.ccSwitch(BOB).enabledAt).toBeNull();
  });

  it("serves the poll stamp to the viewer only", async () => {
    await seedAlice();
    const { GET } = await import("../app/command-center/state/route");
    expect((await GET()).status).toBe(401);
    asViewer(ALICE, "Alice A");
    const body = await (await GET()).json();
    expect(body.stamp).toContain("billing-export:1");
  });
});

describe("the command-center skill", () => {
  it("is served with the origin filled in and carries the rule", async () => {
    const { GET } = await import("../app/instructions/command-center.md/route");
    const text = await (await GET(new Request("https://bab.example.com/instructions/command-center.md", { headers: { host: "bab.example.com" } }) as never)).text();
    expect(text).toMatch(/^---\nname: command-center\ndescription: .+\n---/);
    expect(text).not.toContain("{{ORIGIN}}");
    expect(text).toContain("/command-center page true: call `bab_command_center` `publish`");
    expect(text).not.toMatch(/node /);
  });

  it("the plugin skill carries the same rule paragraph", () => {
    const served = readFileSync(path.join(process.cwd(), "content/instructions/command-center.md"), "utf8").replaceAll("{{ORIGIN}}", "<bab_url>");
    // A Windows checkout with core.autocrlf has CRLF here (only content/instructions is pinned to LF).
    const plugin = readFileSync(path.join(process.cwd(), "plugins/command-center/skills/command-center/SKILL.md"), "utf8").replaceAll("\r\n", "\n");
    const rule = served.slice(served.indexOf("## The rule"), served.indexOf("## The record"));
    expect(rule.length).toBeGreaterThan(200);
    expect(plugin).toContain(rule);
    expect(plugin).toMatch(/^---\nname: command-center\n/);
  });
});
