import { getViewer } from "@/lib/notify-auth";
import { ccSetSwitch } from "@/lib/command-center";
import { viewerPost } from "@/lib/command-center-web";

export const dynamic = "force-dynamic";

/** POST /command-center/disable: the viewer switches their own Command Center off (records kept 30 days). Never an agent. */
export async function POST(request: Request) {
  return viewerPost(request, "/command-center/disable", await getViewer(), (viewer) => ccSetSwitch(viewer.ownerId, false));
}
