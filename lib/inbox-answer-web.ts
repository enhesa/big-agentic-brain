import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { ANSWER_NOTE_MAX } from "./messages";

/**
 * The fixed outcome codes of the Inbox answer form (app/inbox/answer). The route redirects back
 * with ?answered=<code>; the page shows the line for a known code and ignores anything else, so a
 * crafted link can never put its own text on the page.
 */
export const ANSWER_MESSAGES = {
  saved: "Thanks, your answer is sent.",
  changed: "Your answer is changed.",
  link: "Link your browser on /me/devices first, then you can answer.",
  slow: "Too many clicks. Wait a minute and try again.",
  gone: "That question no longer exists.",
  "not-yours": "Only a person the question was sent to can answer it.",
  long: `That note is too long. Keep it to ${ANSWER_NOTE_MAX} characters or fewer.`,
  invalid: "Pick one of the options and try again.",
} as const;

export type AnswerCode = keyof typeof ANSWER_MESSAGES;

export const ANSWER_OK_CODES: readonly AnswerCode[] = ["saved", "changed"];

/** The line for an ?answered= value, or null for a missing or unknown one. */
export function answerMessage(code: unknown): { code: AnswerCode; text: string } | null {
  if (typeof code !== "string" || !Object.hasOwn(ANSWER_MESSAGES, code)) return null;
  return { code: code as AnswerCode, text: ANSWER_MESSAGES[code as AnswerCode] };
}

/** The code for a refusal from answerRequest. Only ApiError refusals reach here. */
export function answerRefusalCode(err: unknown): AnswerCode {
  if (err instanceof NotFoundError) return "gone";
  if (err instanceof ForbiddenError) return "not-yours";
  if (err instanceof ValidationError && err.message.endsWith("characters or fewer")) return "long";
  return "invalid";
}
