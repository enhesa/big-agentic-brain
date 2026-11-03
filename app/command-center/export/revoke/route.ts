import { getViewer } from "@/lib/notify-auth";
import { ccRevokeExport } from "@/lib/command-center";
import { viewerPost } from "@/lib/command-center-web";

export const dynamic = "force-dynamic";

/** POST /command-center/export/revoke {app}: the viewer stops sharing their log with one export app. Never an agent. Audited. */
export async function POST(request: Request) {
  return viewerPost(request, "/command-center/export/revoke", await getViewer(), (viewer, f) => ccRevokeExport(viewer.ownerId, f.app));
}
