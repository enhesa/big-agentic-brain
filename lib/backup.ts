import { getDb, resolveDataDir } from "./db";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Forge platform guidance (2026-09-25): the nightly backup (02:30 UTC) copies files off
 * this pod's volume while the app keeps running. A raw copy of a WAL-mode SQLite database
 * taken mid-write can be torn/inconsistent, so Forge's ask is: "if you use SQLite, write a
 * consistent snapshot next to it on a schedule (VACUUM INTO '/data/snapshot.db') and the
 * backup picks that up too." This module is that schedule; nothing did it before.
 */
const SNAPSHOT_FILENAME = "snapshot.db";
const SNAPSHOT_TEMP_FILENAME = "snapshot.db.tmp";

/**
 * "At most once per ~24h", run early enough to sit comfortably ahead of the 02:30 UTC
 * backup rather than racing it. 20h keeps that margin without being so far under 24h that
 * a slightly-late trigger one day snowballs into two snapshots the next.
 */
const SNAPSHOT_STALE_MS = 20 * 60 * 60 * 1000;

function dataDir(): string {
  return resolveDataDir();
}

function snapshotPath(): string {
  return path.join(dataDir(), SNAPSHOT_FILENAME);
}

function tempSnapshotPath(): string {
  return path.join(dataDir(), SNAPSHOT_TEMP_FILENAME);
}

/** No snapshot yet counts as infinitely stale, so a fresh deploy takes one right away. */
function snapshotAgeMs(): number {
  try {
    return Date.now() - statSync(snapshotPath()).mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * In-process guard against two overlapping callers (e.g. two requests each firing
 * scheduleMaintenance() before the first VACUUM INTO finishes). Forge's guidance for
 * in-app jobs is to guard with a DB claim, but this app is a single pod with no other
 * process ever touching bab.db, so this boolean plus the on-disk snapshot's own mtime
 * (persists across restarts, unlike a module-level timestamp) is an equivalent guard
 * without adding a lock table for a job that only ever runs on one instance.
 */
let snapshotInProgress = false;

/**
 * Writes a fresh, consistent snapshot of the live database to `snapshot.db` next to it,
 * for the nightly backup to pick up. VACUUM INTO refuses to write over a file that
 * already exists, so this targets a temp name first and renames it over `snapshot.db`
 * afterwards — rename is atomic within a directory, so a backup (or anything else) that
 * opens `snapshot.db` mid-run either sees the old complete snapshot or the new complete
 * one, never a partial file.
 */
function writeSnapshot(): void {
  const db = getDb();
  const tmpPath = tempSnapshotPath();

  // A previous run that died between VACUUM INTO and the rename (crash, OOM-kill) leaves
  // this behind; VACUUM INTO would otherwise refuse to target it.
  if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });

  db.prepare("VACUUM INTO ?").run(tmpPath);
  renameSync(tmpPath, snapshotPath());
}

/**
 * Call this from wherever maintenance is already opportunistically triggered
 * (lib/maintenance.ts's runMaintenance()) rather than standing up a separate timer.
 * No-ops unless the last snapshot is more than SNAPSHOT_STALE_MS old, and never throws:
 * a backup hiccup must not take down the request path that happened to trigger it.
 */
export function maybeSnapshotBackup(): void {
  if (snapshotInProgress) return;
  if (snapshotAgeMs() < SNAPSHOT_STALE_MS) return;

  snapshotInProgress = true;
  try {
    writeSnapshot();
  } catch (err) {
    console.error("maybeSnapshotBackup failed", err);
  } finally {
    snapshotInProgress = false;
  }
}

/** Test-only: resets the in-process guard so a test can force a re-entrant call. */
export function _resetSnapshotGuardForTests(): void {
  snapshotInProgress = false;
}
