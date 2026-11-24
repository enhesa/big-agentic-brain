import { recheck, RECHECK_ANSWERS, RECHECK_NOTE_MAX, type RecheckAnswer } from "./checks";
import { ApiError, ConflictError, NotFoundError, ValidationError } from "./errors";

/**
 * The "Waiting for you" buttons on /memory/review (posted to app/memory/[id]/recheck): Yes, No, Not
 * sure, Let agents check this, Ask me later. Anyone signed in may answer; they call recheck()
 * (lib/checks.ts) with via "ui", so the rules are the same as bab_react recheck. The page has no
 * agent behind it: after a No the memory stays disputed and comes back at the person's next agent
 * session, where their agent helps find the new version.
 */
export const RECHECK_MESSAGES = {
  yes: "Thanks. The memory is marked as checked.",
  no: "Marked as no longer true. Your agent will help find the new version at your next session, or retire it from the memory's page.",
  unsure: "Marked as not sure. Your agent will look for proof at your next session.",
  agent: "Agents will check this memory in real work from now on.",
  later: "Skipped. BAB will not ask about it again for 7 days.",
  note: "Write a note first: where you checked. A Yes on someone else's memory needs one.",
  long: `That note is too long. Keep it to ${RECHECK_NOTE_MAX} characters or fewer.`,
  streak: "You said Yes to your own memory twice in a row. The next check goes to a colleague.",
  recent: "You confirmed this memory in the last 30 days, so nothing changed.",
  gone: "This memory no longer exists or is not live any more.",
  invalid: "That answer is not one the page offers.",
  slow: "Too many clicks. Wait a minute and try again.",
} as const;

export type RecheckCode = keyof typeof RECHECK_MESSAGES;
export const RECHECK_OK_CODES: readonly RecheckCode[] = ["yes", "no", "unsure", "agent", "later", "recent"];

/** The line for a ?check= value, or null for a missing or unknown one, so a link cannot put its own text on the page. */
export function recheckMessage(code: unknown): { code: RecheckCode; text: string } | null {
  if (typeof code !== "string" || !Object.hasOwn(RECHECK_MESSAGES, code)) return null;
  return { code: code as RecheckCode, text: RECHECK_MESSAGES[code as RecheckCode] };
}

/** Runs one answer for a signed-in person and returns the outcome code. Any error that is not an ApiError is a bug and is thrown. */
export function runRecheckAction(ownerId: string, learningId: string, answer: unknown, rawNote: unknown): RecheckCode {
  if (typeof answer !== "string" || !(RECHECK_ANSWERS as readonly string[]).includes(answer)) return "invalid";
  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  if (note.length > RECHECK_NOTE_MAX) return "long";
  try {
    const result = recheck(learningId, ownerId, answer, note || null, "ui");
    if (answer === "yes" && !result.changed) return "recent";
    return answer as RecheckAnswer;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err instanceof NotFoundError) return "gone";
    if (err instanceof ConflictError) return err.message.includes("in a row") ? "streak" : "gone";
    if (err instanceof ValidationError && err.message.startsWith("note is required")) return "note";
    if (err instanceof ValidationError && err.message.includes("characters or fewer")) return "long";
    return "invalid";
  }
}
