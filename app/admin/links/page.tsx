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
      <h1>Browser links</h1>
      <p>
        Each row ties one signed-in browser (sign-in user) to a BAB identity. Unlink a wrong one.
      </p>
      {links.length === 0 ? (
        <p className="card">No links yet.</p>
      ) : (
        <table className="card">
          <thead>
            <tr>
              <th>Sign-in email</th>
              <th>Sign-in name</th>
              <th>Sign-in user id</th>
              <th>Linked BAB email</th>
              <th>Linked at</th>
              <th />
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
      )}

      <h2>Refused sign-ins</h2>
      <p>
        These people typed an address on their devices page and were refused. Check who they are, then link their
        browser. An address or browser that is already linked must be unlinked first.
      </p>
      {refused.length === 0 ? (
        <p className="card">No refused sign-ins.</p>
      ) : (
        <table className="card">
          <thead>
            <tr>
              <th>Sign-in email</th>
              <th>Sign-in name</th>
              <th>Sign-in user id</th>
              <th>Typed address</th>
              <th>Why refused</th>
              <th>Refused</th>
              <th>Link to</th>
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
      )}

      <h2>Devices</h2>
      <p>Each row is one Claude install that told BAB who its person is. Revoke one to make it unknown until Claude identifies it again.</p>
      {devices.length === 0 ? (
        <p className="card">No devices yet.</p>
      ) : (
        <table className="card">
          <thead>
            <tr>
              <th>Person</th>
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
      )}
    </Shell>
  );
}

export const dynamic = "force-dynamic";
