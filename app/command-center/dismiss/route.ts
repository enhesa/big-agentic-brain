import { getViewer } from "@/lib/notify-auth";
import { ccClearQuestion } from "@/lib/command-center";
import { viewerPost } from "@/lib/command-center-web";

export const dynamic = "force-dynamic";

/** POST /command-center/dismiss {id, questionId}: the viewer clears one of their own open questions. */
export async function POST(request: Request) {
  return viewerPost(request, "/command-center/dismiss", await getViewer(), (viewer, f) =>
    ccClearQuestion(viewer.ownerId, { id: f.id, questionId: f.questionId }, "ui"),
  );
}
