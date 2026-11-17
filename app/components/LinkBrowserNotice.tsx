import Link from "next/link";
import SuggestLink from "@/app/me/devices/SuggestLink";
import buttons from "@/app/components/shell/LinkActions.module.css";
import { identityHint } from "@/lib/identity";
import { CLAIM_ERRORS } from "@/lib/devices-web";
import { suggestLinkFor } from "@/lib/proxy-links";
import { LINK_ONCE, LINK_TITLE, linkNeededReason, safeReturnPath } from "@/lib/link-notice";
import type { ProxyUser } from "@/lib/user";
import styles from "./LinkBrowserNotice.module.css";

/**
 * The one card for a signed-in viewer BAB cannot key yet (short alias or other address, no link),
 * on every page that needs a person. It links the browser right here: "Yes, that's me" when the
 * sign-in fits exactly one person (suggestLinkFor, the same data /me/devices shows this viewer),
 * and a plain form for the typed address that posts to /me/devices/claim and comes back to
 * `returnTo`. The typed form works without client JS. Text: lib/link-notice.ts.
 *
 * `proxy` must be the viewer from pendingProxyLinkUser() (or /me/devices' own check), never a
 * user taken from the request body. `claim` is the raw ?claim= code; unknown codes are ignored.
 */
export default function LinkBrowserNotice({
  proxy,
  then,
  returnTo,
  claim,
  stale = false,
  showDevicesLink = true,
  headingLevel = 2,
}: {
  proxy: ProxyUser;
  /** What linking unlocks on this page, for example "you can see your inbox here". */
  then: string;
  /** This page's own path. Passed through safeReturnPath, so a bad value falls back to /me/devices. */
  returnTo: string;
  claim?: string | string[];
  /** The browser holds an old link that no longer fits the sign-in: no suggestion, unlink first. */
  stale?: boolean;
  showDevicesLink?: boolean;
  /** 3 where the card sits inside a section that already has an h2 (the comments on a memory). */
  headingLevel?: 2 | 3;
}) {
  const code = Array.isArray(claim) ? claim[0] : claim;
  const error = code && Object.hasOwn(CLAIM_ERRORS, code) ? CLAIM_ERRORS[code] : undefined;
  const suggestion = stale ? null : suggestLinkFor(proxy.id, proxy.email, proxy.name);
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <section className={`card ${styles.card}`} aria-labelledby="link-browser-title" data-testid="link-browser-notice">
      <Heading id="link-browser-title" className={styles.title}>
        {LINK_TITLE}
      </Heading>
      <p className={styles.lede}>
        {stale ? "BAB does not know who you are yet." : linkNeededReason()}{" "}
        Confirm your address once, then {then}.
      </p>

      {error ? (
        <p id="link-browser-error" className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {suggestion ? (
        <div className={styles.suggest}>
          <SuggestLink email={suggestion.email} name={suggestion.name} />
        </div>
      ) : null}

      <form method="post" action="/me/devices/claim" className={styles.form}>
        <input type="hidden" name="next" value={safeReturnPath(returnTo)} />
        <label htmlFor="link-browser-email" className={styles.label}>
          {suggestion ? "Not you? Type your work email" : "Your work email"}
        </label>
        <div className={styles.row}>
          <input
            id="link-browser-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder={identityHint()}
            required
            className={styles.input}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "link-browser-error link-browser-help" : "link-browser-help"}
          />
          <button type="submit" className={suggestion ? buttons.btn : buttons.primary}>
            Link this browser
          </button>
        </div>
        <p id="link-browser-help" className={styles.help}>
          It has to fit the name your sign-in shows. {LINK_ONCE}
        </p>
      </form>

      {showDevicesLink ? (
        <p className={styles.foot}>
          You can see or undo this later on <Link href="/me/devices">Your devices</Link>.
        </p>
      ) : null}
    </section>
  );
}
