import { describe, it, expect, afterEach } from "vitest";

describe("checkRateLimit", () => {
  afterEach(async () => {
    const { resetForTests } = await import("../lib/rate-limit");
    resetForTests();
  });

  it("has the raised limits: BAB is internal, so only a runaway loop is stopped", async () => {
    const r = await import("../lib/rate-limit");
    expect(r.RATE_LIMIT_PER_MINUTE).toBe(2000);
    expect(r.UI_RATE_LIMIT_PER_MINUTE).toBe(2000);
    expect(r.ANON_RATE_LIMIT_PER_MINUTE).toBe(1000);
  });

  it("allows up to RATE_LIMIT_PER_MINUTE requests/minute per actor, then blocks the next", async () => {
    const { checkRateLimit, RATE_LIMIT_PER_MINUTE, _setClockForTests } = await import("../lib/rate-limit");
    let now = 0;
    _setClockForTests(() => now);

    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      expect(checkRateLimit("actor-1")).toBe(true);
    }
    expect(checkRateLimit("actor-1")).toBe(false);
  });

  it("the anonymous bucket has its own, lower limit", async () => {
    const { checkRateLimit, ANON_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_MINUTE, _setClockForTests } = await import("../lib/rate-limit");
    _setClockForTests(() => 0);
    for (let i = 0; i < ANON_RATE_LIMIT_PER_MINUTE; i++) expect(checkRateLimit("anon:1.2.3.4", ANON_RATE_LIMIT_PER_MINUTE)).toBe(true);
    expect(checkRateLimit("anon:1.2.3.4", ANON_RATE_LIMIT_PER_MINUTE)).toBe(false);
    expect(ANON_RATE_LIMIT_PER_MINUTE).toBeLessThan(RATE_LIMIT_PER_MINUTE);
  });

  it("keeps the browser bucket apart from the agent bucket for the same person", async () => {
    const { checkRateLimit, checkUiRateLimit, RATE_LIMIT_PER_MINUTE, UI_RATE_LIMIT_PER_MINUTE, _setClockForTests } = await import("../lib/rate-limit");
    _setClockForTests(() => 0);
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) expect(checkRateLimit("person-1")).toBe(true);
    expect(checkRateLimit("person-1")).toBe(false);
    expect(checkUiRateLimit("person-1")).toBe(true);
    for (let i = 0; i < UI_RATE_LIMIT_PER_MINUTE - 1; i++) checkUiRateLimit("person-1");
    expect(checkUiRateLimit("person-1")).toBe(false);
    expect(checkRateLimit("person-2")).toBe(true);
  });

  it("resets once the window rolls over", async () => {
    const { checkRateLimit, RATE_LIMIT_PER_MINUTE, _setClockForTests } = await import("../lib/rate-limit");
    let now = 0;
    _setClockForTests(() => now);

    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) checkRateLimit("actor-2");
    expect(checkRateLimit("actor-2")).toBe(false);

    now += 60_001;
    expect(checkRateLimit("actor-2")).toBe(true);
  });

  it("tracks each actor independently", async () => {
    const { checkRateLimit, RATE_LIMIT_PER_MINUTE, _setClockForTests } = await import("../lib/rate-limit");
    let now = 0;
    _setClockForTests(() => now);

    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) checkRateLimit("busy-actor");
    expect(checkRateLimit("busy-actor")).toBe(false);
    expect(checkRateLimit("quiet-actor")).toBe(true);
  });
});
