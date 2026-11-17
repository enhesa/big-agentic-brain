import { confirm, keepLearning, retire, getById } from "./learnings";
import { isMaintainer } from "./feedback";
import { ApiError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";

/** The same cap as a flag, confirm, retire or restore note. */
export const REVIEW_NOTE_MAX = 300;

/**
 * The buttons of the maintainer review page (app/memory/review, posted to
 * app/memory/[id]/review): confirm, keep or retire a memory, with a note that says why. They call
 * the same lib functions as bab_react, with via "ui", so the rules are the same: the author cannot
 * confirm their own memory, and the note lands in the validation history (lib/trust.ts). On this
 * page a note is required for all three: a person's decision is evidence too.
 *
 * Maintainers only (BAB_MAINTAINERS), also while the list is unset: then nobody can use the page,
 * and BAB works as before. Agents keep doing the same through bab_react; nothing waits for a person.
 */
export const REVIEW_ACTIONS = ["confirm", "keep", "retire"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const REVIEW_MESSAGES = {
  confirmed: "Confirmed. Your note is in the memory's validation history.",
  kept: "Kept. Your note is in the memory's validation history.",
  retired: "Retired. Your note is in the memory's validation history.",
  note: "Write a note first: where you checked, or why.",
  long: "That note is too long. Keep it to 300 characters or fewer.",
  own: "You cannot confirm your own memory. Ask a colleague to check it.",
  recent: "You confirmed this memory in the last 30 days, so nothing changed and the note was not saved.",
  gone: "This memory no longer exists or is not live any more.",
  invalid: "That action is not one the page offers.",
  slow: "Too many clicks. Wait a minute and try again.",
} as const;

export type ReviewCode = keyof typeof REVIEW_MESSAGES;
export const REVIEW_OK_CODES: readonly ReviewCode[] = ["confirmed", "kept", "retired"];

/** The line for a ?review= value, or null for a missing or unknown one, so a link cannot put its own text on the page. */
export function reviewMessage(code: unknown): { code: ReviewCode; text: string } | null {
  if (typeof code !== "string" || !Object.hasOwn(REVIEW_MESSAGES, code)) return null;
  return { code: code as ReviewCode, text: REVIEW_MESSAGES[code as ReviewCode] };
}

/** Whether this person may use the review page: a maintainer, never anyone else. */
export function mayReview(ownerId: string): boolean {
  return isMaintainer(ownerId);
}

/**
 * Runs one review action for a maintainer. Returns the outcome code. Throws ForbiddenError for
 * anyone who is not a maintainer (the route answers 404, like /admin). Any error that is not an
 * ApiError is a bug and is thrown.
 */
export function runReviewAction(ownerId: string, learningId: string, action: unknown, rawNote: unknown): ReviewCode {
  if (!mayReview(ownerId)) throw new ForbiddenError("Only maintainers can review memories");
  if (typeof action !== "string" || !REVIEW_ACTIONS.includes(action as ReviewAction)) return "invalid";
  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  if (!note) return "note";
  if (note.length > REVIEW_NOTE_MAX) return "long";
  const learning = getById(learningId);
  if (!learning || learning.status === "deleted") return "gone";
  try {
    if (action === "confirm") {
      if (learning.status !== "active") return "gone";
      // A repeat within 30 days (and no flag since) changes nothing, the note included: say so.
      return confirm(learningId, ownerId, note, "ui").changed ? "confirmed" : "recent";
    }
    if (action === "keep") {
      keepLearning(learningId, ownerId, "ui", note);
      return "kept";
    }
    retire(learningId, ownerId, "ui", note);
    return "retired";
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err instanceof ForbiddenError) return "own";
    if (err instanceof NotFoundError || err instanceof ConflictError) return "gone";
    if (err instanceof ValidationError && err.message.includes("characters or fewer")) return "long";
    return "invalid";
  }
}
