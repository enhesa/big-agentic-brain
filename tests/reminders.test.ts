import { linkForTests } from "./link-helper";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-reminders-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_FORGE_HEADERS;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

function mockRequest(headersMap: Record<string, string>) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers(headersMap),
  }));
}

// todos.owner_id has a foreign key on users.id, so every owner used in a test must
// exist first (same pattern as tests/conversations.test.ts's seedUsers()).
async function seedUser(id: string) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id, email: id, name: null, roles: [] });
}

async function renderReminders() {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const { default: RemindersPage } = await import("../app/reminders/page");
  return new Response(await renderToReadableStream(RemindersPage() as never)).text();
}

// ------------------------------------------------------------------ ownerIdFor

describe("ownerIdFor", () => {
  it("returns the id as-is for a declared (agent-header) actor", async () => {
    const { ownerIdFor } = await import("../lib/reminders-view");
    expect(
      ownerIdFor({ id: "jean.dupont@example.com", email: "jean.dupont@example.com", source: "declared" }),
    ).toBe("jean.dupont@example.com");
  });

  it("maps a forge actor via its email, not its (opaque) forge id", async () => {
    const { ownerIdFor } = await import("../lib/reminders-view");
    expect(
      ownerIdFor({ id: "forge-oid-123", email: "jean.dupont@example.com", source: "forge" }),
    ).toBe("jean.dupont@example.com");
  });

  it("lowercases a forge email before matching", async () => {
    const { ownerIdFor } = await import("../lib/reminders-view");
    expect(
      ownerIdFor({ id: "forge-oid-123", email: "Jean.Dupont@Example.com", source: "forge" }),
    ).toBe("jean.dupont@example.com");
  });

  it("rejects a forge actor whose email is a short alias, not the long form", async () => {
    const { ownerIdFor } = await import("../lib/reminders-view");
    expect(ownerIdFor({ id: "forge-oid-123", email: "jdupont@example.com", source: "forge" })).toBeNull();
  });

  it("rejects a forge actor with no email at all", async () => {
    const { ownerIdFor } = await import("../lib/reminders-view");
    expect(ownerIdFor({ id: "forge-oid-123", email: null, source: "forge" })).toBeNull();
  });

  it("returns null for no actor", async () => {
    const { ownerIdFor } = await import("../lib/reminders-view");
    expect(ownerIdFor(null)).toBeNull();
  });
});

// ------------------------------------------------------------------ formatDueDate

describe("formatDueDate", () => {
  it("phrases today, tomorrow, future and overdue relative to the given today", async () => {
    const { formatDueDate } = await import("../lib/reminders-view");
    expect(formatDueDate("2026-09-25", "2026-09-25")).toBe("due today");
    expect(formatDueDate("2026-09-26", "2026-09-25")).toBe("due tomorrow");
    expect(formatDueDate("2026-10-02", "2026-09-25")).toBe("due in 7 days");
    expect(formatDueDate("2026-09-24", "2026-09-25")).toBe("1 day overdue");
    expect(formatDueDate("2026-09-20", "2026-09-25")).toBe("5 days overdue");
  });

  it("returns null when there is no due date", async () => {
    const { formatDueDate } = await import("../lib/reminders-view");
    expect(formatDueDate(null)).toBeNull();
  });
});

// ------------------------------------------------------------------ remindersFor

describe("remindersFor", () => {
  it("splits open reminders into overdue / due soon / later and includes done ones", async () => {
    const { create, complete } = await import("../lib/todos");
    const { todayUtc, addDaysUtc } = await import("../lib/dates");
    const today = todayUtc();
    await seedUser("alice@example.com");

    create({ ownerId: "alice@example.com", title: "Overdue one", dueAt: addDaysUtc(today, -2) });
    create({ ownerId: "alice@example.com", title: "Due soon one", dueAt: addDaysUtc(today, 3) });
    const laterOne = create({ ownerId: "alice@example.com", title: "Later one", dueAt: addDaysUtc(today, 30) });
    create({ ownerId: "alice@example.com", title: "No due date" });
    const toComplete = create({ ownerId: "alice@example.com", title: "Done one", dueAt: today });
    complete(toComplete.id, "alice@example.com");

    const { remindersFor } = await import("../lib/reminders-view");
    const groups = remindersFor("alice@example.com");

    expect(groups.overdue.map((t) => t.title)).toEqual(["Overdue one"]);
    expect(groups.dueSoon.map((t) => t.title)).toEqual(["Due soon one"]);
    expect(groups.later.map((t) => t.title).sort()).toEqual(["Later one", "No due date"].sort());
    expect(groups.done.map((t) => t.title)).toEqual(["Done one"]);
    expect(groups.later.some((t) => t.id === laterOne.id)).toBe(true);
  });

  it("never mixes in another owner's reminders", async () => {
    const { create } = await import("../lib/todos");
    await seedUser("alice@example.com");
    await seedUser("bob@example.com");
    create({ ownerId: "alice@example.com", title: "Alice's reminder" });
    create({ ownerId: "bob@example.com", title: "Bob's reminder" });

    const { remindersFor } = await import("../lib/reminders-view");
    const groups = remindersFor("alice@example.com");
    const allTitles = [...groups.overdue, ...groups.dueSoon, ...groups.later, ...groups.done].map((t) => t.title);
    expect(allTitles).toEqual(["Alice's reminder"]);
  });
});

// ------------------------------------------------------------------ app/reminders/page.tsx (render)

describe("RemindersPage (render)", () => {
  it("shows the signed-in owner's own reminders (declared/agent identity)", async () => {
    mockRequest({ "x-bab-actor-email": "alice.smith@example.com", "x-bab-actor-name": "Alice Smith" });
    const { create } = await import("../lib/todos");
    await seedUser("alice.smith@example.com");
    create({ ownerId: "alice.smith@example.com", title: "Renew the SSL cert" });

    const html = await renderReminders();
    expect(html).toContain("Renew the SSL cert");
    expect(html).not.toContain("Reminders are private");
  });

  it("never shows another user's reminders, even though rows exist for them", async () => {
    mockRequest({ "x-bab-actor-email": "alice.smith@example.com", "x-bab-actor-name": "Alice Smith" });
    const { create } = await import("../lib/todos");
    await seedUser("alice.smith@example.com");
    await seedUser("bob.jones@example.com");
    create({ ownerId: "bob.jones@example.com", title: "Bob's secret reminder" });

    const html = await renderReminders();
    expect(html).not.toContain("Bob's secret reminder");
  });

  it("maps a trusted forge session to reminders by email, not the opaque forge id", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    mockRequest({
      "x-auth-request-user": "forge-oid-999",
      "x-auth-request-email": "carol.jones@example.com",
      "x-auth-request-preferred-username": "Carol Jones",
    });
    const { create } = await import("../lib/todos");
    await seedUser("carol.jones@example.com");
    create({ ownerId: "carol.jones@example.com", title: "Approve the PR" });

    const html = await renderReminders();
    expect(html).toContain("Approve the PR");
  });

  it("shows only the privacy line with no identity at all", async () => {
    mockRequest({});
    const { create } = await import("../lib/todos");
    await seedUser("alice.smith@example.com");
    create({ ownerId: "alice.smith@example.com", title: "Should never render" });

    const html = await renderReminders();
    expect(html).toContain("Reminders are private");
    expect(html).toContain("bab_remind");
    expect(html).not.toContain("Should never render");
  });

  it("shows only the privacy line for an untrusted forge session (BAB_TRUST_FORGE_HEADERS unset)", async () => {
    // Default posture in forge.app.yaml: forge headers present, but not trusted, so
    // getSessionUser() resolves nothing and the page must not guess an owner.
    mockRequest({
      "x-auth-request-user": "forge-oid-999",
      "x-auth-request-email": "carol.jones@example.com",
      "x-auth-request-preferred-username": "Carol Jones",
    });
    const { create } = await import("../lib/todos");
    await seedUser("carol.jones@example.com");
    create({ ownerId: "carol.jones@example.com", title: "Should never render either" });

    const html = await renderReminders();
    expect(html).toContain("Reminders are private");
    expect(html).not.toContain("Should never render either");
  });

  it("shows the empty state for a resolved owner with no reminders", async () => {
    mockRequest({ "x-bab-actor-email": "dana.lee@example.com", "x-bab-actor-name": "Dana Lee" });
    const html = await renderReminders();
    expect(html).toContain("No reminders yet");
  });

  it("has no form and no button: it is read-only", async () => {
    mockRequest({ "x-bab-actor-email": "alice.smith@example.com", "x-bab-actor-name": "Alice Smith" });
    const { create } = await import("../lib/todos");
    await seedUser("alice.smith@example.com");
    create({ ownerId: "alice.smith@example.com", title: "Renew the SSL cert" });

    const html = await renderReminders();
    expect(html).not.toContain("<form");
    // Nothing edits a reminder, and the page no longer carries any browser-link control.
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Unlink");
  });

  // ---------------------------------------------------------------- one-time browser link

  it("points at /me/devices plus the privacy line for a trusted, unlinked Forge viewer (short alias)", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    mockRequest({
      "x-auth-request-user": "forge-oid-pending",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });

    const html = await renderReminders();
    expect(html).toContain(
      'Confirm who you are on <a href="/me/devices">/me/devices</a> to see your reminders here.',
    );
    expect(html).not.toContain("link my BAB browser");
    expect(html).toContain("Reminders are private");
  });

  it("an unlinked viewer sees just the /me/devices line and the privacy line: no form, no button, no link to a devices list", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    mockRequest({
      "x-auth-request-user": "forge-oid-pending",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });
    const html = await renderReminders();
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Your devices");
    expect(html.match(/href="\/me\/devices"/g)).toHaveLength(1);
  });

  it("does NOT offer 'Yes, that is me' here even when the alias matches exactly one person (that lives on /me/devices)", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    await seedUser("alice.example@example.com");
    mockRequest({
      "x-auth-request-user": "forge-oid-suggest",
      "x-auth-request-email": "aexample@example.com",
      "x-auth-request-preferred-username": "Alice Example",
    });

    const html = await renderReminders();
    expect(html).not.toContain("alice.example@example.com");
    expect(html).not.toContain("that&#x27;s me");
    expect(html).not.toContain("<button");
    expect(html).toContain("Confirm who you are on");
    expect(html).toContain('href="/me/devices"');
    expect(html).not.toContain("link my BAB browser");
  });

  it("shows no suggestion when the alias matches nobody", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    mockRequest({
      "x-auth-request-user": "forge-oid-none",
      "x-auth-request-email": "aexample@example.com",
      "x-auth-request-preferred-username": "Alice Example",
    });

    const html = await renderReminders();
    expect(html).not.toContain("that&#x27;s me");
    expect(html).toContain("Confirm who you are on");
    expect(html).toContain("/me/devices");
    expect(html).not.toContain("link my BAB browser");
  });

  it("never shows another person's reminders alongside the /me/devices line", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    mockRequest({
      "x-auth-request-user": "forge-oid-pending",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });
    const { create } = await import("../lib/todos");
    await seedUser("someone.else@example.com");
    create({ ownerId: "someone.else@example.com", title: "Not this viewer's reminder" });

    const html = await renderReminders();
    expect(html).toContain("Confirm who you are on");
    expect(html).toContain("/me/devices");
    expect(html).not.toContain("link my BAB browser");
    expect(html).not.toContain("Not this viewer's reminder");
  });

  it("shows no /me/devices line for a declared (agent-header) actor", async () => {
    mockRequest({ "x-bab-actor-email": "alice.smith@example.com", "x-bab-actor-name": "Alice Smith" });
    await seedUser("alice.smith@example.com");

    const html = await renderReminders();
    expect(html).not.toContain("Confirm who you are on");
  });

  it("shows no /me/devices line for an untrusted Forge session (BAB_TRUST_FORGE_HEADERS unset)", async () => {
    mockRequest({
      "x-auth-request-user": "forge-oid-pending",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });

    const html = await renderReminders();
    expect(html).not.toContain("Confirm who you are on");
    expect(html).toContain("Reminders are private");
  });

  it("shows the viewer's own reminders, not the /me/devices line, once their Forge id is linked", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    await linkForTests("forge-oid-now-linked", "jean.dupont@example.com");

    const { create } = await import("../lib/todos");
    await seedUser("jean.dupont@example.com");
    create({ ownerId: "jean.dupont@example.com", title: "Renew the VPN cert" });

    mockRequest({
      "x-auth-request-user": "forge-oid-now-linked",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });

    const html = await renderReminders();
    expect(html).toContain("Renew the VPN cert");
    expect(html).not.toContain("Confirm who you are on");
  });

  // Owner decision 2026-10-01: devices handle identity now, so the reminders page shows no
  // browser linkage at all. Unlinking lives on /me/devices.
  it("shows a linked Forge viewer only their reminders: no devices link, no unlink form, no 'linked to' line", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    await linkForTests("forge-oid-unlink", "jean.dupont@example.com");
    await seedUser("jean.dupont@example.com");
    const { create } = await import("../lib/todos");
    create({ ownerId: "jean.dupont@example.com", title: "Rotate the signing key" });
    mockRequest({
      "x-auth-request-user": "forge-oid-unlink",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });

    const html = await renderReminders();
    expect(html).toContain("Rotate the signing key");
    expect(html).not.toContain("Your devices");
    expect(html).not.toContain("Unlink");
    expect(html).not.toContain("linked to");
    expect(html).not.toContain("jean.dupont@example.com");
    expect(html).not.toContain("/me/devices");
    expect(html).not.toContain("/reminders/unlink");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });

  it("shows nothing about browsers to a long-form SSO viewer who never linked", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    await seedUser("real.person@example.com");
    mockRequest({
      "x-auth-request-user": "forge-oid-longform",
      "x-auth-request-email": "real.person@example.com",
      "x-auth-request-preferred-username": "Real Person",
    });
    const forgeHtml = await renderReminders();
    for (const text of ["Your devices", "Unlink", "linked to", "/me/devices"]) expect(forgeHtml).not.toContain(text);
  });

  it("shows nothing about browsers to an agent-header actor either", async () => {
    mockRequest({ "x-bab-actor-email": "alice.smith@example.com", "x-bab-actor-name": "Alice Smith" });
    await seedUser("alice.smith@example.com");
    const agentHtml = await renderReminders();
    for (const text of ["Your devices", "Unlink", "linked to", "/me/devices"]) expect(agentHtml).not.toContain(text);
  });

  it("the unlink route and the suggestion component moved off this page", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(new URL("../app/reminders/unlink", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../app/reminders/SuggestLink.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../app/me/devices/SuggestLink.tsx", import.meta.url))).toBe(true);
  });
});

// ------------------------------------------------------------------ app/reminders/format.ts

describe("parseBody / parseInline", () => {
  const text = (parts: { kind: string; text: string }[]) => parts.map((p) => `${p.kind}:${p.text}`);

  it("turns inline numbered steps on one line into an ordered list", async () => {
    const { parseBody } = await import("../app/reminders/format");
    const blocks = parseBody("Do this: 1. Promote the build 2. Watch the job 3. Rerun baselines");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "p" });
    const ol = blocks[1];
    expect(ol.kind).toBe("ol");
    if (ol.kind !== "ol") throw new Error("unreachable");
    expect(ol.items.map((i) => i[0])).toEqual([
      { kind: "text", text: "Promote the build" },
      { kind: "text", text: "Watch the job" },
      { kind: "text", text: "Rerun baselines" },
    ]);
  });

  it("handles steps that start the body, and steps on separate lines", async () => {
    const { parseBody } = await import("../app/reminders/format");
    expect(parseBody("1. one 2. two")).toHaveLength(1);
    const multi = parseBody("1. one\n2. two\n3. three");
    expect(multi).toHaveLength(1);
    expect(multi[0]).toMatchObject({ kind: "ol", start: 1 });
    expect((multi[0] as { items: unknown[] }).items).toHaveLength(3);
  });

  it("does not make a list from a single number or out-of-order numbers", async () => {
    const { parseBody } = await import("../app/reminders/format");
    expect(parseBody("See section 1. Then go on")[0].kind).toBe("p");
    expect(parseBody("Bumped to v2. Then 3. things")[0].kind).toBe("p");
  });

  it("respects line breaks and blank lines", async () => {
    const { parseBody } = await import("../app/reminders/format");
    const blocks = parseBody("line one\nline two\n\nnew paragraph");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "p" });
    expect((blocks[0] as { lines: unknown[] }).lines).toHaveLength(2);
  });

  it("turns '- ' lines into a bullet list", async () => {
    const { parseBody } = await import("../app/reminders/format");
    const blocks = parseBody("Check:\n- alpha\n- beta");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "ul"]);
    expect((blocks[1] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("renders `backtick` spans as code and leaves an unpaired backtick as text", async () => {
    const { parseInline } = await import("../app/reminders/format");
    expect(text(parseInline("run `make it` now"))).toEqual(["text:run ", "code:make it", "text: now"]);
    expect(parseInline("odd ` tick").every((p) => p.kind === "text")).toBe(true);
  });

  it("detects a shell command with ENV assignments and stops at 'and' and the sentence end", async () => {
    const { parseInline } = await import("../app/reminders/format");
    const parts = parseInline(
      "Rerun: CI_ENV=acc python devcheck.py --label a1 and CI_ENV=acc CI_DATASET=b python devcheck.py --label b1. Compare them",
    );
    expect(text(parts)).toEqual([
      "text:Rerun: ",
      "code:CI_ENV=acc python devcheck.py --label a1",
      "text: and ",
      "code:CI_ENV=acc CI_DATASET=b python devcheck.py --label b1",
      "text:. Compare them",
    ]);
  });

  it("detects other common commands", async () => {
    const { parseInline } = await import("../app/reminders/format");
    expect(text(parseInline("then kubectl get pods -n acc please"))).toContain("code:kubectl get pods -n acc please");
    expect(parseInline("pnpm run typecheck").map((p) => p.kind)).toEqual(["code"]);
    expect(text(parseInline("git status, then wait"))).toEqual(["code:git status", "text:, then wait"]);
  });

  it("leaves command words in ordinary prose as text", async () => {
    const { parseInline } = await import("../app/reminders/format");
    for (const s of [
      "git is slow today",
      "Ask az about it",
      "use docker when needed",
      "the python team owns this",
      "CI_ENV=acc alone is not a command",
      "Promote dev.20260929.5 (#239, #240 and #243) to ACC",
    ]) {
      expect(parseInline(s).every((p) => p.kind === "text"), s).toBe(true);
    }
  });

  it("links http(s) URLs, trims trailing punctuation, and ignores other schemes", async () => {
    const { parseInline } = await import("../app/reminders/format");
    const parts = parseInline("See https://example.com/a?b=1, and javascript:alert(1)");
    expect(parts[1]).toEqual({ kind: "link", href: "https://example.com/a?b=1", text: "https://example.com/a?b=1" });
    expect(parts.filter((p) => p.kind === "link")).toHaveLength(1);
  });

  it("keeps #123 refs as plain text", async () => {
    const { parseInline } = await import("../app/reminders/format");
    expect(parseInline("fixed in #239")).toEqual([{ kind: "text", text: "fixed in #239" }]);
  });
});

describe("ReminderBody (render)", () => {
  async function renderBody(body: string) {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: ReminderBody } = await import("../app/reminders/ReminderBody");
    return renderToStaticMarkup(ReminderBody({ text: body }) as never);
  }

  it("renders steps as a real ol, commands as code, links safely", async () => {
    const html = await renderBody("1. Run pnpm run test 2. Open https://example.com/x now");
    expect(html).toContain("<ol");
    expect(html).toContain("<code");
    expect(html).toContain("pnpm run test");
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("never injects HTML: <script> stays visible text", async () => {
    const html = await renderBody("<script>alert(1)</script> and <img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ------------------------------------------------------------------ dueState

describe("dueState", () => {
  it("colours by group, with due-today called out", async () => {
    const { dueState } = await import("../lib/reminders-view");
    expect(dueState("overdue", "2026-09-20", "2026-09-25")).toBe("overdue");
    expect(dueState("dueSoon", "2026-09-25", "2026-09-25")).toBe("today");
    expect(dueState("dueSoon", "2026-09-27", "2026-09-25")).toBe("soon");
    expect(dueState("later", null, "2026-09-25")).toBe("later");
    expect(dueState("done", "2026-09-25", "2026-09-25")).toBe("done");
  });
});

// ------------------------------------------------------------------ page layout

describe("RemindersPage (layout)", () => {
  it("shows group headings with counts, hides empty groups, collapses Done", async () => {
    mockRequest({ "x-bab-actor-email": "alice.smith@example.com", "x-bab-actor-name": "Alice Smith" });
    const { create, complete } = await import("../lib/todos");
    const { todayUtc, addDaysUtc } = await import("../lib/dates");
    const today = todayUtc();
    await seedUser("alice.smith@example.com");
    const o = "alice.smith@example.com";
    create({ ownerId: o, title: "Late A", dueAt: addDaysUtc(today, -3) });
    create({ ownerId: o, title: "Late B", dueAt: addDaysUtc(today, -1) });
    create({ ownerId: o, title: "Today one", dueAt: today, body: "1. First 2. Second" });
    create({ ownerId: o, title: "Far one", dueAt: addDaysUtc(today, 60) });
    complete(create({ ownerId: o, title: "Finished", dueAt: today }).id, o);

    const html = await renderReminders();
    expect(html).toContain("Overdue · 2");
    expect(html).toContain("Due soon · 1");
    expect(html).toContain("Later · 1");
    expect(html).toContain("Done · 1");
    // Done is a native disclosure and is closed by default.
    expect(html).toMatch(/<details(?![^>]*\bopen)[^>]*>/);
    expect(html).toContain("<summary");
    expect(html).toContain('data-state="overdue"');
    expect(html).toContain('data-state="today"');
    expect(html).toContain('data-state="later"');
    expect(html).toContain('data-state="done"');
    expect(html).toContain("<ol");
    expect(html).not.toContain("<button");
  });

  it("hides empty groups", async () => {
    mockRequest({ "x-bab-actor-email": "alice.smith@example.com", "x-bab-actor-name": "Alice Smith" });
    const { create } = await import("../lib/todos");
    await seedUser("alice.smith@example.com");
    create({ ownerId: "alice.smith@example.com", title: "Only later" });

    const html = await renderReminders();
    expect(html).toContain("Later · 1");
    expect(html).not.toContain("Overdue ·");
    expect(html).not.toContain("Due soon ·");
    expect(html).not.toContain("<details");
  });

  it("empty state tells the owner how to add a reminder", async () => {
    mockRequest({ "x-bab-actor-email": "dana.lee@example.com", "x-bab-actor-name": "Dana Lee" });
    const html = await renderReminders();
    expect(html).toContain("Ask your agent: ");
    expect(html).toContain("remind me on Friday");
  });
});

