import { parseDbTime } from "./dates";
// import type only: learnings.ts imports this module for standingsFor(), so a value import here
// would be a cycle.
import type { LearningVoteCounts } from "./learnings";
import type { LearningRow } from "./types";

export type StandingLevel = "strong" | "fair" | "weak";

export interface StandingInput extends LearningVoteCounts {
  /** votes.created_at of the newest confirm, SQLite datetime text. */
  lastConfirmAt: string | null;
  /** Entries this one superseded; 0 confirmations (or absent) adds no phrase. */
  replaced?: { entries: number; confirmations: number };
  /**
   * Points inherited from the one entry this one corrects, including what that entry inherited
   * in turn (see carryOver). Computed by the caller, so this function stays pure; 0 or absent
   * adds nothing.
   */
  carried?: number;
}

/**
 * The two "how much to trust this" signals have different sources and must never read as one:
 * standing is computed from colleagues' reactions, the author's confidence is what the author
 * typed when writing. Every surface (list, detail page, API and tool descriptions) uses these
 * names, so a reader sees the same words everywhere.
 */
export const STANDING_LABEL = "Standing";
export const CONFIDENCE_LABEL = "Author's confidence";

/** "Standing: weak (no reactions yet)". `reason` is left out where there is no room for it. */
export function standingText(level: StandingLevel, reason?: string): string {
  return reason ? `${STANDING_LABEL}: ${level} (${reason})` : `${STANDING_LABEL}: ${level}`;
}

/** "Author's confidence: high". */
export function confidenceText(confidence: string): string {
  return `${CONFIDENCE_LABEL}: ${confidence}`;
}

export interface Standing {
  standing: StandingLevel;
  standingReason: string;
  points: number;
}

export const STANDING_STRONG_AT = 6;
export const STANDING_FAIR_AT = 2;
export const STANDING_STALE_DAYS = 180;
/** The most a correction can inherit from the entry it replaces. */
export const STANDING_CARRY_CAP = 4;

const DAY_MS = 86_400_000;
const LEVELS: StandingLevel[] = ["weak", "fair", "strong"];

/** The points the votes alone give: no mirror bonus, no carry. */
function votePoints(votes: LearningVoteCounts): number {
  return 2 * votes.confirm + votes.helpful + 2 * votes.kudos - votes.not_helpful - 3 * votes.flag;
}

/**
 * What a correction inherits from the single entry it replaces: half of that entry's positive
 * points, rounded down, at most STANDING_CARRY_CAP. Negative points never carry. The entry's
 * points are its own votes plus what it carried itself (`oldCarried`, itself the result of this
 * function for the entry before it), so standing survives a chain A -> B -> C: B passes on half
 * of (its own points + what it got from A), not just half of its own votes. Only the votes
 * count, so a Confluence mirror's bonus cannot be passed on to an entry that is not a mirror. A
 * consolidation of several entries carries nothing (the caller does not ask).
 */
export function carryOver(oldVotes: LearningVoteCounts, oldCarried = 0): number {
  const points = votePoints(oldVotes) + (oldCarried > 0 ? oldCarried : 0);
  return points > 0 ? Math.min(STANDING_CARRY_CAP, Math.floor(points / 2)) : 0;
}

/**
 * Derived on read from the votes, so it needs no ranking column and cannot drift from them.
 * No note text is an input, so it cannot reach `standingReason` (by construction).
 *
 * `authorIsMaintainer` gates the Confluence bonus: `source` is a claim any author can write, so
 * only an entry by a maintainer (the owner's seeding run, BAB_MAINTAINERS) counts as a verified
 * mirror. Left out it means false, so a missing lookup fails closed instead of handing out +2.
 */
export function computeStanding(
  votes: StandingInput,
  learning: Pick<LearningRow, "source" | "created_at"> & { authorIsMaintainer?: boolean },
  now: number = Date.now(),
): Standing {
  const verifiedMirror = learning.source === "confluence" && learning.authorIsMaintainer === true;
  const carried = votes.carried && votes.carried > 0 ? votes.carried : 0;
  const points = votePoints(votes) + (verifiedMirror ? 2 : 0) + carried;
  let rank = points >= STANDING_STRONG_AT ? 2 : points >= STANDING_FAIR_AT ? 1 : 0;

  const lastConfirmMs = votes.lastConfirmAt ? parseDbTime(votes.lastConfirmAt).getTime() : 0;
  const newestMs = Math.max(parseDbTime(learning.created_at).getTime(), lastConfirmMs);
  // Strictly over: exactly 180 days old is still current. An entry nobody has looked at in half a
  // year loses one level, so a stale "strong" cannot coast on old confirmations.
  const stale = now - newestMs > STANDING_STALE_DAYS * DAY_MS;
  if (stale) rank = Math.max(0, rank - 1);

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (votes.confirm > 0 && votes.lastConfirmAt) {
    const days = Math.max(0, Math.floor((now - lastConfirmMs) / DAY_MS));
    parts.push(
      `${plural(votes.confirm, "confirmation", "confirmations")}, last ${days === 0 ? "today" : `${plural(days, "day", "days")} ago`}`,
    );
  }
  if (votes.flag > 0) parts.push(plural(votes.flag, "flag", "flags"));
  if (verifiedMirror) parts.push("mirrors a Confluence page");
  if (stale) parts.push(`not refreshed in over ${STANDING_STALE_DAYS} days`);
  if (votes.replaced && votes.replaced.confirmations > 0) {
    const e = votes.replaced.entries;
    parts.push(
      `replaces ${e === 1 ? "an entry" : `${e} entries`} with ${plural(votes.replaced.confirmations, "confirmation", "confirmations")}`,
    );
  }
  if (carried > 0) parts.push(`carries ${carried} from the entry it replaces`);
  return { standing: LEVELS[rank], standingReason: parts.length ? parts.join(", ") : "no reactions yet", points };
}
