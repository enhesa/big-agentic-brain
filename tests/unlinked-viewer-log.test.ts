import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  noteUnlinkedViewer,
  _resetUnlinkedViewerLogForTests,
  UNLINKED_VIEWER_LOG_WINDOW_MS,
  UNLINKED_VIEWER_LOG_MAX_KEYS,
} from "../lib/unlinked-viewer-log";

const T0 = Date.UTC(2026, 9, 6, 9, 0, 0);
const REASON = "short alias or other domain";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  _resetUnlinkedViewerLogForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("noteUnlinkedViewer", () => {
  it("logs a viewer once per hour, then once more with how often they were seen", () => {
    expect(noteUnlinkedViewer("proxy-id-1", REASON, T0)).toContain("1 such viewer in the last hour");
    for (let i = 1; i <= 5; i++) expect(noteUnlinkedViewer("proxy-id-1", REASON, T0 + i * 60_000)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const later = noteUnlinkedViewer("proxy-id-1", REASON, T0 + UNLINKED_VIEWER_LOG_WINDOW_MS);
    expect(later).toContain("this viewer was seen 6 times since their last note");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("keeps a returning viewer's count when other viewers were logged in between", () => {
    noteUnlinkedViewer("proxy-id-1", REASON, T0);
    noteUnlinkedViewer("proxy-id-1", REASON, T0 + 1000);
    noteUnlinkedViewer("proxy-id-2", REASON, T0 + UNLINKED_VIEWER_LOG_WINDOW_MS + 1000);
    const back = noteUnlinkedViewer("proxy-id-1", REASON, T0 + UNLINKED_VIEWER_LOG_WINDOW_MS + 2000);
    expect(back).toContain("this viewer was seen 2 times since their last note");
    expect(back).toContain("2 such viewers in the last hour");
  });

  it("logs each distinct viewer, with a running count of such viewers in the last hour", () => {
    noteUnlinkedViewer("proxy-id-1", REASON, T0);
    const second = noteUnlinkedViewer("proxy-id-2", REASON, T0 + 1000);
    expect(second).toContain("2 such viewers in the last hour");
    // An hour after the first, only the second is still within the hour.
    const third = noteUnlinkedViewer("proxy-id-3", REASON, T0 + UNLINKED_VIEWER_LOG_WINDOW_MS);
    expect(third).toContain("2 such viewers in the last hour");
  });

  it("never logs the id, the address or its hash", async () => {
    const { createHash } = await import("node:crypto");
    const id = "aexample@example.com";
    const line = noteUnlinkedViewer(id, REASON, T0) ?? "";
    expect(line).toContain(REASON);
    expect(line).not.toContain(id);
    expect(line).not.toContain("aexample");
    expect(line).not.toContain(createHash("sha256").update(id).digest("hex"));
    expect(line).not.toContain(createHash("sha256").update(id).digest("hex").slice(0, 8));
  });

  it("stays bounded: past the cap the oldest viewers are dropped", () => {
    for (let i = 0; i <= UNLINKED_VIEWER_LOG_MAX_KEYS; i++) noteUnlinkedViewer(`proxy-id-${i}`, REASON, T0 + i);
    const line = noteUnlinkedViewer("proxy-id-new", REASON, T0 + UNLINKED_VIEWER_LOG_MAX_KEYS + 1) ?? "";
    expect(line).toContain(`${UNLINKED_VIEWER_LOG_MAX_KEYS} such viewers in the last hour`);
    // The very first one was dropped, so it is noted again at once.
    expect(noteUnlinkedViewer("proxy-id-0", REASON, T0 + UNLINKED_VIEWER_LOG_MAX_KEYS + 2)).not.toBeNull();
  });
});
