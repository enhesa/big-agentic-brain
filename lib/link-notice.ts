import { identityHint } from "./identity";

/**
 * What a signed-in but unlinked viewer is told, in one wording on every page that shows the notice.
 * Such a viewer's sign-in passed a short alias, another domain or no address BAB accepts as a person
 * (lib/session.ts fromProxy), so BAB cannot key them yet. The fix is one step on /me/devices.
 */

/** What is missing. */
export function linkNeededReason(): string {
  return `BAB does not know who you are yet: your sign-in did not pass a full email address BAB accepts (like ${identityHint()}).`;
}

