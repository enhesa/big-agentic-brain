import { describe, it, expect, beforeEach } from "vitest";
import { openPageStream, pageConnected, MAX_STREAMS_PER_VIEWER, _resetPagePresenceForTests } from "../lib/page-presence";

beforeEach(() => _resetPagePresenceForTests());

describe("page presence", () => {
  it("is connected while at least one stream is open, and only for that viewer", () => {
    expect(pageConnected("bob.b@example.com")).toBe(false);
    const close = openPageStream("bob.b@example.com");
    expect(close).not.toBeNull();
    expect(pageConnected("bob.b@example.com")).toBe(true);
    expect(pageConnected("alice.a@example.com")).toBe(false);
    close!();
    expect(pageConnected("bob.b@example.com")).toBe(false);
  });

  it("counts several tabs and stays connected until the last one closes", () => {
    const a = openPageStream("bob.b@example.com")!;
    const b = openPageStream("bob.b@example.com")!;
    a();
    expect(pageConnected("bob.b@example.com")).toBe(true);
    b();
    expect(pageConnected("bob.b@example.com")).toBe(false);
  });

  it("closing twice never goes below zero or closes someone else's stream", () => {
    const a = openPageStream("bob.b@example.com")!;
    const b = openPageStream("bob.b@example.com")!;
    a();
    a();
    expect(pageConnected("bob.b@example.com")).toBe(true);
    b();
    expect(pageConnected("bob.b@example.com")).toBe(false);
  });

  it("refuses a stream past the per-viewer cap and takes it again after one closes", () => {
    const open = Array.from({ length: MAX_STREAMS_PER_VIEWER }, () => openPageStream("bob.b@example.com")!);
    expect(open.every(Boolean)).toBe(true);
    expect(openPageStream("bob.b@example.com")).toBeNull();
    // The cap is per viewer: another person is not affected.
    expect(openPageStream("alice.a@example.com")).not.toBeNull();
    open[0]();
    expect(openPageStream("bob.b@example.com")).not.toBeNull();
  });
});

describe("MAX_STREAMS_PER_VIEWER", () => {
  it("is 20: a person may keep many Inbox tabs open", () => {
    expect(MAX_STREAMS_PER_VIEWER).toBe(20);
  });
});
