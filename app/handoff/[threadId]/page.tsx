import { redirect } from "next/navigation";

/**
 * Handing a thread to Claude lives on the Inbox page now, so this is only
 * a forwarder for links already sitting in old messages and notes.
 *
 * Temporary (307) on purpose: browsers cache a 308 for good, and the Inbox has a kill switch
 * and may move again. The target is rebuilt from the id and a strict `open=app`, never copied
 * from the request, so this cannot be used as an open redirect or to add other parameters.
 * The Inbox itself decides who may see the thread and whether to open the app.
 * Still behind the sign-in proxy: the Inbox needs the viewer, and the proxy sends a signed-out
 * visitor to sign in and back to this URL.
 */
export default async function HandoffRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ open?: string | string[] }>;
}) {
  const { threadId } = await params;
  const { open } = await searchParams;
  // Exact match on a single value, as on the Inbox: an array or any other string is dropped.
  redirect(`/inbox?thread=${encodeURIComponent(threadId)}${open === "app" ? "&open=app" : ""}`);
}

export const dynamic = "force-dynamic";
