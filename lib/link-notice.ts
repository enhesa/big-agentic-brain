import { identityHint } from "./identity";

/**
 * What a signed-in but unlinked viewer is told, in one wording on every page and form answer.
 * Such a viewer's sign-in passed a short alias or an address BAB does not accept as a person
 * (lib/session.ts fromProxy), so BAB cannot key them yet. The fix is one step on /me/devices.
 */

/** What is missing. */
export function linkNeededReason(): string {
  return `BAB does not know who you are yet: your sign-in did not pass your full email address (like ${identityHint()}).`;
}

/** Plain-text version for a form answer: what is missing, what to do, what it unlocks. */
export function linkNeededText(then: string): string {
  return `${linkNeededReason()} Confirm it once on Your devices (/me/devices), then ${then}. This browser stays linked after that.`;
}
