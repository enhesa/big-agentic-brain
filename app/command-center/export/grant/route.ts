import { getViewer } from "@/lib/notify-auth";
import { ccGrantExport } from "@/lib/command-center";
import { viewerPost } from "@/lib/command-center-web";

export const dynamic = "force-dynamic";

/** POST /command-center/export/grant {app, level}: the viewer shares their own log with one export app. Never an agent. Audited. */
export async function POST(request: Request) {
  return viewerPost(request, "/command-center/export/grant", await getViewer(), (viewer, f) => ccGrantExport(viewer.ownerId, f.app, f.level));
}
