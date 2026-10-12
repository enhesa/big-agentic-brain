import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFilterController, SEARCH_DEBOUNCE_MS } from "../app/memory/filter-controller";
import { memoryHref } from "../app/memory/memory-url";
import type { FilterValues } from "../app/memory/memory-url";

const EMPTY: FilterValues = { q: "", tag: "", repo: "", project: "", author: "", status: "", kind: "", applies: "" };

let calls: Array<[string, string]>;
let shown: FilterValues;

function make() {
  return createFilterController({ navigate: (href, mode) => calls.push([href, mode]), current: () => shown });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  shown = EMPTY;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("memoryHref", () => {
  it("is /memory with no filters, and leaves empty ones out", () => {
    expect(memoryHref(EMPTY)).toBe("/memory");
    expect(memoryHref({ ...EMPTY, project: "bab", kind: "standard" })).toBe("/memory?project=bab&kind=standard");
  });
  it("trims the search text, and a blank one is no search", () => {
    expect(memoryHref({ ...EMPTY, q: "  flags " })).toBe("/memory?q=flags");
    expect(memoryHref({ ...EMPTY, q: "   " })).toBe("/memory");
  });
  it("only adds page after the first", () => {
    expect(memoryHref({ ...EMPTY, page: 1 })).toBe("/memory");
    expect(memoryHref({ ...EMPTY, q: "x", page: 3 })).toBe("/memory?q=x&page=3");
  });
});

describe("filter bar controller", () => {
  it("a select change updates the URL at once, as a new history entry", () => {
    make().changed({ ...EMPTY, project: "bab" });
    expect(calls).toEqual([["/memory?project=bab", "push"]]);
  });

  it("typing waits for a pause, then replaces the history entry once", () => {
    const c = make();
    c.typed({ ...EMPTY, q: "f" });
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    c.typed({ ...EMPTY, q: "fl" });
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    c.typed({ ...EMPTY, q: "flags" });
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(calls).toEqual([["/memory?q=flags", "replace"]]);
  });

  it("Enter applies immediately, and the pending pause does not send it again", () => {
    const c = make();
    c.typed({ ...EMPTY, q: "flags" });
    c.submitted({ ...EMPTY, q: "flags" });
    expect(calls).toEqual([["/memory?q=flags", "replace"]]);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(1);
  });

  it("clearing the box clears ?q", () => {
    shown = { ...EMPTY, q: "flags" };
    const c = make();
    c.typed(EMPTY);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    expect(calls).toEqual([["/memory", "replace"]]);
  });

  it("a select change takes the pending search text with it", () => {
    const c = make();
    c.typed({ ...EMPTY, q: "fla" });
    c.changed({ ...EMPTY, q: "fla", kind: "standard" });
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    expect(calls).toEqual([["/memory?q=fla&kind=standard", "push"]]);
  });

  it("does not navigate to the URL the list is already on", () => {
    shown = { ...EMPTY, q: "flags" };
    const c = make();
    c.submitted({ ...EMPTY, q: "flags " });
    c.changed({ ...EMPTY, q: "flags" });
    expect(calls).toEqual([]);
  });

  it("keeps the tag and repo of the page through a change", () => {
    shown = { ...EMPTY, tag: "dev", repo: "bab" };
    make().changed({ ...shown, status: "all" });
    expect(calls).toEqual([["/memory?tag=dev&repo=bab&status=all", "push"]]);
  });

  it("tells our own navigations from a back button", () => {
    const c = make();
    expect(c.arrived("/memory", false)).toBe(false);
    c.changed({ ...EMPTY, q: "a" });
    expect(c.arrived("/memory?q=a", false)).toBe(false);
    // Back to where we started: someone else moved the URL, the bar must follow.
    expect(c.arrived("/memory", false)).toBe(true);
  });

  it("an older result landing while a newer navigation is pending does not count as a back button", () => {
    const c = make();
    c.arrived("/memory", false);
    c.changed({ ...EMPTY, q: "a" });
    c.changed({ ...EMPTY, q: "ab" });
    expect(c.arrived("/memory?q=a", true)).toBe(false);
    expect(c.arrived("/memory?q=ab", false)).toBe(false);
  });

  it("an external arrival drops a pending search", () => {
    const c = make();
    c.arrived("/memory", false);
    c.typed({ ...EMPTY, q: "x" });
    expect(c.arrived("/memory?tag=dev", false)).toBe(true);
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    expect(calls).toEqual([]);
  });
});
