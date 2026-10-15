import { describe, it, expect } from "vitest";
import { todayUtc, addDaysUtc, toCalendarDate, isCalendarDate } from "../lib/dates";

describe("dates.todayUtc", () => {
  it("returns a YYYY-MM-DD calendar date", () => {
    expect(todayUtc()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("dates.addDaysUtc", () => {
  it("adds positive days within a month", () => {
    expect(addDaysUtc("2026-01-01", 5)).toBe("2026-01-06");
  });

  it("subtracts (negative) days", () => {
    expect(addDaysUtc("2026-01-10", -5)).toBe("2026-01-05");
  });

  it("rolls over a month boundary", () => {
    expect(addDaysUtc("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("rolls over a year boundary", () => {
    expect(addDaysUtc("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles a leap-year February correctly", () => {
    // 2028 is a leap year
    expect(addDaysUtc("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysUtc("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("handles a non-leap-year February correctly", () => {
    expect(addDaysUtc("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("a zero-day add is a no-op", () => {
    expect(addDaysUtc("2026-06-15", 0)).toBe("2026-06-15");
  });

  it("tolerates a full ISO datetime as input, truncating to the date part first", () => {
    expect(addDaysUtc("2026-06-15T23:59:59.000Z", 1)).toBe("2026-06-16");
  });
});

describe("dates.toCalendarDate", () => {
  it("passes through an already-calendar-date string unchanged", () => {
    expect(toCalendarDate("2026-06-15")).toBe("2026-06-15");
  });

  it("truncates a legacy full ISO datetime to the date part", () => {
    expect(toCalendarDate("2026-06-15T10:30:00.000Z")).toBe("2026-06-15");
  });
});

describe("parseDbTime", () => {
  it("treats SQLite datetime('now') output as UTC", async () => {
    const { parseDbTime } = await import("../lib/dates");
    expect(parseDbTime("2026-09-16 15:43:49").toISOString()).toBe("2026-09-16T15:43:49.000Z");
  });
  it("leaves zoned ISO strings alone", async () => {
    const { parseDbTime } = await import("../lib/dates");
    expect(parseDbTime("2026-09-16T15:43:49.000Z").getTime()).toBe(Date.UTC(2026, 8, 16, 15, 43, 49));
  });
  it("relative time is not shifted by the local timezone", async () => {
    const { formatRelativeTime } = await import("../lib/relative-time");
    const now = Date.UTC(2026, 8, 16, 15, 45, 0);
    expect(formatRelativeTime("2026-09-16 15:43:49", now)).toBe("1 min ago");
  });
});

describe("dates.isCalendarDate", () => {
  it("accepts real calendar days, including a leap day", () => {
    expect(isCalendarDate("2026-10-15")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2026-12-31")).toBe(true);
  });

  it("rejects impossible days that only pass the format", () => {
    for (const s of ["2026-13-01", "2026-02-30", "2026-02-29", "2026-13-45", "2026-00-10", "2026-04-31", "2026-01-00"]) {
      expect(isCalendarDate(s), s).toBe(false);
    }
  });

  it("rejects other formats and non-strings", () => {
    for (const s of ["", "tomorrow", "2026-1-5", "2026-10-15T00:00:00Z", " 2026-10-15", "20261015"]) {
      expect(isCalendarDate(s), s).toBe(false);
    }
    expect(isCalendarDate(undefined)).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
    expect(isCalendarDate(20261015)).toBe(false);
  });
});
