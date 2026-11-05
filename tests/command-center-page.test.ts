import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * /command-center and its poll route: the signed-in viewer only, agent text as inert React
 * text, no controls but Open in Claude and the drawer, and the served command-center skill.
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

/** The card (an <article>) of one initiative, as HTML. */
function cardOf(html: string, id: string): string {
  const at = html.indexOf(`data-initiative="${id}"`);
  return html.slice(html.lastIndexOf("<article", at), html.indexOf("</article>", at));
}

/** The drawer panel of one initiative, as HTML (every panel is in the page, hidden unless open). */
function panelOf(html: string, id: string): string {
  const at = html.indexOf(`data-detail="${id}"`);
  const next = html.indexOf("data-detail=", at + 1);
  return html.slice(html.lastIndexOf("<div", at), next > 0 ? next : html.indexOf("</dialog>", at));
}

const agent = (email: string) => ({ id: email, email, name: "Agent", roles: [], source: "device" as const, deviceId: "d1" });

async function seedAlice(extra: Record<string, unknown> = {}) {
  const cc = await import("../lib/command-center");
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

  it("shows a person with no data the empty board and the plugin to install, with no switch", async () => {
    asViewer(BOB, "Bob B");
    const html = await render();
    expect(html).toMatch(/data-empty="">No initiatives yet\. Install the command-center plugin \(<code>\/plugin install command-center@(?:<!-- -->)?[\w.-]+<\/code>\)/);
    for (const gone of ["Switch on", "Switch off", "/command-center/enable", "/command-center/disable", "/command-center/delete", "Command Center settings", ">On<", ">Off<"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("shows the on-state: no separate needs-you section, the question on its card, percent and links", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).not.toContain('id="cc-needs"');
    expect(html).not.toMatch(/<h2[^>]*>Needs you</);
    expect(html.indexOf("Which months?")).toBeGreaterThan(html.indexOf('data-initiative="billing-export"'));
    expect(html).toContain("50%");
    expect(html).toContain('href="https://git.example.com/acme/x/pull/1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("/command-center/dismiss");
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
    asViewer(BOB, "Bob B");
    const html = await render();
    expect(html).not.toContain("Which months?");
    expect(html).not.toContain("Billing");
    expect(html).toContain("No initiatives yet");
  });

  it("says so when switched off on the server", async () => {
    process.env.BAB_COMMAND_CENTER = "0";
    (await import("../lib/config"))._resetConfigForTests();
    asViewer(ALICE, "Alice A");
    expect(await render()).toContain("switched off on this BAB");
  });

  it("orders cards urgent, high, none, low, paused and greys a paused one with its label", async () => {
    const cc = await import("../lib/command-center");
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

  it("shows progress as a ring with percent and done/total, the main task, and the subtasks with status labels", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toMatch(/<text[^>]*>50%<\/text>/);
    expect(html).toMatch(/ringCount[^"]*"[^>]*>1\/2</);
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="50"[^>]*aria-valuetext="50%, 1 of 2 tasks done"/);
    expect(html).toContain('stroke-dasharray="50 100"');
    // The ring sits in the card head next to the title; done/total only in the drawer.
    const card = cardOf(html, "billing-export");
    expect(card.slice(card.indexOf("</h4>"))).toMatch(/^<\/h4><span class="[^"]*srOnly[^"]*">Needs you<\/span><\/div><div[^>]*cardSide[^>]*><div[^>]*ring[^>]*><svg[^>]*role="progressbar"/);
    expect(card).not.toContain("ringCount");
    expect(panelOf(html, "billing-export")).toMatch(/ringCount[^"]*"[^>]*>1\/2</);
    // A Needs you card shows no question and no task; both are in the drawer.
    expect(card).not.toContain("&lt;script&gt;");
    expect(card).not.toContain("<p");
    expect(card).not.toContain("Build");
    expect(card).not.toContain("Design");
    // Open tasks first; the done ones fold under "N done".
    expect(panelOf(html, "billing-export")).toMatch(/aria-label="Open tasks"><li[^>]*>.*?In progress: <\/span><span>Build</);
    expect(panelOf(html, "billing-export")).toMatch(/<details[^>]*data-done-tasks="1"><summary[^>]*>1 done<\/summary><ul[^>]*aria-label="Done tasks"><li[^>]*>.*?Done: <\/span><span>Design</);
    expect(html).not.toMatch(/<(svg|circle|text)[^>]*style=/);
  });

  it("shows a compact card face and puts the rest in its drawer panel", async () => {
    await seedAlice({ key: "KEY-1", deadline: "2026-03-20", worked: "Wrote the parser" });
    asViewer(ALICE, "Alice A");
    const html = await render();
    const card = cardOf(html, "billing-export");
    const panel = panelOf(html, "billing-export");
    // The card: title (a button that opens the drawer), ring and Open in Claude, no question text.
    expect(card).toMatch(/<button type="button"[^>]*data-open-card="billing-export"[^>]*>Billing &lt;b&gt;export&lt;\/b&gt;<\/button>/);
    for (const shown of ["50%", "Open in Claude"]) expect(card).toContain(shown);
    expect(card).not.toContain("<details");
    expect(card).not.toContain("data-badge");
    expect(card).not.toContain("<form");
    expect(card).not.toMatch(/class="[^"]*\btag\b/);
    for (const gone of ["Build", "KEY-1", "Which months?", 'data-question="q1"', "asked just now", "Options: ", "due 2026-03-20", "git.example.com", 'aria-label="Log, newest first"', "Wrote the parser", "Updated ", "last pushed by", "1 question<"]) {
      expect(card).not.toContain(gone);
      expect(panel).toContain(gone);
    }
    // The drawer: one dialog; each panel is labelled by its title and hidden until a card opens it.
    expect(html.match(/<dialog/g)).toHaveLength(1);
    expect(panel).toMatch(/^<div[^>]*hidden/);
    expect(panel).toContain('id="cc-d-billing-export"');
    expect(panel).toContain('data-badge="needs_you"');
    expect(panel).toContain("last pushed by laptop-1 / s-1");
    expect(panel).toContain('aria-label="Close details"');
    expect(panel).not.toContain("<form");
    expect(panel).not.toContain("Dismiss");
    expect(panel).toContain('aria-label="Open tasks"');
  });

  it("keeps deadlines in the drawer and marks an overdue card with one red dot", async () => {
    const cc = await import("../lib/command-center");
    cc.ccPublish(agent(ALICE), ALICE, { v: 1, id: "near", title: "Near", deadline: "2026-03-05" }, "mcp");
    cc.ccPublish(agent(ALICE), ALICE, { v: 1, id: "far", title: "Far", deadline: "2026-06-30" }, "mcp");
    cc.ccPublish(agent(ALICE), ALICE, { v: 1, id: "late", title: "Late", deadline: "2026-02-28" }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(cardOf(html, "near")).not.toContain("due in 3 days");
    expect(panelOf(html, "near")).toContain("due in 3 days");
    expect(cardOf(html, "far")).not.toContain("2026-06-30");
    expect(panelOf(html, "far")).toContain("due 2026-06-30");
    for (const id of ["near", "far"]) expect(cardOf(html, id)).not.toContain("data-overdue");
    expect(cardOf(html, "late")).toMatch(/role="img" aria-label="Overdue by 2 days" title="Overdue by 2 days \(2026-02-28\)" data-overdue=""/);
    expect(panelOf(html, "late")).toContain("overdue by 2 days");
  });

  it("shows an upkeep row with a question as one needs-you line with Open in Claude; the question opens in the drawer", async () => {
    const cc = await import("../lib/command-center");
    cc.ccPublish(agent(ALICE), ALICE, { v: 1, id: "backup", title: "Backup check", kind: "recurring", cadence: "daily", questions: [{ id: "u1", text: "Rotate <b>keys</b>?", options: ["Now"] }] }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    const start = html.indexOf('data-initiative="backup"');
    expect(start).toBeGreaterThan(0);
    const row = html.slice(html.lastIndexOf("<li", start), html.indexOf("</li>", start));
    expect(row).toMatch(/class="[^"]*upAsk/);
    expect(row).toContain('data-card="backup"');
    expect(row).toMatch(/<button type="button"[^>]*data-open-card="backup"[^>]*>Backup check<\/button>/);
    // One label: Needs you replaces the health label; no cadence or other tags on the row.
    expect(row).toContain('data-badge="needs_you"');
    expect(row).not.toContain("No health yet");
    expect(row).not.toContain("daily");
    expect(row).toMatch(/disabled=""[^>]*title="No session link"/);
    for (const gone of ["Rotate", "data-question", "asked ", "Now", "<form"]) expect(row).not.toContain(gone);
    const panel = panelOf(html, "backup");
    expect(panel).toContain("Rotate &lt;b&gt;keys&lt;/b&gt;?");
    expect(panel).toContain("Options: Now");
    expect(panel).toContain("No health yet");
    expect(panel).toContain("daily");
    expect(html).not.toContain("<b>keys</b>");
  });

  it("keeps every question, oldest first, with its age, stale tag and options in the drawer only", async () => {
    const cc = await import("../lib/command-center");
    const a = agent(ALICE);
    const q1 = { id: "q1", text: "First ask", options: ["Yes", "No"] };
    const q2 = { id: "q2", text: "Second ask" };
    vi.setSystemTime(NOW - 4 * DAY);
    cc.ccPublish(a, ALICE, { v: 1, id: "many", title: "Many asks", questions: [q1] }, "mcp");
    vi.setSystemTime(NOW - DAY);
    cc.ccPublish(a, ALICE, { v: 1, id: "many", title: "Many asks", questions: [q1, q2] }, "mcp");
    vi.setSystemTime(NOW);
    cc.ccPublish(a, ALICE, { v: 1, id: "many", title: "Many asks", questions: [q1, q2, { id: "q3", text: "Third ask" }] }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).not.toContain('id="cc-needs"');
    const card = cardOf(html, "many");
    for (const gone of ["First ask", "Second ask", "+2", "asked 4 days ago", "possibly stale", ">Yes<"]) expect(card).not.toContain(gone);
    expect(card).toContain('data-status="needs_you"');
    const panel = panelOf(html, "many");
    for (const shown of ["asked 4 days ago", "possibly stale", "Options: Yes · No"]) expect(panel).toContain(shown);
    expect(panel).not.toContain(">Yes<");
    expect(panel.indexOf("First ask")).toBeLessThan(panel.indexOf("Second ask"));
    expect(panel.indexOf("Second ask")).toBeLessThan(panel.indexOf("Third ask"));
    expect(panel.match(/data-question="/g)).toHaveLength(3);
    expect(panel).not.toContain("<form");
  });

  it("shows one task line on a card and every task, with its status, in the drawer", async () => {
    const cc = await import("../lib/command-center");
    const tasks = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, text: `Task ${i}`, status: i < 3 ? "done" : i === 3 ? "in_progress" : "pending" }));
    cc.ccPublish(agent(ALICE), ALICE, { v: 1, id: "big", title: "Big one", tasks }, "mcp");
    cc.ccPublish(agent(ALICE), ALICE, { v: 1, id: "fin", title: "Fin", tasks: [{ id: "a", text: "Only", status: "done" }] }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    const card = cardOf(html, "big");
    expect(card).toMatch(/Now: <\/span><span[^>]*>Task 3</);
    for (const t of ["Task 0", "Task 4", "Task 8"]) expect(card).not.toContain(`${t}<`);
    const panel = panelOf(html, "big");
    for (let i = 0; i < 9; i++) expect(panel).toContain(`Task ${i}<`);
    expect(panel).toContain("Done: </span><span>Task 0<");
    expect(panel).toContain("In progress: </span><span>Task 3<");
    expect(panel).toContain("To do: </span><span>Task 8<");
    // A Finished card has no line at all: title and ring only.
    expect(cardOf(html, "fin")).not.toContain("<p");
    expect(cardOf(html, "fin")).not.toContain("Only");
  });

  it("derives the badge: active under 2 h, idle at 2 h, finished when all tasks are done, needs you first, paused idle", async () => {
    const cc = await import("../lib/command-center");
    const a = agent(ALICE);
    const done = [{ id: "a", text: "A", status: "done" }];
    cc.ccPublish(a, ALICE, { v: 1, id: "live", title: "Live", tasks: [{ id: "a", text: "A", status: "in_progress" }] }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "fin", title: "Fin", tasks: done }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "ask", title: "Ask", tasks: done, questions: [{ id: "q", text: "Go?" }] }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "rest", title: "Rest", priority: "paused" }, "mcp");
    asViewer(ALICE, "Alice A");
    const badge = (html: string, id: string) => html.slice(html.indexOf(`data-initiative="${id}"`)).match(/data-status="([a-z_]+)"/)?.[1];
    vi.setSystemTime(NOW + 2 * 3_600_000 - 1);
    let html = await render();
    expect(badge(html, "live")).toBe("active");
    expect(badge(html, "fin")).toBe("finished");
    expect(badge(html, "ask")).toBe("needs_you");
    expect(badge(html, "rest")).toBe("idle");
    expect(cardOf(html, "rest")).toMatch(/class="[^"]*greyed/);
    expect(cardOf(html, "rest")).not.toContain("tagPaused");
    expect(panelOf(html, "rest")).toMatch(/badgePaused[^"]*">.*paused/);
    // Sort: needs you, active, idle, finished.
    const at = (id: string) => html.indexOf(`data-initiative="${id}"`);
    expect([at("ask"), at("live"), at("rest"), at("fin")].every((v, i, all) => v > 0 && (i === 0 || v > all[i - 1]))).toBe(true);
    // Each card sits in its status column, and the column header counts them.
    const col = (s: string) => html.slice(html.indexOf(`data-column="${s}"`), html.indexOf("</section>", html.indexOf(`data-column="${s}"`)));
    expect(col("needs_you")).toContain('data-initiative="ask"');
    expect(col("active")).toContain('data-initiative="live"');
    expect(col("idle")).toContain('data-initiative="rest"');
    expect(col("finished")).toContain('data-initiative="fin"');
    expect(col("active")).toMatch(/>Active<span[^>]*data-count="1">1<span[^>]*> initiative<\/span><\/span><\/h3>/);
    expect(html).not.toContain("data-status-filter");
    const stampBefore = cc.ccView(ALICE).stamp;
    vi.setSystemTime(NOW + 2 * 3_600_000);
    html = await render();
    expect(badge(html, "live")).toBe("idle");
    expect(badge(html, "fin")).toBe("finished");
    // Crossing the line changes the poll stamp, so an open page refreshes.
    expect(cc.ccView(ALICE).stamp).not.toBe(stampBefore);
  });

  it("shows each link's host next to its label, with the full URL as the tooltip", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toMatch(/title="https:\/\/git\.example\.com\/acme\/x\/pull\/1"[^>]*>.*?<span class="[^"]*linkHost[^"]*">git\.example\.com<\/span><\/a>/);
  });

  it("puts the initiatives on one board of four status columns, with no area headings or area text", async () => {
    const cc = await import("../lib/command-center");
    const a = agent(ALICE);
    cc.ccPublish(a, ALICE, { v: 1, id: "fin-low", title: "Fin low", area: "finance-zone", priority: "low" }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "ops-high", title: "Ops high", area: "ops-zone", priority: "high" }, "mcp");
    vi.setSystemTime(NOW + 60_000);
    cc.ccPublish(a, ALICE, { v: 1, id: "fin-high", title: "Fin high", area: "finance-zone", priority: "high" }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html.match(/data-cc-board=""/g)).toHaveLength(1);
    expect(html.match(/data-column="[a-z_]+"/g)).toEqual(['data-column="needs_you"', 'data-column="active"', 'data-column="idle"', 'data-column="finished"']);
    // An empty column keeps its place, with a 0 count.
    expect(html).toMatch(/data-column="finished"[^>]*data-empty=""/);
    expect(html).toContain("Nothing here");
    expect(html).not.toMatch(/class="[^"]*\barea/);
    expect(html).not.toContain("finance-zone");
    expect(html).not.toContain("ops-zone");
    // Priority first, then most recently updated, across areas.
    const at = (id: string) => html.indexOf(`data-initiative="${id}"`);
    expect(at("fin-high")).toBeGreaterThan(0);
    expect(at("fin-high")).toBeLessThan(at("ops-high"));
    expect(at("ops-high")).toBeLessThan(at("fin-low"));
    expect(html).toContain('<h4 id="cc-i-fin-high"');
  });

  it("tags a deadline as near, overdue or plain, in words", async () => {
    const cc = await import("../lib/command-center");
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

  it("shows no needs-you section, zero chips as neutral, and no forms or settings", async () => {
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).not.toContain("All clear");
    expect(html).not.toContain('id="cc-needs"');
    expect(html).toContain("Nothing published yet");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Command Center settings");
    expect(html).not.toMatch(/aria-label="\d+ items?"/);
    expect(html).toMatch(/data-empty="">No initiatives yet\. Install the command-center plugin/);
    // Health chips show only when something is off.
    expect(html).not.toContain('data-testid="data-health"');
    expect(html).not.toMatch(/chip(Warn|Bad)/);
  });

  it("is not in the navbar or the footer", async () => {
    const { NAV_ITEMS } = await import("../app/components/nav-items");
    expect(NAV_ITEMS.map((i) => i.href as string)).not.toContain("/command-center");
    expect(readFileSync(path.join(process.cwd(), "app/components/shell/Footer.tsx"), "utf8")).not.toContain("/command-center");
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

  it("tags backfilled log entries, and only those", async () => {
    const cc = await import("../lib/command-center");
    cc.ccPublish(agent(ALICE), ALICE, { v: 1, id: "billing-export", title: "Billing export", worked: "Live line" }, "mcp");
    cc.ccBackfill(
      ALICE,
      { v: 1, entries: [{ id: "s1:1", initiative: "billing-export", worked: "Old <b>line</b>", at: new Date(NOW - 3_600_000).toISOString() }] },
      "mcp",
      ORIGIN,
      NOW,
    );
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(html).toContain("Old &lt;b&gt;line&lt;/b&gt;");
    expect(html.match(/data-source="backfill">backfill</g)).toHaveLength(1);
    const backfilledLi = html.slice(html.indexOf("Old &lt;b&gt;"), html.indexOf("</li>", html.indexOf("Old &lt;b&gt;")));
    expect(backfilledLi).toContain('data-source="backfill"');
  });

  it("keeps done, parked and silent initiatives off the page and says how many", async () => {
    const cc = await import("../lib/command-center");
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

  it("has no log download and no report apps, even when report apps are set up", async () => {
    process.env.BAB_COMMAND_CENTER_EXPORT_APPS = `reports=${"r".repeat(40)}`;
    (await import("../lib/config"))._resetConfigForTests();
    await seedAlice();
    (await import("../lib/command-center")).ccGrantExport(ALICE, "reports", "entries");
    asViewer(ALICE, "Alice A");
    const html = await render();
    for (const gone of ["/command-center/export", "Download my log", "Report apps", 'data-app="reports"', "<form", "Delete all"]) expect(html).not.toContain(gone);
  });

  it("puts Open in Claude on a Needs you card with its session link, disabled without one, and small in every drawer", async () => {
    const cc = await import("../lib/command-center");
    const a = agent(ALICE);
    const link = "claude://claude.ai/epitaxy/session_01AbC-x_y.z";
    cc.ccPublish(a, ALICE, { v: 1, id: "linked", title: "Linked", questions: [{ id: "q", text: "Go?" }], source: { machine: "vm", session: "s1", link } }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "nolink", title: "No link", questions: [{ id: "q", text: "Go?" }], source: { machine: "vm", session: "s2" } }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "busy", title: "Busy", tasks: [{ id: "t", text: "Work", status: "in_progress" }], source: { link: "https://claude.ai/code/session_01x" } }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    expect(cardOf(html, "linked")).toContain(`href="${link}" rel="noopener noreferrer" data-open-session="linked">Open in Claude`);
    expect(cardOf(html, "linked")).not.toContain("target=");
    expect(cardOf(html, "nolink")).toMatch(/<button type="button"[^>]*disabled=""[^>]*title="No session link"[^>]*>Open in Claude<span class="[^"]*srOnly[^"]*"> \(no session link\)<\/span><\/button>/);
    // Other cards carry it in the drawer only.
    expect(cardOf(html, "busy")).not.toContain("Open in Claude");
    expect(panelOf(html, "busy")).toContain('href="https://claude.ai/code/session_01x" rel="noopener noreferrer" data-open-session="busy"');
    expect(panelOf(html, "linked")).toContain(`href="${link}"`);
    expect(panelOf(html, "nolink")).toContain('title="No session link"');
  });

  it("has no action on the board or in the drawer but Open in Claude", async () => {
    const cc = await import("../lib/command-center");
    await seedAlice({ source: { machine: "vm", session: "s1", link: "https://claude.ai/code/s1" } });
    cc.ccPublish(agent(ALICE), ALICE, { v: 1, id: "backup", title: "Backup check", kind: "recurring", cadence: "daily", questions: [{ id: "u1", text: "Rotate?", options: ["Now"] }] }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    // From the board through the upkeep section to the end of the drawer.
    const board = html.slice(html.indexOf('id="cc-initiatives"'), html.indexOf("</dialog>") + 9);
    expect(board).toContain('data-initiative="backup"');
    expect(board).not.toContain("<form");
    expect(board).not.toContain("<input");
    expect(board).not.toContain("Dismiss");
    // Every button opens a card or the drawer's close, or is a disabled Open in Claude.
    for (const b of board.match(/<button[^>]*>/g) ?? []) expect(b).toMatch(/data-open-card=|aria-label="Close details"|data-open-session=""[^>]*|disabled=""/);
    for (const a of board.match(/<a [^>]*>/g) ?? []) expect(a).toMatch(/data-open-session=|linkPill/);
  });

  it("checks the session link again before it becomes an href, so a stored bad one renders a disabled button", async () => {
    await seedAlice({ source: { machine: "vm", session: "s1", link: "https://claude.ai/ok" } });
    const { getDb } = await import("../lib/db");
    const strings = ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "//evil.example.com/x", "https://claude.ai/a b", "https://claude.ai/a?b=1",
      "https://claude.ai/x\n", "https://claude.ai/%6A", "https://claude.ai\\@evil.example.com", "https://claude.ai:8443/x", "https://u@example.com/x",
      "https://claude.ai//evil.example.com", "https://claude.ai/a/../b", `https://claude.ai/${"a".repeat(290)}`];
    // Stored as JSON values, so non-strings land as numbers, objects and arrays.
    const values = [...strings.map((s) => JSON.stringify(s)), "42", "{}", '["https://claude.ai/x"]', "true"];
    for (const bad of values) {
      getDb().prepare("UPDATE command_center_initiatives SET record = json_set(record, '$.source.link', json(?)) WHERE owner_id = ? AND id = ?").run(bad, ALICE, "billing-export");
      asViewer(ALICE, "Alice A");
      const html = await render();
      expect(html).not.toContain("data-open-session=\"billing-export\"");
      expect(html).not.toMatch(/href="(javascript|data|JAVASCRIPT):/);
      expect(cardOf(html, "billing-export")).toMatch(/disabled=""[^>]*title="No session link"/);
    }
  });

  it("shows the 3 newest Finished cards, then +N more with the rest folded", async () => {
    const cc = await import("../lib/command-center");
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(NOW + i * 60_000);
      cc.ccPublish(agent(ALICE), ALICE, { v: 1, id: `f${i}`, title: `Fin ${i}`, tasks: [{ id: "a", text: "A", status: "done" }] }, "mcp");
    }
    asViewer(ALICE, "Alice A");
    const html = await render();
    const col = html.slice(html.indexOf('data-column="finished"'), html.indexOf("</section>", html.indexOf('data-column="finished"')));
    expect(col).toContain('data-count="5"');
    const more = col.indexOf("<details");
    expect(more).toBeGreaterThan(0);
    for (const id of ["f4", "f3", "f2"]) expect(col.indexOf(`data-initiative="${id}"`)).toBeLessThan(more);
    for (const id of ["f1", "f0"]) expect(col.indexOf(`data-initiative="${id}"`)).toBeGreaterThan(more);
    expect(col.indexOf('data-initiative="f4"')).toBeLessThan(col.indexOf('data-initiative="f3"'));
    expect(col).toMatch(/data-more-cards="2"><summary[^>]*>\+2 more<\/summary>/);
    // Every card, folded or not, has its drawer panel.
    for (let i = 0; i < 5; i++) expect(html).toContain(`data-detail="f${i}"`);
  });

  it("shows only upkeep that needs a look, then the healthy rows folded under N healthy", async () => {
    const cc = await import("../lib/command-center");
    const a = agent(ALICE);
    const checkedAt = new Date(NOW - 60_000).toISOString();
    cc.ccPublish(a, ALICE, { v: 1, id: "ok-1", title: "Green one", kind: "recurring", cadence: "daily", health: { level: "green", reason: "", checkedAt } }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "ok-2", title: "Green two", kind: "recurring", cadence: "daily", health: { level: "green", reason: "", checkedAt } }, "mcp");
    cc.ccPublish(a, ALICE, { v: 1, id: "red-1", title: "Red one", kind: "recurring", cadence: "daily", health: { level: "red", reason: "Broken", checkedAt } }, "mcp");
    asViewer(ALICE, "Alice A");
    const html = await render();
    const fold = html.indexOf("data-healthy=");
    expect(html).toMatch(/data-healthy="2"><summary[^>]*><span[^>]*><\/span>2 healthy<\/summary>/);
    expect(html.indexOf('data-initiative="red-1"')).toBeLessThan(fold);
    for (const id of ["ok-1", "ok-2"]) expect(html.indexOf(`data-initiative="${id}"`)).toBeGreaterThan(fold);
  });

  it("keeps the header on one quiet line: title and last push, no menu, no On pill, no Initiatives count", async () => {
    await seedAlice();
    asViewer(ALICE, "Alice A");
    const html = await render();
    // The site navbar is the first <header>; the page's own header is the second.
    const at = html.indexOf("<header", html.indexOf("</header>"));
    const header = html.slice(at, html.indexOf("</header>", at));
    expect(header).toContain("Command Center");
    expect(header).toContain("Last push just now");
    expect(header).not.toContain("<details");
    expect(header).not.toContain("<button");
    expect(header).not.toMatch(/>On</);
    expect(html).not.toContain('id="cc-log"');
    expect(html).toMatch(/<h2 id="cc-initiatives" class="[^"]*srOnly[^"]*">Initiatives<\/h2>/);
  });
});

describe("viewer routes", () => {
  it("has no switch, delete or export routes any more", () => {
    for (const r of ["enable", "disable", "delete", "export"]) expect(existsSync(path.join(process.cwd(), "app/command-center", r))).toBe(false);
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
