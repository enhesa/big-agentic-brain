import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { isMaintainer } from "@/lib/feedback";

/** Maintainer-only index of the admin pages. A 404 for everyone else, like each page behind it. */
export default async function AdminIndexPage() {
  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/admin", via: "ui" });
  if (!viewer || !isMaintainer(viewer.ownerId)) notFound();

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
    </Shell>
  );
}

export const dynamic = "force-dynamic";
