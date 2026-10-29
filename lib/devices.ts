import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db";
import { config } from "./config";
import { audit } from "./audit";
import { isMaintainer } from "./feedback";

/**
 * Devices (the device linking design, superseded in part by the
 * honour-system identify addendum). A device is one plugin install. It carries a 256-bit secret
 * that the plugin's headers helper sends as `X-Bab-Device`; only the sha256 of that secret is
 * stored, and a request is matched by hash lookup. 256 random bits cannot be guessed or
 * brute-forced offline, so a slow password hash would add cost and no safety.
 *
 * A device becomes someone when its client calls bab_identify (lib/identify.ts) with a work
 * address. Identity is an honour system: the deployment must sit on a private network,
 * behind an authenticating proxy, or use bound tokens. Any
 * client may say who it is, and a device bound to one person may be rebound to another (audited
 * as device-rebind). "Forgetting" a device (revokeDevice) makes it unknown again; identifying
 * binds it again.
 *
 * Never log a secret or its hash, never put either in an audit row; the device id (random,
 * unrelated to the secret) is what names a device in the UI and in audit details.
 */

export const DEVICE_HEADER = "x-bab-device";
export const DEVICE_LABEL_HEADER = "x-bab-device-label";
/** last_seen_at is written at most this often per device, so reads do not become writes. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_LABEL = "Unknown device";

const SECRET_RE = /^[0-9a-f]{64}$/;

let clock: () => number = () => Date.now();

/**
 * BAB_DEVICES=0 is the kill switch: device secrets and MCP connections are ignored as identity,
 * so only the X-Bab-Actor-* headers decide (and bab_identify cannot remember anyone).
 */
export function devicesEnabled(): boolean {
  return config().devices;
}

/**
 * sha256 hex of a device secret, or null when the value is not exactly 64 lowercase hex
 * characters. A malformed value is treated as absent, never as an error.
 */
export function hashSecret(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !SECRET_RE.test(value)) return null;
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The label the plugin helper sends (for example "MINGW64_NT-10.0 LAPTOP-123"), reduced to
 * letters, digits, space, dot, dash and underscore, at most 60 characters. It only names the
 * device in the lists; it never takes part in identity.
 */
export function deviceLabelFrom(h: Headers): string {
  const clean = (h.get(DEVICE_LABEL_HEADER) ?? "")
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return clean || DEFAULT_LABEL;
}

export interface DeviceRow {
  id: string;
  userId: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  boundViaProxyId: string | null;
}

interface RawDevice {
  id: string;
  user_id: string;
  label: string;
  created_at: number;
  last_seen_at: number | null;
  bound_via_proxy_id: string | null;
}

/**
 * The live (not forgotten) device behind a secret hash, or null. last_seen_at is refreshed here,
 * at most every LAST_SEEN_WRITE_INTERVAL_MS.
 */
export function lookupDevice(secretHash: string): DeviceRow | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, user_id, label, created_at, last_seen_at, bound_via_proxy_id FROM devices WHERE secret_hash = ? AND revoked_at IS NULL",
    )
    .get(secretHash) as RawDevice | undefined;
  if (!row) return null;

  const now = clock();
  let lastSeenAt = row.last_seen_at;
  // Read above, write only when stale: a hot device must not take the write lock per request.
  if (lastSeenAt === null || lastSeenAt <= now - LAST_SEEN_WRITE_INTERVAL_MS) {
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, row.id);
    lastSeenAt = now;
  }
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt,
    boundViaProxyId: row.bound_via_proxy_id,
  };
}

export interface BoundDevice {
  deviceId: string;
  /** Who the device belonged to before (live or forgotten), null for a brand new one. */
  previousUserId: string | null;
}

/**
 * Binds the device behind a secret hash to a person: creates it, or updates the row that already
 * has this hash (live and bound to someone else, or forgotten) in place, because secret_hash is
 * unique. The honour system lets any caller rebind; the caller (lib/identify.ts) audits that. The
 * address is only shown to the owner on /me/devices.
 */
export function bindDevice(secretHash: string, userId: string, label: string, ip: string | null): BoundDevice {
  const db = getDb();
  const now = clock();
  const existing = db.prepare("SELECT id, user_id FROM devices WHERE secret_hash = ?").get(secretHash) as
    | { id: string; user_id: string }
    | undefined;
  if (existing) {
    db.prepare(
      `UPDATE devices SET user_id = ?, label = ?, revoked_at = NULL, connected_ip = ?, bound_via_proxy_id = NULL,
         created_at = CASE WHEN user_id = ? AND revoked_at IS NULL THEN created_at ELSE ? END
       WHERE id = ?`,
    ).run(userId, label, ip, userId, now, existing.id);
    return { deviceId: existing.id, previousUserId: existing.user_id };
  }
  const deviceId = randomBytes(8).toString("hex");
  db.prepare(
    "INSERT INTO devices (id, user_id, secret_hash, label, created_at, last_seen_at, connected_ip) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(deviceId, userId, secretHash, label, now, now, ip);
  return { deviceId, previousUserId: null };
}

export interface DeviceSummary {
  id: string;
  userId: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  /** The address the device last said who it was from. */
  connectedIp: string | null;
}

const SUMMARY_COLUMNS = "id, user_id, label, created_at, last_seen_at, connected_ip";

function summary(r: Record<string, unknown>): DeviceSummary {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    label: r.label as string,
    createdAt: r.created_at as number,
    lastSeenAt: (r.last_seen_at as number | null) ?? null,
    connectedIp: (r.connected_ip as string | null) ?? null,
  };
}

/** The user's live devices, newest first. Never carries the hash. */
export function listDevices(userId: string): DeviceSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM devices
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC`,
    )
    .all(userId) as Record<string, unknown>[];
  return rows.map(summary);
}

/** Every live device, newest first, for the maintainer page. Callers check maintainership. */
export function listAllDevices(): DeviceSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM devices
       WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(summary);
}

/**
 * Forgets one live device (the former "revoke"). Allowed for its owner and for a maintainer;
 * false when it is unknown, already forgotten or not the actor's to forget (the same answer for
 * all three, so an id says nothing about someone else's devices). A forgotten device is simply
 * unknown again; its next bab_identify binds it.
 */
export function revokeDevice(id: string, actor: { id: string; name?: string | null; email?: string | null }): boolean {
  const db = getDb();
  const row = db.prepare("SELECT user_id FROM devices WHERE id = ? AND revoked_at IS NULL").get(id) as
    | { user_id: string }
    | undefined;
  if (!row) return false;
  if (row.user_id !== actor.id.trim().toLowerCase() && !isMaintainer(actor.id)) return false;

  const res = db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(clock(), id);
  if (Number(res.changes ?? 0) === 0) return false;
  audit(db, actor, "device-revoke", "device", id, "ui", { details: { owner: row.user_id } });
  return true;
}

/** Forgets every live device of this user (lost laptop, leaver). Returns how many. */
export function revokeDevicesForUser(userId: string): number {
  const res = getDb()
    .prepare("UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(clock(), userId);
  return Number(res.changes ?? 0);
}

/**
 * Forgets every live device that an earlier release connected through one browser link (called
 * when that link is removed). New devices are bound by bab_identify and carry no browser link.
 */
export function revokeDevicesBoundVia(proxyUserId: string): number {
  const res = getDb()
    .prepare("UPDATE devices SET revoked_at = ? WHERE bound_via_proxy_id = ? AND revoked_at IS NULL")
    .run(clock(), proxyUserId);
  return Number(res.changes ?? 0);
}

/**
 * Forgets devices not seen for config().retention.staleAfterDays (BAB_STALE_AFTER_DAYS) (or never seen and bound that long ago): a
 * leaver's laptop stops working without anyone remembering to forget it. Run by the hourly
 * maintenance sweep. A device still in use refreshes last_seen_at at least every 5 minutes, so
 * only dead ones match. Returns how many.
 */
export function revokeStaleDevices(maxAgeDays: number = config().retention.staleAfterDays): number {
  const now = clock();
  const db = getDb();
  const res = db
    .prepare("UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL AND COALESCE(last_seen_at, created_at) < ?")
    .run(now, now - maxAgeDays * DAY_MS);
  const n = Number(res.changes ?? 0);
  // One row per run with the count, not one per device: the hourly sweep must not flood the log.
  if (n > 0) audit(db, "system", "device-expire", "device", "sweep", "ui", { details: { count: n, maxAgeDays } });
  return n;
}

/** How long a person's sessions hear about a newly connected device. */
export const DEVICE_NOTICE_DAYS = 7;

/**
 * Records that a device was newly connected as `userId` when that person already had another live
 * device or a linked browser, so their sessions hear about it (app/api/hook/route.ts). The first
 * device of a person with nothing else is not recorded: there is nobody else to tell. Returns true
 * when a notice was recorded. Called by bab_identify only for a new binding (a brand new device, or
 * one that was someone else's), never for the same device identifying again.
 */
export function noteNewDevice(userId: string, deviceId: string, label: string): boolean {
  const db = getDb();
  const otherDevice = db.prepare("SELECT 1 FROM devices WHERE user_id = ? AND id != ? AND revoked_at IS NULL LIMIT 1").get(userId, deviceId);
  const browser = db.prepare("SELECT 1 FROM proxy_links WHERE user_id = ? LIMIT 1").get(userId);
  if (!otherDevice && !browser) return false;
  db.prepare("INSERT INTO device_bind_notices (user_id, device_id, label, created_at) VALUES (?, ?, ?, ?)").run(userId, deviceId, label, clock());
  return true;
}

export interface DeviceNotice {
  id: number;
  label: string;
  createdAt: number;
}

/** Device notices for this person from the last DEVICE_NOTICE_DAYS days, newest first. */
export function recentDeviceNotices(userId: string, now: number = clock()): DeviceNotice[] {
  return (
    getDb()
      .prepare("SELECT id, label, created_at FROM device_bind_notices WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT 20")
      .all(userId, now - DEVICE_NOTICE_DAYS * DAY_MS) as { id: number; label: string; created_at: number }[]
  ).map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at }));
}

/** Test-only: inject a fake clock. Reset by passing nothing. */
export function _setDeviceClockForTests(fn?: () => number): void {
  clock = fn ?? (() => Date.now());
}
