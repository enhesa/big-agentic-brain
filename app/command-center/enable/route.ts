import { getViewer } from "@/lib/notify-auth";
import { ccSetSwitch } from "@/lib/command-center";
import { viewerPost } from "@/lib/command-center-web";

export const dynamic = "force-dynamic";

/** POST /command-center/enable: the viewer switches their own Command Center on. Never an agent. */
export async function POST(request: Request) {
  return viewerPost(request, "/command-center/enable", await getViewer(), (viewer) => ccSetSwitch(viewer.ownerId, true));
}
