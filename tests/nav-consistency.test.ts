import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NAV_ITEMS } from "../app/components/nav-items";

/**
 * The landing page and the inner pages render separate header components, each with its
 * own CSS module. That is deliberate, but it is exactly how the two navbars drifted apart
 * in the first place. These tests keep the LINKS identical and keep a call-to-action pill
 * out of the nav (decided: same navbar everywhere, no button styling).
 */

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("the navbar is the same everywhere", () => {
  it("both headers render the shared list and keep no list of their own", () => {
    for (const file of ["app/components/shell/TopNav.tsx", "app/components/landing/TopBar.tsx"]) {
      const src = read(file);
      expect(src).toContain("NAV_ITEMS");
      expect(src).toContain("nav-items");
      // A second hard-coded list is how they diverged before.
      expect(src).not.toMatch(/const NAV\s*=/);
    }
  });

  it("neither header styles a nav entry as a button", () => {
    for (const file of ["app/components/shell/TopNav.tsx", "app/components/landing/TopBar.tsx"]) {
      expect(read(file)).not.toContain("btnNavy");
    }
  });

  it("both headers know how to hide the Inbox item and badge it", () => {
    for (const file of ["app/components/shell/TopNav.tsx", "app/components/landing/TopBar.tsx"]) {
      const src = read(file);
      expect(src).toContain("useInboxUnread");
      expect(src).toContain("InboxBadge");
    }
    expect(NAV_ITEMS.map((item) => item.href as string)).toContain("/inbox");
  });

  it("the Chats list is gone: no nav item, /conversations sends you to /inbox, thread pages stay", async () => {
    const hrefs = NAV_ITEMS.map((item) => item.href as string);
    expect(hrefs).not.toContain("/conversations");
    const config = (await import("../next.config")).default;
    const redirects = await config.redirects!();
    expect(redirects).toContainEqual({ source: "/conversations", destination: "/inbox", permanent: false });
    expect(existsSync(path.join(process.cwd(), "app/conversations/page.tsx"))).toBe(false);
    expect(existsSync(path.join(process.cwd(), "app/conversations/[threadId]/page.tsx"))).toBe(true);
  });

  it("every item points somewhere real", () => {
    expect(NAV_ITEMS.length).toBeGreaterThan(3);
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("keeps How it works out of the top bar and in the homepage footer, next to News", () => {
    expect(NAV_ITEMS.map((item) => item.href as string)).not.toContain("/docs");
    const footer = read("app/components/landing/Footer.tsx");
    expect(footer).toContain('href="/docs"');
    expect(footer.indexOf('href="/docs"')).toBeLessThan(footer.indexOf('href="/changelog"'));
  });

  it("keeps Feedback out of the top bar and in the homepage footer, after News", () => {
    expect(NAV_ITEMS.map((item) => item.href as string)).not.toContain("/feedback");
    const footer = read("app/components/landing/Footer.tsx");
    expect(footer).toContain('<Link href="/feedback">Feedback</Link>');
    expect(footer.indexOf('href="/changelog"')).toBeLessThan(footer.indexOf('href="/feedback"'));
  });

  it("keeps one bar size at every scroll position: no shrink on scroll", () => {
    for (const file of ["app/components/shell/TopNav.tsx", "app/components/landing/TopBar.tsx"]) {
      const src = read(file);
      expect(src).not.toContain("scrollY");
      expect(src).not.toContain('addEventListener("scroll"');
      expect(src).not.toContain("topbarSmall");
    }
    for (const file of ["app/components/shell/Shell.module.css", "app/landing.module.css"]) {
      expect(read(file)).not.toContain("topbarSmall");
    }
  });
});
