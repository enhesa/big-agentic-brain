import { headers } from "next/headers";
import { getDb } from "./db";
import { audit } from "./audit";
import { redact } from "./redact";
import { scheduleMaintenance } from "./maintenance";
import { clientIp } from "./client-ip";
import type { AuditVia } from "./types";
import type { SessionUser } from "./session";

export interface AuditRequestInput {
  /** null for the read-only UI, which needs no identity of its own. */
  actor: (Pick<SessionUser, "id" | "name" | "email"> & { source?: SessionUser["source"] }) | null;
  method: string;
  path: string;
  via: AuditVia;
  /**
   * For high-frequency polls that say nothing new (the inbox list, polled every 15 seconds per open
   * session by a Claude Code mod): write the row only if this identity has no such row for this path
   * in the last `minutes`. The row carries `coalesce: 1` so only other coalesced rows count; an
   * ordinary call to the same path is always written. Never for an anonymous caller.
   */
  coalesce?: { minutes: number };
  /** Extra audit details, merged with the identity source (for example a device error code). */
  details?: Record<string, unknown>;
}

const ANONYMOUS_ACTOR = { id: "anonymous", name: null, email: null };

/**
 * Writes one audit_log row per data page render / server action / API call, and returns its id
 * (null when nothing was written: a coalesced poll, or a logging failure).
 * Never throws: a logging failure must not break the request it describes.
 */
export async function auditRequest(input: AuditRequestInput): Promise<number | null> {
  // Page views trigger the hourly sweeps and the daily backup copy too, not only agent
  // traffic, so a day with no agent calls still gets them (review, 2026-09-25).
  scheduleMaintenance();
  try {
    const h = await headers();
    // The same definition of "the caller's address" the rate limits and the device list use (lib/client-ip.ts).
    const ip = clientIp(h);

    const actor = input.actor
      ? { id: input.actor.id, name: input.actor.name, email: input.actor.email }
      : ANONYMOUS_ACTOR;

    const db = getDb();
    if (input.coalesce && input.actor) {
      const recent = db
        .prepare(
          `SELECT 1 FROM audit_log WHERE actor_id = ? AND path = ? AND entity = 'request'
             AND json_extract(details, '$.coalesce') = 1 AND at > datetime('now', ?) LIMIT 1`,
        )
        .get(actor.id, input.path, `-${input.coalesce.minutes} minutes`);
      if (recent) return null;
    }
    // details.source tells header callers from device callers, for the P1.4 admin page.
    const merged = { ...(input.actor?.source ? { source: input.actor.source } : {}), ...(input.coalesce && input.actor ? { coalesce: 1 } : {}), ...input.details };
    const details = Object.keys(merged).length > 0 ? merged : undefined;
    return audit(db, actor, input.method, "request", input.path, input.via, { ip, path: input.path, details });
  } catch (err) {
    console.error("auditRequest failed", err);
    return null;
  }
}

/** The most query text a search audit row keeps, after redaction. */
export const SEARCH_QUERY_MAX = 120;
/** Longer query text is not stored at all: redact() is never handed more than this. */
const SEARCH_QUERY_RAW_MAX = 4000;

/**
 * Adds what a search found to its own audit row (written before the search ran): `results`, the
 * number of matches, and `q`, the query text after redact(), cut to SEARCH_QUERY_MAX characters.
 * The query is never stored unredacted. Other details on the row (source, cx) are kept.
 * /usage reads these for "Found nothing". Never throws.
 */
export function recordSearchOutcome(auditId: number | null | undefined, outcome: { results: number; query?: string }): void {
  if (auditId == null) return;
  try {
    // Redact the text as it came, line breaks included (a "key: value" line is masked only on its
    // own line), and only then tidy the spaces and cut it.
    const raw = outcome.query ?? "";
    const q =
      raw.trim() && raw.length <= SEARCH_QUERY_RAW_MAX ? redact(raw).replace(/\s+/g, " ").trim().slice(0, SEARCH_QUERY_MAX).trim() : "";
    const results = Math.max(0, Math.trunc(outcome.results));
    getDb()
      .prepare(
        q
          ? "UPDATE audit_log SET details = json_set(COALESCE(details, '{}'), '$.results', ?, '$.q', ?) WHERE id = ?"
          : "UPDATE audit_log SET details = json_set(COALESCE(details, '{}'), '$.results', ?) WHERE id = ?",
      )
      .run(...(q ? [results, q, auditId] : [results, auditId]));
  } catch (err) {
    console.error("recordSearchOutcome failed", err);
  }
}
