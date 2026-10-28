import { MEMORY_COMMENT_DAILY_LIMIT, MEMORY_COMMENT_MAX } from "./memory-comments";
import { ForbiddenError, NotFoundError, TooManyRequestsError, ValidationError } from "./errors";

/**
 * The fixed outcome codes of the memory page's vote and comment forms (app/memory/[id]/react and
 * app/memory/[id]/comments/[commentId]). The routes redirect back with ?react=<code>; the page shows
 * the line for a known code and ignores anything else, so a crafted link can never put its own text
 * on the page.
 */
export const REACT_MESSAGES = {
  done: "Thanks, your vote is saved.",
  same: "Your vote was already saved. Pick the other button to change it.",
  commented: "Thanks, your comment is posted.",
  "voted-commented": "Thanks, your vote and your comment are saved.",
  edited: "Your comment is updated.",
  removed: "The comment is removed.",
  link: "Link your browser on /me/devices first, then you can vote and comment.",
  own: "You cannot vote on your own memory. You can still comment.",
  empty: "Write a comment first.",
  long: `That comment is too long. Keep it to ${MEMORY_COMMENT_MAX} characters or fewer.`,
  limit: `You posted ${MEMORY_COMMENT_DAILY_LIMIT} comments today. Try again tomorrow.`,
  "not-yours": "You can only change your own comments.",
  gone: "This memory or comment no longer exists.",
  slow: "Too many clicks. Wait a minute and try again.",
  invalid: "That action is not one the page offers.",
} as const;

export type ReactCode = keyof typeof REACT_MESSAGES;

/** The codes that report a success, shown in the calm style. */
export const REACT_OK_CODES: readonly ReactCode[] = ["done", "same", "commented", "voted-commented", "edited", "removed"];

/** The line for a ?react= value, or null for a missing or unknown one. */
export function reactMessage(code: unknown): { code: ReactCode; text: string } | null {
  if (typeof code !== "string" || !Object.hasOwn(REACT_MESSAGES, code)) return null;
  return { code: code as ReactCode, text: REACT_MESSAGES[code as ReactCode] };
}

/**
 * The code for a refusal from lib/learnings vote() or lib/memory-comments. Only ApiError refusals
 * reach here; the route lets anything else surface as a bug.
 */
export function refusalCode(err: unknown): ReactCode {
  if (err instanceof TooManyRequestsError) return "limit";
  if (err instanceof NotFoundError) return "gone";
  if (err instanceof ForbiddenError) return "not-yours";
  if (err instanceof ValidationError) {
    if (err.message === "comment is required") return "empty";
    if (err.message.endsWith("characters or fewer")) return "long";
  }
  return "invalid";
}
