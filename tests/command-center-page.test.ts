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
  delete process.env.BAB_COMMAND_CENTER_EXPORT_APPS;
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

  it("shows the on-state: needs-you first, then the initiative, percent and links", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html.indexOf("Needs you")).toBeLessThan(html.indexOf('data-initiative="billing-export"'));
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

  it("orders cards urgent, high, none, low, paused and greys a paused one with its label", async () => {
    const cc = await import("../lib/command-center");
    cc.ccSetSwitch(ALICE, true);
    const a = agent(ALICE);
    for (const [id, priority] of [["p-paused", "paused"], ["p-low", "low"], ["p-none", null], ["p-high", "high"], ["p-urgent", "urgent"]] as const) {
      cc.ccPublish(a, ALICE, { v: 1, id, title: `T ${id}`, area: "ops", priority, questions: [{ id: "q", text: `Ask ${id}` }] }, "mcp");
    }
    asViewer(ALICE, "Alice A");
    const html = await render();
    const at = (id: string) => html.indexOf(`data-initiative="${id}"`);
    expect([at("p-urgent"), at("p-high"), at("p-none"), at("p-low"), at("p-paused")].every((v, i, all) => v > 0 && (i === 0 || v > all[i - 1]))).toBe(true);
    const paused = html.slice(html.lastIndexOf("<article", at("p-paused")), html.indexOf("</article>", at("p-paused")));
    expect(paused).toMatch(/class="[^"]*greyed/);
    expect(paused).toContain("paused");
    expect(html).not.toContain("Ask p-paused");
    expect(html).toContain("urgent");
    expect(html).toContain("high priority");
  });

  it("shows progress as percent and done/total, the next task, and the task list with status labels", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toContain("50%");
    expect(html).toContain("1/2 tasks");
    expect(html).toMatch(/Now<\/span><span[^>]*>Build</);
    expect(html).toContain("Done: </span><span>Design");
    expect(html).toContain("In progress: </span><span>Build");
    expect(html).not.toContain('style="width:50%"');
  });

  it("shows each link's host next to its label, with the full URL as the tooltip", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toMatch(/title="https:\/\/git\.example\.com\/acme\/x\/pull\/1"[^>]*>.*?<span class="[^"]*linkHost[^"]*">git\.example\.com<\/span><\/a>/);
  });

  it("flows every initiative in one flat masonry container, with no area headings or area text", async () => {
    const cc = await import("../lib/command-center");
    cc.ccSetSwitch(ALICE, true);
    const a = agent(ALICE);
    cc.ccPublish(a, ALICE, { v: 1, id: "fin-low", title: "Fin low", area: "finance-zone", priority: "low" }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "ops-high", title: "Ops high", area: "ops-zone", priority: "high" }, "mcp");
    vi.setSystemTime(NOW + 60_000);
    cc.ccPublish(a, ALICE, { v: 1, id: "fin-high", title: "Fin high", area: "finance-zone", priority: "high" }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html.match(/class="[^"]*flow[^"]*"/g)).toHaveLength(1);
    expect(html).not.toMatch(/class="[^"]*\bgrid\b/);
    expect(html).not.toMatch(/class="[^"]*\barea/);
    expect(html).not.toContain("finance-zone");
    expect(html).not.toContain("ops-zone");
    // Priority first, then most recently updated, across areas.
    const at = (id: string) => html.indexOf(`data-initiative="${id}"`);
    expect(at("fin-high")).toBeGreaterThan(0);
    expect(at("fin-high")).toBeLessThan(at("ops-high"));
    expect(at("ops-high")).toBeLessThan(at("fin-low"));
    expect(html).toContain('<h3 id="cc-i-fin-high"');
  });

  it("tags a deadline as near, overdue or plain, in words", async () => {
    const cc = await import("../lib/command-center");
    cc.ccSetSwitch(ALICE, true);
    const a = agent(ALICE);
    cc.ccPublish(a, ALICE, { v: 1, id: "near", title: "Near", deadline: "2026-03-05" }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "late", title: "Late", deadline: "2026-02-28" }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "far", title: "Far", deadline: "2026-06-30" }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "today", title: "Today", deadline: "2026-03-02" }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toContain("due in 3 days");
    expect(html).toContain("overdue by 2 days");
    expect(html).toContain("due 2026-06-30");
    expect(html).toContain("due today");
    expect(html).toContain("(days counted in UTC)");
  });

  it("counts deadline days on calendar dates in UTC, so the hour never shifts the label", async () => {
    const cc = await import("../lib/command-center");
    cc.ccSetSwitch(ALICE, true);
    const a = agent(ALICE);
    cc.ccPublish(a, ALICE, { v: 1, id: "tmrw", title: "Tomorrow", deadline: "2026-03-03" }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "yday", title: "Yesterday", deadline: "2026-03-01" }, "mcp");
    asViewer(ALICE, "Alice A");
    // One second before midnight UTC: 2026-03-03 is still tomorrow, 2026-03-01 one day late.
    vi.setSystemTime(Date.parse("2026-03-02T23:59:59Z"));
    let html = await render();
    expect(html).toContain("due tomorrow");
    expect(html).toContain("overdue by 1 day<");
    // One second after midnight UTC: the same deadline is today.
    vi.setSystemTime(Date.parse("2026-03-03T00:00:01Z"));
    html = await render();
    expect(html).toContain("due today");
    expect(html).toContain("overdue by 2 days");
    expect(html).not.toContain("due tomorrow");
  });

  it("lists recurring upkeep as rows with a health label, overdue and no-health states", async () => {
    const cc = await import("../lib/command-center");
    cc.ccSetSwitch(ALICE, true);
    const a = agent(ALICE);
    const checkedAt = new Date(NOW - 3600_000).toISOString();
    cc.ccPublish(a, ALICE, { v: 1, id: "backup", title: "Backup check", kind: "recurring", cadence: "daily", health: { level: "amber", reason: "Slow run", checkedAt } }, "mcp", NOW - 3 * DAY);
    cc.ccPublish(a, ALICE, { v: 1, id: "certs", title: "Cert renewal", kind: "recurring", cadence: "weekly" }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toContain("Recurring upkeep");
    expect(html).toContain("Needs a look");
    expect(html).toContain("Slow run");
    expect(html).toContain("overdue");
    expect(html).toContain("No health yet");
    expect(html).toContain("checked 3 days ago");
    expect(html).toMatch(/chipBad[^"]*" data-count="1"/);
  });

  it("shows the All clear state, zero chips as neutral, and the settings menu with a confirm before delete", async () => {
    (await import("../lib/command-center")).ccSetSwitch(ALICE, true);
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toContain("All clear");
    expect(html).toContain("Nothing published yet");
    expect(html).toContain('aria-label="Command Center settings"');
    expect(html).toContain('action="/command-center/disable"');
    expect(html.indexOf("It cannot be undone.")).toBeLessThan(html.indexOf('action="/command-center/delete"'));
    // The delete form sits inside a <details> that starts closed: one more click to confirm.
    const del = html.indexOf('action="/command-center/delete"');
    const confirmOpen = html.lastIndexOf("<details", del);
    expect(confirmOpen).toBeGreaterThan(-1);
    expect(html.slice(confirmOpen, html.indexOf(">", confirmOpen))).not.toMatch(/open/);
    expect(html.indexOf("</details>", confirmOpen)).toBeGreaterThan(del);
    // Section counts read as "0 items" to a screen reader without an aria-label on a plain span.
    expect(html).not.toMatch(/aria-label="\d+ items?"/);
    expect(html).toMatch(/>0<span class="[^"]*srOnly[^"]*"> items<\/span>/);
    expect(html).toContain("No initiatives yet");
    expect(html).not.toMatch(/chip(Warn|Bad)/);
  });

  it("shows the off state with an Off pill and no settings menu", async () => {
    asViewer(BOB, "Bob B");
    const html = await render();
    expect(html).toMatch(/Off<\/span>/);
    expect(html).not.toContain("Command Center settings");
    expect(html).not.toContain('action="/command-center/delete"');
  });

  it("is not in the navbar or the footer", async () => {
    const { NAV_ITEMS } = await import("../app/components/nav-items");
    expect(NAV_ITEMS.map((i) => i.href as string)).not.toContain("/command-center");
    expect(readFileSync(path.join(process.cwd(), "app/components/landing/Footer.tsx"), "utf8")).not.toContain("/command-center");
  });
  it("shows a Log per initiative, newest first, with kind labels and size, as text", async () => {
    await seedAlice({ worked: "Wrote the <i>parser</i>", size: "medium" });
    const cc = await import("../lib/command-center");
    vi.setSystemTime(NOW + 60_000);
    // The same record again with a new line: one more worked entry, nothing else.
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
        worked: "Finished the build",
      },
      "mcp",
    );
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toContain('aria-label="Log, newest first"');
    expect(html.indexOf("Finished the build")).toBeLessThan(html.indexOf("Wrote the"));
    expect(html).toContain("task done");
    expect(html).toContain("asked");
    expect(html).toContain("Wrote the &lt;i&gt;parser&lt;/i&gt;");
    expect(html).not.toContain("<i>parser</i>");
    expect(html).toMatch(/logSize[^"]*">medium</);
    expect(html).not.toContain("notes");
  });

  it("keeps done, parked and silent initiatives off the page and says how many", async () => {
    const cc = await import("../lib/command-center");
    cc.ccSetSwitch(ALICE, true);
    const a = agent(ALICE);
    cc.ccPublish(a, ALICE, { v: 1, id: "old", title: "Old silent one" }, "mcp", NOW - 15 * DAY);
    cc.ccPublish(a, ALICE, { v: 1, id: "fin", title: "Finished one", state: "done" }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "park", title: "Parked one", state: "parked" }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "live", title: "Live one" }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toContain("Live one");
    expect(html).not.toContain("Old silent one");
    expect(html).not.toContain("Finished one");
    expect(html).not.toContain("Parked one");
    expect(html).toContain("3 done, parked or silent initiatives are off this page. They stay in your log.");
  });

  it("offers the person's own log download and no report apps when none are set up", async () => {
    (await import("../lib/command-center")).ccSetSwitch(ALICE, true);
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toContain('href="/command-center/export"');
    expect(html).toContain("Download my log");
    expect(html).not.toContain('action="/command-center/export/grant"');
  });

  it("lists configured report apps with share and stop-sharing forms", async () => {
    process.env.BAB_COMMAND_CENTER_EXPORT_APPS = `reports=${"r".repeat(40)}`;
    (await import("../lib/config"))._resetConfigForTests();
    const cc = await import("../lib/command-center");
    cc.ccSetSwitch(ALICE, true);
    asViewer(ALICE, "Alice A");
    let html = await render();
    expect(html).toContain('data-app="reports"');
    expect(html).toContain("not shared");
    expect(html).toContain('action="/command-center/export/grant"');
    expect(html).not.toContain('action="/command-center/export/revoke"');
    expect(html).toContain("counts per initiative and day");
    expect(html).not.toContain("r".repeat(40));
    cc.ccGrantExport(ALICE, "reports", "entries");
    html = await render();
    expect(html).toContain("shares entries");
    expect(html).toContain('action="/command-center/export/revoke"');
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
    expect(text.replace(/\s+/g, " ")).toContain("The last call of every turn is `publish` with `worked`, even when the turn only answered a question or declined a task.");
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
