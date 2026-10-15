import { describe, it, expect, afterEach, vi } from "vitest";
import { clientIp, clientIpMode, clientIpVerified, describeIp, _resetClientIpWarningForTests } from "../lib/client-ip";
import { _resetConfigForTests } from "@/lib/config";

/**
 * One definition of "the caller's address", shared by the audit log and the connect link
 * (lib/client-ip.ts). The RIGHT-most X-Forwarded-For entry is the one the closest proxy
 * appended; the left-most is whatever the caller claimed, so it is never trusted.
 */
describe("clientIp", () => {
  it("prefers X-Real-IP over X-Forwarded-For", () => {
    expect(clientIp(new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 192.0.2.9" }))).toBe("203.0.113.7");
  });

  it("takes the RIGHT-most X-Forwarded-For entry, not the left-most (which the caller can fake)", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.1, 192.0.2.9" }))).toBe("192.0.2.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "192.0.2.9" }))).toBe("192.0.2.9");
  });

  it("ignores empty entries and whitespace", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": " 198.51.100.1 ,  , 192.0.2.9 ," }))).toBe("192.0.2.9");
  });

  it("is null with neither header", () => {
    expect(clientIp(new Headers())).toBeNull();
    expect(clientIp(new Headers({ "x-forwarded-for": " , " }))).toBeNull();
  });

  it("accepts IPv6", () => {
    expect(clientIp(new Headers({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("refuses junk instead of storing it", () => {
    expect(clientIp(new Headers({ "x-real-ip": "<script>alert(1)</script>" }))).toBeNull();
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, not an ip at all" }))).toBeNull();
    expect(clientIp(new Headers({ "x-real-ip": "1".repeat(80) }))).toBeNull();
  });

  it("a present but junk X-Real-IP does not fall through to the forwarded header", () => {
    expect(clientIp(new Headers({ "x-real-ip": "junk!", "x-forwarded-for": "192.0.2.9" }))).toBeNull();
  });
});

/**
 * BAB_CLIENT_IP_HEADER (security review round 3, H1): X-Real-IP and X-Forwarded-For can be
 * spoofed by a client if the proxy passes them through, so the operator says which one the
 * proxy really sets. Until then the address is only for display and limits.
 */
describe("BAB_CLIENT_IP_HEADER", () => {
  afterEach(() => {
    delete process.env.BAB_CLIENT_IP_HEADER;
    _resetConfigForTests();
    vi.restoreAllMocks();
  });
  const both = () => new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6, 192.0.2.9" });

  it("unset: the best guess is still recorded, but it is not verified", () => {
    expect(clientIpMode()).toBeNull();
    expect(clientIpVerified()).toBe(false);
    expect(clientIp(both())).toBe("203.0.113.7");
  });

  it("x-real-ip: only that header counts", () => {
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    _resetConfigForTests();
    expect(clientIpMode()).toBe("x-real-ip");
    expect(clientIpVerified()).toBe(true);
    expect(clientIp(both())).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "192.0.2.9" }))).toBeNull();
  });

  it("x-forwarded-for-rightmost: only the right-most entry counts", () => {
    process.env.BAB_CLIENT_IP_HEADER = "x-forwarded-for-rightmost";
    _resetConfigForTests();
    expect(clientIpMode()).toBe("x-forwarded-for-rightmost");
    expect(clientIpVerified()).toBe(true);
    expect(clientIp(both())).toBe("192.0.2.9");
    expect(clientIp(new Headers({ "x-real-ip": "203.0.113.7" }))).toBeNull();
  });

  it("any other value is treated as unset, warns once, never reads as verified", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    _resetClientIpWarningForTests();
    process.env.BAB_CLIENT_IP_HEADER = "X-Real-IP-ish";
    _resetConfigForTests();
    expect(clientIpMode()).toBeNull();
    expect(clientIpVerified()).toBe(false);
    expect(clientIpMode()).toBeNull();
    const about = warn.mock.calls.filter((c) => String(c[0]).includes("BAB_CLIENT_IP_HEADER"));
    expect(about).toHaveLength(1);
  });

  it("the value is case-insensitive", () => {
    process.env.BAB_CLIENT_IP_HEADER = "X-Real-IP";
    _resetConfigForTests();
    expect(clientIpMode()).toBe("x-real-ip");
  });

  it("describeIp labels an address nobody verified", () => {
    expect(describeIp(null)).toBe("unknown");
    expect(describeIp("192.0.2.9")).toBe("192.0.2.9 (unverified)");
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    _resetConfigForTests();
    expect(describeIp("192.0.2.9")).toBe("192.0.2.9");
    expect(describeIp(null)).toBe("unknown");
  });
});
