import { getViewer } from "@/lib/notify-auth";
import { ccDeleteAll } from "@/lib/command-center";
import { viewerPost } from "@/lib/command-center-web";

export const dynamic = "force-dynamic";

/** POST /command-center/delete: Delete now. Every record of the viewer goes at once. */
export async function POST(request: Request) {
  return viewerPost(request, "/command-center/delete", await getViewer(), (viewer) => ccDeleteAll(viewer.ownerId));
}
