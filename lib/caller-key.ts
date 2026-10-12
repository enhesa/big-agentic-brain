import { createHash } from "node:crypto";

/**
 * A short label for the device or MCP connection behind a call, stored in audit details as `cx`
 * so /admin/usage can count distinct sessions and spot identify loops. A device is named by its
 * random device id (never its secret or the secret's hash: lib/devices.ts). A connection id is an
 * identity credential (it is remembered as a person), so it is hashed and cut to 8 hex characters
 * rather than stored as it is.
 */
export function callerKey(deviceId: string | null | undefined, connectionId: string | null | undefined): string | null {
  if (deviceId) return `d:${deviceId}`;
  if (connectionId) return `c:${createHash("sha256").update(connectionId).digest("hex").slice(0, 8)}`;
  return null;
}
