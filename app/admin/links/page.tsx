import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { isMaintainer } from "@/lib/feedback";
import { listLinks, listRefusedSignIns } from "@/lib/proxy-links";
import { listAllDevices } from "@/lib/devices";
import { describeIp } from "@/lib/client-ip";
import { formatDate } from "@/lib/me-web";
import { formatRelativeTime } from "@/lib/relative-time";
import UnlinkButton from "./UnlinkButton";
import RevokeDeviceButton from "./RevokeDeviceButton";
import LinkForm from "./LinkForm";
import styles from "@/app/me/devices/devices.module.css";

/**
 * The refusal codes claimTypedIdentity audits, in plain words. Only "typed-sso-email" (the name
 * fits, the alias does not, as with a middle name) prefills the Link form; a name that does not
 * fit the typed address may be someone claiming a colleague, so the maintainer types it.
 */
const REFUSAL_REASONS: Record<string, string> = {
  "typed-mismatch": "Name does not fit the address",
  "typed-sso-email": "Sign-in email does not fit",
  "email-linked-elsewhere": "Address linked to another browser",
};

/**
 * Maintainer-only list of browser links with an Unlink button each, to undo a wrong link, of
 * sign-in users whose typed claim was refused with a form to link each one, and of the devices that identified themselves with a Revoke (forget) button each (lost laptop, leaver).
 * A 404 for everyone else (including while BAB_MAINTAINERS is unset) so the page does not
 * advertise itself. The real checks for the writes are in the POST routes.
 */
export default async function AdminLinksPage() {
  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/admin/links", via: "ui" });
  if (!viewer || !isMaintainer(viewer.ownerId)) notFound();

  const links = listLinks();
  const refused = listRefusedSignIns();
  const devices = listAllDevices();
  return (
    <Shell>
      <Link href="/admin" className="back-link">
        Admin
      </Link>
      <h1 className={styles.h1}>Browser links</h1>
      <p className={styles.lede}>Each row ties one signed-in browser (sign-in user) to a BAB identity. Unlink a wrong one.</p>
      {links.length === 0 ? (
        <p className={styles.none}>No links yet.</p>
      ) : (
        <div className={styles.tableSheet} tabIndex={0} role="region" aria-label="Browser links">
          <table className={styles.table}>
            <caption>Browser links</caption>
          <thead>
            <tr>
              <th scope="col">Sign-in email</th>
              <th scope="col">Sign-in name</th>
              <th scope="col">Sign-in user id</th>
              <th scope="col">Linked BAB email</th>
              <th scope="col">Linked at</th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.proxyUserId}>
                <td>{l.proxyEmail ?? "-"}</td>
                <td>{l.proxyName ?? "-"}</td>
                <td>{l.proxyUserId}</td>
                <td>{l.userId}</td>
                <td>{l.linkedAt}</td>
                <td>
                  <UnlinkButton proxyUserId={l.proxyUserId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h2 className={styles.groupTitle}>Refused sign-ins</h2>
      <p className={styles.groupLede}>
        These people typed an address on their devices page and were refused. Check who they are, then link their
        browser. An address or browser that is already linked must be unlinked first.
      </p>
      {refused.length === 0 ? (
        <p className={styles.none}>No refused sign-ins.</p>
      ) : (
        <div className={styles.tableSheet} tabIndex={0} role="region" aria-label="Refused sign-ins">
          <table className={styles.table}>
            <caption>Refused sign-ins</caption>
          <thead>
            <tr>
              <th scope="col">Sign-in email</th>
              <th scope="col">Sign-in name</th>
              <th scope="col">Sign-in user id</th>
              <th scope="col">Typed address</th>
              <th scope="col">Why refused</th>
              <th scope="col">Refused</th>
              <th scope="col">Link to</th>
            </tr>
          </thead>
          <tbody>
            {refused.map((r) => (
              <tr key={r.proxyUserId}>
                <td>{r.proxyEmail ?? "-"}</td>
                <td>{r.proxyName ?? "-"}</td>
                <td>{r.proxyUserId}</td>
                <td>{r.typed ?? "-"}</td>
                <td>{REFUSAL_REASONS[r.reason ?? ""] ?? r.reason ?? "-"}</td>
                <td>{formatRelativeTime(r.refusedAt)}</td>
                <td>
                  <LinkForm proxyUserId={r.proxyUserId} typed={r.reason === "typed-sso-email" ? r.typed : null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h2 className={styles.groupTitle}>Devices</h2>
      <p className={styles.groupLede}>Each row is one Claude install that told BAB who its person is. Revoke one to make it unknown until Claude identifies it again.</p>
      {devices.length === 0 ? (
        <p className={styles.none}>No devices yet.</p>
      ) : (
        <div className={styles.tableSheet} tabIndex={0} role="region" aria-label="Devices">
          <table className={styles.table}>
            <caption>Devices</caption>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Device</th>
              <th scope="col">From</th>
              <th scope="col">Identified</th>
              <th scope="col">Last seen</th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.userId}</td>
                <td>{d.label}</td>
                <td>{describeIp(d.connectedIp)}</td>
                <td>{formatDate(d.createdAt)}</td>
                <td>{d.lastSeenAt ? formatRelativeTime(new Date(d.lastSeenAt).toISOString()) : "never"}</td>
                <td>
                  <RevokeDeviceButton id={d.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </Shell>
  );
}

export const dynamic = "force-dynamic";
