import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { isMaintainer } from "@/lib/feedback";
import { filesAdminSummary } from "@/lib/files";
import { config } from "@/lib/config";

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
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
      <h1>Admin</h1>
      <ul>
        <li>
          <Link href="/usage">Usage</Link>: weekly capture, identify and flag numbers.
        </li>
        <li>
          <Link href="/admin/links">Browser links</Link>: link a refused sign-in, unlink a wrong browser link, revoke a device.
        </li>
      </ul>
      <h2>File store</h2>
      <p>
        Data volume:{" "}
        {files.volume
          ? `${mb(files.volume.usedBytes)} of ${mb(files.volume.totalBytes)} used (${files.volume.usedPercent}%), ${mb(files.volume.freeBytes)} free.`
          : "size unknown on this platform."}{" "}
        Uploads stop above {files.diskFullPercent}%{files.uploadsBlocked ? ": uploads are refused now." : "."}
      </p>
      <p>
        {files.liveFiles} files on disk, {mb(files.bytesOnDisk)}, from {files.owners} people. Limits: {mb(f.maxFileBytes)} per file, {mb(f.userQuotaBytes)} per person,
        kept {f.defaultExpiryDays} days by default and at most {f.maxExpiryDays}.{f.enabled ? "" : " The file store is switched off (BAB_FILES)."}
      </p>
      {files.topOwners.length > 0 ? (
        <ul>
          {files.topOwners.map((o) => (
            <li key={o.owner}>
              {o.owner}: {mb(o.bytes)} in {o.files} files
            </li>
          ))}
        </ul>
      ) : null}
    </Shell>
  );
}

export const dynamic = "force-dynamic";
