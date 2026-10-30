/**
 * Makes sure only one BAB process serves the key-value store on one data volume. The store is a
 * Map in one process: a second process on the same data would have a map of its own, and two agents
 * could both get the same lock. BAB_REPLICAS is the operator's word; this is the check.
 *
 * The first process to use the store writes DATA_DIR/kv.lease (its host, pid and a random instance
 * id) and refreshes it every KV_LEASE_HEARTBEAT_MS. Another process refuses the store while that
 * file is fresh (younger than KV_LEASE_STALE_MS) and names another live instance. A stale lease (a
 * crashed process) is taken over; so is one from the same host name whose pid is ours or no longer
 * runs (a container restart in the same pod). A clean shutdown removes the lease, so the next pod
 * starts at once.
 *
 * Limits, in docs/kv.md: two processes that start within the same moment can both write the file;
 * the loser notices at its next heartbeat and stops serving. Overlapping pods (a rolling update)
 * share nothing, so the new pod refuses the store until the old one is gone; BAB's chart uses
 * Recreate with a ReadWriteOnce volume, so they do not overlap.
 */
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { resolveDataDir } from "./db";

export const KV_LEASE_HEARTBEAT_MS = 10_000;
export const KV_LEASE_STALE_MS = 30_000;

interface LeaseFile {
  instance: string;
  host: string;
  pid: number;
  at: number;
}

interface LeaseState {
  instance: string;
  held: boolean;
  timer?: ReturnType<typeof setInterval>;
}

const GLOBAL_KEY = "__babKvLease";
type Holder = { [GLOBAL_KEY]?: LeaseState };

function state(): LeaseState {
  const g = globalThis as Holder;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { instance: randomBytes(12).toString("hex"), held: false };
  return g[GLOBAL_KEY]!;
}

export function leasePath(): string {
  return path.join(resolveDataDir(), "kv.lease");
}

function readLease(): LeaseFile | null {
  try {
    const parsed = JSON.parse(readFileSync(leasePath(), "utf8")) as Partial<LeaseFile>;
    if (typeof parsed.instance !== "string" || typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
    return { instance: parsed.instance, host: String(parsed.host ?? ""), pid: Number(parsed.pid ?? 0), at: parsed.at };
  } catch {
    return null;
  }
}

function body(st: LeaseState): string {
  return JSON.stringify({ instance: st.instance, host: hostname(), pid: process.pid, at: Date.now() } satisfies LeaseFile);
}

/** True when another live process holds the lease. */
function otherHolder(st: LeaseState, lease: LeaseFile | null): boolean {
  if (!lease || lease.instance === st.instance) return false;
  if (Date.now() - lease.at > KV_LEASE_STALE_MS || lease.at > Date.now() + KV_LEASE_STALE_MS) return false;
  if (lease.host === hostname()) {
    // Our own pid: this process started the store again, or a container restarted with the same pid 1.
    if (lease.pid === process.pid) return false;
    // Another pid on this host holds it only while that process is alive.
    return pidAlive(lease.pid);
  }
  return true;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function heartbeat(): void {
  const st = state();
  if (!st.held) return;
  const lease = readLease();
  if (lease && lease.instance !== st.instance) {
    // Someone else wrote the file since our last beat: stop serving rather than run two maps.
    st.held = false;
    console.warn("bab: another BAB process took the key-value lease; this process stops serving the key-value store until it restarts.");
    return;
  }
  try {
    writeFileSync(leasePath(), body(st), { mode: 0o600 });
  } catch (err) {
    console.warn("bab: could not refresh the key-value lease: " + (err as Error).message);
  }
}

/** Why ensureKvLease refused: another live process holds the lease, or this one cannot write it. */
export type KvLeaseResult = "held" | "other" | "unwritable";

/**
 * Takes the lease when nobody else holds it, or keeps it. Returns "held" when this process may
 * serve the store. Synchronous, and cheap once held.
 */
export function ensureKvLease(): KvLeaseResult {
  const st = state();
  if (st.held) return "held";
  const file = leasePath();
  const lease = readLease();
  if (otherHolder(st, lease)) return "other";
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (lease === null) {
      try {
        // Exclusive create: of two processes starting at once, only one gets the file.
        const fd = openSync(file, "wx", 0o600);
        try {
          writeSync(fd, body(st));
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const now = readLease();
        if (otherHolder(st, now) || now === null) return "other";
        writeFileSync(file, body(st), { mode: 0o600 });
      }
    } else {
      writeFileSync(file, body(st), { mode: 0o600 });
    }
    if (readLease()?.instance !== st.instance) return "other";
  } catch (err) {
    console.warn("bab: could not take the key-value lease: " + (err as Error).message);
    return "unwritable";
  }
  st.held = true;
  if (!st.timer) {
    st.timer = setInterval(heartbeat, KV_LEASE_HEARTBEAT_MS);
    st.timer.unref?.();
  }
  return "held";
}

/** True while this process holds the lease. */
export function holdsKvLease(): boolean {
  return state().held;
}

/** Gives the lease up on a clean shutdown, so the next process can start at once. */
export function releaseKvLease(): void {
  const st = state();
  if (!st.held) return;
  st.held = false;
  try {
    if (readLease()?.instance === st.instance) rmSync(leasePath(), { force: true });
  } catch {
    // ignore
  }
}

/** Test-only: forget the lease state and stop its timer (the file stays). */
export function _resetKvLeaseForTests(): void {
  const g = globalThis as Holder;
  const st = g[GLOBAL_KEY];
  if (st?.timer) clearInterval(st.timer);
  delete g[GLOBAL_KEY];
}

/** Test-only: run one heartbeat now. */
export function _kvLeaseHeartbeatForTests(): void {
  heartbeat();
}
