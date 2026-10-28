import { KUDOS_NOTE_MAX } from "./learnings";

/**
 * The fixed outcome codes of the memory page's reaction buttons (app/memory/[id]/react). The route
 * redirects back with ?react=<code>; the page shows the line for a known code and ignores anything
 * else, so a crafted link can never put its own text on the page.
 */
export const REACT_MESSAGES = {
  done: "Thanks, your reaction is saved.",
  same: "Your vote was already saved. Pick the other button to change it.",
  link: "Link your browser on /me/devices first, then you can react.",
  own: "You cannot react to your own memory.",
  "kudos-given": "You already gave kudos on this memory.",
  note: `That note is too long. Keep it to ${KUDOS_NOTE_MAX} characters or fewer.`,
  gone: "This memory no longer exists.",
  slow: "Too many clicks. Wait a minute and try again.",
  invalid: "That reaction is not one the page offers.",
} as const;

export type ReactCode = keyof typeof REACT_MESSAGES;

/** The line for a ?react= value, or null for a missing or unknown one. */
export function reactMessage(code: unknown): { code: ReactCode; text: string } | null {
  if (typeof code !== "string" || !Object.hasOwn(REACT_MESSAGES, code)) return null;
  return { code: code as ReactCode, text: REACT_MESSAGES[code as ReactCode] };
}
