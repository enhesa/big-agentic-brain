import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { isMaintainer } from "@/lib/feedback";
import { filesAdminSummary } from "@/lib/files";
import { config } from "@/lib/config";
import styles from "@/app/me/devices/devices.module.css";

/** A size in MB, or in GB from 1024 MB up, so a data volume does not read as a six-digit number. */
function mb(bytes: number): string {
  const m = bytes / (1024 * 1024);
  return m >= 1024 ? (m / 1024).toFixed(1) + " GB" : m.toFixed(1) + " MB";
}

/** Maintainer-only index of the admin pages. A 404 for everyone else, like each page behind it. */
export default async function AdminIndexPage() {
  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/admin", via: "ui" });
  if (!viewer || !isMaintainer(viewer.ownerId)) notFound();
  const files = filesAdminSummary();
  const f = config().files;

  return (
    <Shell>
      <h1 className={styles.h1}>Admin</h1>
      <p className={styles.lede}>The pages only maintainers see, and how full the file store is.</p>
      <ul className={styles.tiles}>
        <li className={styles.tile}>
          <Link href="/usage">Usage</Link>
          Weekly capture, identify and flag numbers.
        </li>
        <li className={styles.tile}>
          <Link href="/admin/links">Browser links</Link>
          Link a refused sign-in, unlink a wrong browser link, revoke a device.
        </li>
      </ul>

      <h2 className={styles.groupTitle}>File store</h2>
      <p className={styles.groupLede}>
        Uploads stop above {files.diskFullPercent}% or under {mb(files.diskFloorBytes)} free (twice the database plus the reserve).
        {f.enabled ? "" : " The file store is switched off (BAB_FILES)."}
      </p>
      <div className={`card ${styles.section}`}>
        <dl className={styles.stats}>
          <div>
            <dt>Data volume</dt>
            <dd>
              {files.volume ? `${files.volume.usedPercent}%` : "Unknown"}
              <small>
                {files.volume
                  ? `${mb(files.volume.usedBytes)} of ${mb(files.volume.totalBytes)} used, ${mb(files.volume.freeBytes)} free`
                  : "This platform does not tell the size."}
              </small>
            </dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>
              {files.liveFiles}
              <small>
                {mb(files.bytesOnDisk)} on disk, from {files.owners} people
              </small>
            </dd>
          </div>
          <div>
            <dt>Limits</dt>
            <dd>
              {mb(f.maxFileBytes)}
              <small>
                per file, {mb(f.userQuotaBytes)} per person
              </small>
            </dd>
          </div>
          <div>
            <dt>Kept</dt>
            <dd>
              {f.defaultExpiryDays} days
              <small>by default, at most {f.maxExpiryDays}</small>
            </dd>
          </div>
        </dl>
        {files.volume ? (
          <div className={files.uploadsBlocked ? `${styles.meter} ${styles.meterBlocked}` : styles.meter} aria-hidden="true">
            <span style={{ width: `${Math.min(100, Math.max(0, files.volume.usedPercent))}%` }} />
          </div>
        ) : null}
        {files.uploadsBlocked ? (
          <p className={styles.error} role="status">
            Uploads are refused now.
          </p>
        ) : null}
        {f.allowDeclared ? (
          <p className={styles.warn}>BAB_FILES_ALLOW_DECLARED is on: callers identified only by headers can reach other people&apos;s files.</p>
        ) : null}
      </div>

      {files.topOwners.length > 0 ? (
        <>
          <h2 className={styles.groupTitle}>Who stores most</h2>
          <div className={styles.tableSheet} tabIndex={0} role="region" aria-label="Who stores most">
            <table className={styles.table}>
              <caption>The people with the most bytes in the file store</caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Size</th>
                  <th scope="col">Files</th>
                </tr>
              </thead>
              <tbody>
                {files.topOwners.map((o) => (
                  <tr key={o.owner}>
                    <td>{o.owner}</td>
                    <td>{mb(o.bytes)}</td>
                    <td>{o.files}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Shell>
  );
}

export const dynamic = "force-dynamic";
