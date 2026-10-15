import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

describe("Shell", () => {
  it("is read-only: no identity block, no sign-out, no whoami link", async () => {
    const { default: Shell } = await import("../app/components/shell/Shell");
    const html = renderToStaticMarkup(Shell({ children: <div>content</div> }));

    expect(html).not.toContain('href="/whoami"');
    expect(html).not.toContain("/__proxy/logout");
    // The note that used to say so was removed; the property is
    // still that nothing here writes: no form, no button that posts.
    expect(html).not.toContain("<form");
    // No control at all in the shell: the notification bell that used to be the one
    // allowed button was removed, so nothing on every page can act.
    expect(html).not.toContain("<button");
  });

  it("nav is Memory, Inbox, Reminders, Feedback, News, Usage and Get started", async () => {
    const { default: Shell } = await import("../app/components/shell/Shell");
    const html = renderToStaticMarkup(Shell({ children: <div>content</div> }));

    expect(html).toContain('href="/memory"');
    expect(html).not.toContain('href="/conversations"');
    expect(html).toContain('href="/inbox"');
    expect(html).toContain('href="/reminders"');
    expect(html).not.toContain('href="/people"');
    expect(html).toContain('href="/#get-started"');
    expect(html).toContain('href="/changelog"');
    expect(html).not.toContain('href="/todos"');
  });

  it("renders the Inbox item with no badge until the browser knows a count", async () => {
    // The count comes from GET /inbox/unread in the browser, and BAB_INBOX_PAGE=0 hides the item
    // there too, because a statically rendered page would freeze an env read at build time.
    const { default: Shell } = await import("../app/components/shell/Shell");
    const html = renderToStaticMarkup(Shell({ children: <div>content</div> }));
    expect(html).toContain(">Inbox</a>");
    expect(html).not.toContain("unread");
  });

  it("InboxBadge shows a count only when there is one", async () => {
    const { default: InboxBadge } = await import("../app/components/shell/InboxBadge");
    expect(renderToStaticMarkup(InboxBadge({ count: 0 }))).toBe("");
    expect(renderToStaticMarkup(InboxBadge({ count: 3 }))).toContain('aria-label="3 unread"');
    expect(renderToStaticMarkup(InboxBadge({ count: 250 }))).toContain(">99+<");
  });
});
