import Shell from "@/app/components/shell/Shell";
import buttons from "@/app/components/shell/LinkActions.module.css";
import SuggestLink from "./SuggestLink";
import { getViewer } from "@/lib/notify-auth";
import { trustProxyHeaders } from "@/lib/session";
import { currentUser, type ProxyUser } from "@/lib/user";
import { getLinkedUserId, suggestLinkFor } from "@/lib/proxy-links";
import { listDevices } from "@/lib/devices";
import { areasOf, AREAS_PER_PERSON_MAX, AREA_MAX, AREA_NOTE_MAX, CONTACTS_PER_AREA_MAX } from "@/lib/area-contacts";
import { getUser } from "@/lib/users";
import { teamLabel, teamTags } from "@/lib/teams";
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
 * BAB's identity is an honour system: Claude says who the person is by
 * calling bab_identify, so nothing is connected from here. Forgetting a device makes it unknown;
 * its next bab_identify binds it again, as whoever it says.
 */
export default async function DevicesPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const params = (await searchParams) ?? {};
  const claim = typeof params.claim === "string" ? params.claim : "";
  const claimError = Object.hasOwn(CLAIM_ERRORS, claim) ? CLAIM_ERRORS[claim] : undefined;
  const profileError = params.profile === "invalid";

  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/me/devices", via: "ui" });
  const proxy = trustProxyHeaders() ? await currentUser() : null;

  return (
    <Shell>
      <h1 className={styles.h1}>Your devices</h1>
      {viewer ? (
        <LinkedView email={viewer.ownerId} profileError={profileError} showUnlink={!!proxy && getLinkedUserId(proxy.id) !== null} />
      ) : proxy ? (
        <WhoAreYou proxy={proxy} error={claimError} stale={getLinkedUserId(proxy.id) !== null} />
      ) : (
        <div className="card">
          <p className={styles.muted}>Sign in through the BAB web UI to see your devices.</p>
        </div>
      )}
    </Shell>
  );
}

function LinkedView({ email, showUnlink, profileError }: { email: string; showUnlink: boolean; profileError: boolean }) {
  const devices = listDevices(email);
  const connections = listRecentConnections(email);
  return (
    <>
      <Profile email={email} error={profileError} />

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

/** Your home team and the areas you are a contact for. Agents suggest these people when BAB has no answer. */
function Profile({ email, error }: { email: string; error: boolean }) {
  const homeTeam = getUser(email)?.home_team ?? "";
  const areas = areasOf(email);
  return (
    <div className={`card ${styles.section}`}>
      <h2 className={styles.h2}>Your team and areas</h2>
      <p className={styles.muted}>
        {`Your home team says where you work; it is separate from the tags on your memories. Add an area (for example toxicology) to be named as a contact when BAB has no answer on it. Colleagues' agents suggest you, or send you a question only when their user agrees. Up to ${CONTACTS_PER_AREA_MAX} contacts per area and ${AREAS_PER_PERSON_MAX} areas per person.`}
      </p>
      {error ? (
        <p className={styles.error} role="alert">
          {`That did not work. An area is letters and digits (up to ${AREA_MAX}), a note is up to ${AREA_NOTE_MAX} characters, and an area holds ${CONTACTS_PER_AREA_MAX} contacts.`}
        </p>
      ) : null}
      <form method="post" action="/me/devices/profile" className={styles.form}>
        <input type="hidden" name="action" value="team" />
        <label htmlFor="team">Home team</label>
        <select id="team" name="team" defaultValue={homeTeam}>
          <option value="">None</option>
          {teamTags().map((t) => (
            <option key={t} value={t}>
              {teamLabel(t)}
            </option>
          ))}
        </select>
        <button type="submit" className={buttons.btn}>
          Save
        </button>
      </form>
      {areas.length > 0 ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Area</th>
              <th>Ask me about</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {areas.map((a) => (
              <tr key={a.area}>
                <td>{a.area}</td>
                <td>{a.note ?? "-"}</td>
                <td>
                  <form method="post" action="/me/devices/profile">
                    <input type="hidden" name="action" value="remove" />
                    <input type="hidden" name="area" value={a.area} />
                    <button type="submit" className={buttons.btn}>
                      Remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <form method="post" action="/me/devices/profile" className={styles.form}>
        <input type="hidden" name="action" value="add" />
        <label htmlFor="area">Area</label>
        <input id="area" name="area" type="text" maxLength={AREA_MAX} placeholder="toxicology" required />
        <label htmlFor="note">Ask me about</label>
        <input id="note" name="note" type="text" maxLength={AREA_NOTE_MAX} placeholder="regulatory lists, certifications" />
        <button type="submit" className={buttons.primary}>
          Add
        </button>
      </form>
    </div>
  );
}

function WhoAreYou({ proxy, error, stale }: { proxy: ProxyUser; error?: string; stale: boolean }) {
  const suggestion = stale ? null : suggestLinkFor(proxy.id, proxy.email, proxy.name);
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
