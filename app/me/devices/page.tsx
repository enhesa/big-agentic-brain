import Shell from "@/app/components/shell/Shell";
import buttons from "@/app/components/shell/LinkActions.module.css";
import SuggestLink from "./SuggestLink";
import { getViewer } from "@/lib/notify-auth";
import { trustForgeHeaders } from "@/lib/session";
import { currentUser, type ForgeUser } from "@/lib/user";
import { getLinkedUserId, suggestLinkFor } from "@/lib/forge-links";
import { listDevices } from "@/lib/devices";
import { listRecentConnections, CONNECTION_TTL_DAYS } from "@/lib/mcp-connections";
import { CLAIM_ERRORS } from "@/lib/devices-web";
import { describeIp } from "@/lib/client-ip";
import { formatDate } from "@/lib/me-web";
import { formatRelativeTime } from "@/lib/relative-time";
import { identityHint } from "@/lib/identity";
import { auditRequest } from "@/lib/request-audit";
import styles from "./devices.module.css";

/**
 * Your devices (replaces /me/token). A plain server component and plain forms, so it renders
 * and works without client JS. Proxy-identity path on purpose (not under /api, which strips the proxy identity headers):
 * the viewer is the signed-in person, never a self-declared header. Three states:
 *   - no signed-in viewer: one line;
 *   - signed in but no identity: "Yes, that's me" when the alias points at one person, and
 *     the typed claim;
 *   - linked: the devices that said they are this person (bab_identify), with Forget and Forget
 *     all, the connections that said so in the last 7 days, and Unlink this browser.
 * BAB's identity is an honour system (owner, 2026-10-01): Claude says who the person is by
 * calling bab_identify, so nothing is connected from here. Forgetting a device makes it unknown;
 * its next bab_identify binds it again, as whoever it says.
 */
export default async function DevicesPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const params = (await searchParams) ?? {};
  const claim = typeof params.claim === "string" ? params.claim : "";
  const claimError = Object.hasOwn(CLAIM_ERRORS, claim) ? CLAIM_ERRORS[claim] : undefined;

  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/me/devices", via: "ui" });
  const forge = trustForgeHeaders() ? await currentUser() : null;

  return (
    <Shell>
      <h1 className={styles.h1}>Your devices</h1>
      {viewer ? (
        <LinkedView email={viewer.ownerId} showUnlink={!!forge && getLinkedUserId(forge.id) !== null} />
      ) : forge ? (
        <WhoAreYou forge={forge} error={claimError} stale={getLinkedUserId(forge.id) !== null} />
      ) : (
        <div className="card">
          <p className={styles.muted}>Sign in through the BAB web UI to see your devices.</p>
        </div>
      )}
    </Shell>
  );
}

function LinkedView({ email, showUnlink }: { email: string; showUnlink: boolean }) {
  const devices = listDevices(email);
  const connections = listRecentConnections(email);
  return (
    <>
      <div className={`card ${styles.section}`}>
        <p className={styles.muted}>
          {`A device is one Claude install that told BAB it is ${email} (Claude does that by itself, with bab_identify; there is nothing to type or copy). If one is not yours, or you no longer use it, forget it: it is unknown again until Claude identifies it.`}
        </p>
      </div>

      {devices.length === 0 ? (
        <div className="card">
          <p className={styles.muted}>No devices yet. Install the bab plugin and Claude tells BAB who you are by itself.</p>
        </div>
      ) : (
        <div className={`card ${styles.section}`}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Device</th>
                <th>From</th>
                <th>Identified</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>{d.label}</td>
                  <td>{describeIp(d.connectedIp)}</td>
                  <td>{formatDate(d.createdAt)}</td>
                  <td>{d.lastSeenAt ? formatRelativeTime(new Date(d.lastSeenAt).toISOString()) : "never"}</td>
                  <td>
                    <form method="post" action="/me/devices/revoke">
                      <input type="hidden" name="id" value={d.id} />
                      <button type="submit" className={buttons.btn}>
                        Forget
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form method="post" action="/me/devices/revoke" className={styles.form}>
            <input type="hidden" name="all" value="1" />
            <button type="submit" className={buttons.btn}>
              Forget all my devices
            </button>
            <span className={styles.muted}>Lost a laptop? This works from any browser you are signed in on.</span>
          </form>
        </div>
      )}

      {connections.length > 0 ? (
        <div className={`card ${styles.section}`}>
          <p className={styles.muted}>
            {`Connections that told BAB they are you in the last ${CONNECTION_TTL_DAYS} days (a Claude session without a device). They end by themselves, or all at once with Forget all my devices. Forgetting one device does not touch them.`}
          </p>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Connection</th>
                <th>Started</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c, i) => (
                <tr key={i}>
                  <td>MCP session</td>
                  <td>{formatDate(c.createdAt)}</td>
                  <td>{formatRelativeTime(new Date(c.lastSeenAt).toISOString())}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {showUnlink ? (
        <UnlinkBrowser text={`This browser is linked to ${email}. If that is wrong, unlink it and confirm who you are again on this page.`} />
      ) : null}
    </>
  );
}

function WhoAreYou({ forge, error, stale }: { forge: ForgeUser; error?: string; stale: boolean }) {
  const suggestion = stale ? null : suggestLinkFor(forge.id, forge.email, forge.name);
  return (
    <>
      <div className={`card ${styles.section}`}>
        <p className={styles.muted}>BAB does not know who you are yet.</p>
        {suggestion ? <SuggestLink email={suggestion.email} name={suggestion.name} /> : null}
        <p className={styles.muted}>
          {suggestion ? "Not you? " : ""}Type your long address, {identityHint()}. It has to fit the name your sign-in shows.
        </p>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <form method="post" action="/me/devices/claim" className={styles.form}>
          <label htmlFor="email">Your address</label>
          <input id="email" name="email" type="email" placeholder={identityHint()} required />
          <button type="submit" className={buttons.primary}>
            Continue
          </button>
        </form>
      </div>
      {stale ? (
        <UnlinkBrowser text="This browser has an old link that no longer fits your sign-in. Unlink it, then type your address." />
      ) : null}
    </>
  );
}

/** Same self-unlink as /reminders, shared logic (lib/unlink-own-web.ts). */
function UnlinkBrowser({ text }: { text: string }) {
  return (
    <form method="post" action="/me/devices/unlink" className={styles.unlink}>
      <p>{text}</p>
      <button type="submit" className={buttons.btn}>
        Unlink this browser
      </button>
    </form>
  );
}

export const dynamic = "force-dynamic";
