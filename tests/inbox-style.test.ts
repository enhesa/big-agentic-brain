import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
const globals = read("app/globals.css");
const inbox = read("app/inbox/inbox.module.css");
const thread = read("app/conversations/conversations.module.css");
const reminders = read("app/reminders/reminders.module.css");

/** Every rule for the selector in one stylesheet. A selector that is gone fails the test. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = css.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`, "g"));
  expect(found, `${selector} has a rule`).not.toBeNull();
  return found!.join("\n");
}

/** The body of one `@media (...) { ... }` block, found by its condition. */
function media(css: string, condition: string): string {
  const start = css.indexOf(`@media ${condition}`);
  expect(start, `@media ${condition} exists`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`@media ${condition} is not closed`);
}

/** The class names a component reads from its stylesheet, `styles.name` and `styles[\`live_${x}\`]`. */
function used(file: string): { names: string[]; prefixes: string[] } {
  const source = read(file);
  return {
    names: [...new Set([...source.matchAll(/styles\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))],
    prefixes: [...source.matchAll(/styles\[`([A-Za-z_]+)\$\{/g)].map((m) => m[1]),
  };
}

function expectDefined(css: string, files: string[]) {
  for (const file of files) {
    const { names, prefixes } = used(file);
    expect(names.length, `${file} uses the stylesheet`).toBeGreaterThan(0);
    for (const name of names) expect(css, `${file} uses .${name}`).toMatch(new RegExp(`\\.${name}\\b`));
    for (const prefix of prefixes) expect(css, `${file} uses .${prefix}*`).toMatch(new RegExp(`\\.${prefix}[a-z]+\\b`));
  }
}

describe("Inbox, a thread and Reminders on paper", () => {
  it("the shared card is a sheet, so every page that draws one stands on the same paper", () => {
    const card = rule(globals, ".card");
    expect(card).toContain("background: var(--sheet)");
    expect(card).toContain("border: 1px solid var(--hairline)");
    expect(card).toContain("border-radius: var(--sheet-radius)");
  });

  it("no white or grey of its own is a background on these pages", () => {
    for (const css of [inbox, thread, reminders]) {
      expect(css).not.toMatch(/background(-color)?:\s*(#fff|#ffffff|white|rgba?\(255,\s*255,\s*255)\b/i);
    }
  });

  it("the thread list is one sheet with a hairline between rows", () => {
    const list = rule(inbox, ".list");
    expect(list).toContain("background: var(--sheet)");
    expect(list).toContain("var(--hairline)");
    expect(list).toContain("border-radius: var(--sheet-radius)");
    expect(rule(inbox, ".list li + li")).toContain("border-top: 1px solid var(--hairline)");
    // An inbox without threads draws no empty box.
    expect(rule(inbox, ".list:empty")).toMatch(/border:\s*none/);
  });

  it("a row's focus ring is drawn inside the sheet that clips it, and follows its corners", () => {
    expect(rule(inbox, ".list")).toContain("overflow: hidden");
    const focus = rule(inbox, ".row:focus-visible");
    expect(focus).toContain("outline: 3px solid var(--teal-ink)");
    expect(focus).toMatch(/outline-offset:\s*-\d+px/);
    expect(rule(inbox, ".list li:first-child .row")).toContain("border-top-left-radius: var(--sheet-radius)");
    expect(rule(inbox, ".list li:last-child .row")).toContain("border-bottom-right-radius: var(--sheet-radius)");
  });

  it("the open thread is marked by a surface and an edge, an unread one by weight and a count", () => {
    const on = rule(inbox, ".rowOn,\n.rowOn:hover");
    expect(on).toContain("background: var(--sand)");
    expect(on).toContain("var(--navy)");
    expect(rule(inbox, ".rowUnread .rowTitle")).toContain("font-weight: 700");
    expect(inbox).not.toMatch(/\.rowUnread\s*\{/);
  });

  it("a subject and its last message show two lines, and a long word cannot widen the row", () => {
    for (const selector of [".rowTitle", ".snippet"]) {
      const text = rule(inbox, selector);
      expect(text, selector).toContain("-webkit-line-clamp: 2");
      expect(text, selector).toContain("overflow-wrap: anywhere");
    }
    expect(rule(inbox, ".row")).toContain("minmax(0, 1fr)");
    expect(rule(inbox, ".threadTitle")).toContain("overflow-wrap: anywhere");
  });

  it("the two voices in a thread are told apart by side and by surface", () => {
    const bubble = rule(thread, ".bubble");
    expect(bubble).toContain("background: var(--sheet)");
    expect(bubble).toContain("var(--hairline)");
    expect(bubble).toContain("overflow-wrap: anywhere");
    expect(rule(thread, ".msgRight .bubble")).toContain("background: var(--sand)");
    expect(rule(thread, ".msgLeft")).toContain("align-self: flex-start");
    expect(rule(thread, ".msgRight")).toContain("align-self: flex-end");
    // Small grey text keeps its full colour: no opacity that drops it under the contrast floor.
    expect(rule(thread, ".msgWhen")).not.toContain("opacity");
  });

  it("every class a component asks for exists, in the Inbox, a thread and Reminders", () => {
    expectDefined(inbox, ["app/inbox/page.tsx", "app/inbox/InboxLive.tsx", "app/inbox/AutoOpenApp.tsx"]);
    expectDefined(thread, ["app/conversations/ThreadTimeline.tsx", "app/conversations/[threadId]/page.tsx"]);
    expectDefined(reminders, ["app/reminders/page.tsx", "app/reminders/ReminderBody.tsx"]);
  });

  it("a phone gets one column and wider messages", () => {
    expect(media(inbox, "(max-width: 760px)")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(media(thread, "(max-width: 640px)")).toMatch(/\.msg\s*\{\s*max-width:\s*92%/);
  });

  it("reminders keep a reading width, and their panels are sand", () => {
    expect(rule(reminders, ".group")).toMatch(/max-width:\s*760px/);
    expect(rule(reminders, ".code")).toContain("background: var(--sand)");
    expect(rule(reminders, ".body")).toContain("var(--hairline)");
  });

  it("nothing moves for a reader who asked for less motion", () => {
    expect(media(inbox, "(prefers-reduced-motion: reduce)")).toMatch(/\.row\s*\{\s*transition:\s*none/);
    const still = media(thread, "(prefers-reduced-motion: reduce)");
    expect(still).toMatch(/animation:\s*none/);
    expect(still).toMatch(/opacity:\s*1/);
  });
});
