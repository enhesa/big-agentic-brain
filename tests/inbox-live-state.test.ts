import { describe, it, expect } from "vitest";
import {
  badgeLabel,
  parseUnreadResponse,
  UNREAD_EVENT,
  inboxTitle,
  faviconDotHref,
  nextStatus,
  isSilent,
  statusText,
  SILENCE_MS,
  type LiveStatus,
} from "../lib/inbox-live-state";

describe("inboxTitle", () => {
  it("is the plain name with nothing unread and (n) Inbox otherwise", () => {
    expect(inboxTitle(0)).toBe("Inbox");
    expect(inboxTitle(1)).toBe("(1) Inbox");
    expect(inboxTitle(2)).toBe("(2) Inbox");
    expect(inboxTitle(99)).toBe("(99) Inbox");
  });

  it("caps a long count and ignores anything that is not a positive whole number", () => {
    expect(inboxTitle(100)).toBe("(99+) Inbox");
    expect(inboxTitle(5000)).toBe("(99+) Inbox");
    expect(inboxTitle(-3)).toBe("Inbox");
    expect(inboxTitle(Number.NaN)).toBe("Inbox");
    expect(inboxTitle(Number.POSITIVE_INFINITY)).toBe("Inbox");
    expect(inboxTitle(2.7)).toBe("(2) Inbox");
  });

  it("is built from the count alone: no text can reach the title", () => {
    expect(inboxTitle("</title><script>" as unknown as number)).toBe("Inbox");
  });
});

describe("faviconDotHref", () => {
  it("is null with nothing unread, so the normal icon stays", () => {
    expect(faviconDotHref(0, "#1a3360")).toBeNull();
    expect(faviconDotHref(-1, "#1a3360")).toBeNull();
  });

  it("is an SVG data URL with the brand mark and a dot when something is unread", () => {
    const href = faviconDotHref(3, "#123456")!;
    expect(href.startsWith("data:image/svg+xml,")).toBe(true);
    const svg = decodeURIComponent(href.slice("data:image/svg+xml,".length));
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('data-dot="unread"');
    expect(svg).not.toContain("<script");
  });
});

describe("nextStatus", () => {
  const cases: [LiveStatus, Parameters<typeof nextStatus>[1], LiveStatus][] = [
    ["connecting", "open", "live"],
    ["reconnecting", "open", "live"],
    ["reconnecting", "message", "live"],
    ["live", "message", "live"],
    ["live", "error-retrying", "reconnecting"],
    ["connecting", "error-retrying", "reconnecting"],
    ["live", "error-closed", "stopped"],
    ["reconnecting", "error-closed", "stopped"],
    ["live", "silence", "reconnecting"],
    ["stopped", "open", "live"],
    ["stopped", "error-retrying", "reconnecting"],
  ];
  it.each(cases)("%s on %s becomes %s", (prev, event, expected) => {
    expect(nextStatus(prev, event)).toBe(expected);
  });
});

describe("isSilent", () => {
  it("is true only once nothing has arrived for longer than the silence limit", () => {
    expect(isSilent(1000, 1000 + SILENCE_MS)).toBe(false);
    expect(isSilent(1000, 1000 + SILENCE_MS + 1)).toBe(true);
    expect(isSilent(1000, 1000)).toBe(false);
  });

  it("allows for the 20 second ping: the limit is well above it", () => {
    expect(SILENCE_MS).toBeGreaterThan(3 * 20_000);
  });
});

describe("statusText", () => {
  it("says one plain sentence per state, and what to do when it stopped", () => {
    expect(statusText("live")).toBe("Live");
    expect(statusText("connecting")).toBe("Connecting");
    expect(statusText("reconnecting")).toBe("Reconnecting");
    expect(statusText("stopped")).toMatch(/Reload/);
    expect(statusText("stopped")).toMatch(/sign in again/i);
  });
});

describe("badgeLabel", () => {
  it("is empty for nothing, the number up to 99 and 99+ after", () => {
    expect(badgeLabel(0)).toBe("");
    expect(badgeLabel(-2)).toBe("");
    expect(badgeLabel(Number.NaN)).toBe("");
    expect(badgeLabel(3)).toBe("3");
    expect(badgeLabel(99)).toBe("99");
    expect(badgeLabel(100)).toBe("99+");
  });
});

describe("parseUnreadResponse", () => {
  it("reads the count from a 200", () => {
    expect(parseUnreadResponse(200, { unread: 4 })).toEqual({ count: 4, off: false });
    expect(parseUnreadResponse(200, { unread: 0 })).toEqual({ count: 0, off: false });
  });

  it("is null on a 429, so the badge keeps its last value instead of clearing", () => {
    expect(parseUnreadResponse(429, { error: "Too many requests" })).toBeNull();
    expect(parseUnreadResponse(429, null)).toBeNull();
  });

  it("hides the nav item on a 503, which is the kill switch", () => {
    expect(parseUnreadResponse(503, { error: "switched off" })).toEqual({ count: 0, off: true });
  });

  it("shows no badge, and keeps the item, for a 401, a login page or a body it does not know", () => {
    expect(parseUnreadResponse(401, { error: "Sign in" })).toEqual({ count: 0, off: false });
    expect(parseUnreadResponse(200, null)).toEqual({ count: 0, off: false });
    expect(parseUnreadResponse(200, "<html>login</html>")).toEqual({ count: 0, off: false });
    expect(parseUnreadResponse(200, { unread: "5" })).toEqual({ count: 0, off: false });
    expect(parseUnreadResponse(200, { unread: -1 })).toEqual({ count: 0, off: false });
    expect(parseUnreadResponse(500, { unread: 5 })).toEqual({ count: 0, off: false });
  });

  it("uses one shared event name", () => {
    expect(UNREAD_EVENT).toBe("bab:inbox-unread");
  });
});
