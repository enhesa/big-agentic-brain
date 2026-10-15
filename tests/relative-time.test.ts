import { describe, it, expect } from "vitest";
import { formatExpiry, formatRelativeTime } from "../lib/relative-time";

describe("formatRelativeTime", () => {
  const now = new Date("2026-01-15T12:00:00Z").getTime();

  it("returns 'just now' for under a minute", () => {
    expect(formatRelativeTime("2026-01-15T11:59:30Z", now)).toBe("just now");
  });

  it("returns minutes ago", () => {
    expect(formatRelativeTime("2026-01-15T11:57:00Z", now)).toBe("3 min ago");
  });

  it("returns hours ago", () => {
    expect(formatRelativeTime("2026-01-15T09:00:00Z", now)).toBe("3 hr ago");
  });

  it("returns days ago, pluralized", () => {
    expect(formatRelativeTime("2026-01-13T12:00:00Z", now)).toBe("2 days ago");
    expect(formatRelativeTime("2026-01-14T12:00:00Z", now)).toBe("1 day ago");
  });

  it("falls back to a date beyond a week", () => {
    const result = formatRelativeTime("2026-01-01T12:00:00Z", now);
    expect(result).not.toContain("ago");
  });

  it("returns the raw string for an unparseable date", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("not-a-date");
  });
});

describe("formatExpiry", () => {
  it("says valid for N more days, valid until today, or past its valid-until date", () => {
    expect(formatExpiry(30)).toBe("valid for 30 more days");
    expect(formatExpiry(1)).toBe("valid for 1 more day");
    expect(formatExpiry(0)).toBe("valid until today");
    expect(formatExpiry(-3)).toBe("past its valid-until date");
  });

  it("has nothing to show without a valid-until date", () => {
    expect(formatExpiry(null)).toBeNull();
  });
});
