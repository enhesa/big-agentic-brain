/**
 * The caller's network address, defined once, for the audit log (lib/request-audit.ts), the
 * rate limits and the address shown next to a device. Since the honour-system identity
 * nothing decides access by it. BAB_CLIENT_IP_HEADER affects what the audit log
 * records and what the limits key on; the per-IP caps (event streams, new identities) apply only
 * when it is set (clientIpVerified()).
 *
 * Which header carries the real address depends on the proxy in front of the app, and a client
 * can set either header itself if the proxy passes it through. So the operator says which one
 * the proxy really sets, once verified: BAB_CLIENT_IP_HEADER = "x-real-ip" or
 * "x-forwarded-for-rightmost". Only that header is read then. While it is unset (or not one of
 * those two) the address is a best guess, good for display and rate limits and nothing else:
 * clientIpVerified() is false and describeIp() marks it "(unverified)".
 *
 * The best guess is X-Real-IP when present, else the RIGHT-most X-Forwarded-For entry: each
 * proxy appends the address it saw to the end, so the right-most entry is the one the closest
 * (trusted) proxy added, while the left-most is whatever the caller wrote. A present but
 * malformed value is "unknown", not a reason to fall through to a header the caller can
 * influence. Values that do not look like an address are dropped rather than stored.
 */

import { config } from "./config";

const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;

export type ClientIpMode = "x-real-ip" | "x-forwarded-for-rightmost";

let warnedAbout: string | null = null;

/** The configured trusted header, or null when unset or unrecognised (never "verified"). An unrecognised value warns once. */
export function clientIpMode(): ClientIpMode | null {
  const c = config();
  if (c.clientIpHeaderInvalid !== null && warnedAbout !== c.clientIpHeaderInvalid) {
    warnedAbout = c.clientIpHeaderInvalid;
    console.warn(`bab: BAB_CLIENT_IP_HEADER=${JSON.stringify(c.clientIpHeaderInvalid)} is not "x-real-ip" or "x-forwarded-for-rightmost"; client addresses stay unverified`);
  }
  return c.clientIpHeader;
}

/** Test hook. */
export function _resetClientIpWarningForTests(): void {
  warnedAbout = null;
}

export function clientIpVerified(): boolean {
  return clientIpMode() !== null;
}

function realIp(h: Headers): string | null {
  const real = h.get("x-real-ip")?.trim();
  return real && IP_RE.test(real) ? real : null;
}

function rightmostForwarded(h: Headers): string | null {
  const forwarded = (h.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const last = forwarded[forwarded.length - 1];
  return last && IP_RE.test(last) ? last : null;
}

export function clientIp(h: Headers): string | null {
  const mode = clientIpMode();
  if (mode === "x-real-ip") return realIp(h);
  if (mode === "x-forwarded-for-rightmost") return rightmostForwarded(h);

  // Unverified best guess. A present but junk X-Real-IP stays unknown.
  if (h.get("x-real-ip")?.trim()) return realIp(h);
  return rightmostForwarded(h);
}

/** An address as a person should read it: unknown, or the address with a note when nobody verified it. */
export function describeIp(ip: string | null): string {
  if (!ip) return "unknown";
  return clientIpVerified() ? ip : `${ip} (unverified)`;
}
