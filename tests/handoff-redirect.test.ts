import { describe, it, expect } from "vitest";

/**
 * /handoff/<id> used to be a page of its own. Since 2026-10-02 it only forwards to the Inbox,
 * so links already sitting in old messages and notes keep working.
 */

async function redirectTarget(threadId: string, open?: string | string[]) {
  const { default: HandoffRedirect } = await import("../app/handoff/[threadId]/page");
  const props = { params: Promise.resolve({ threadId }), searchParams: Promise.resolve(open === undefined ? {} : { open }) };
  try {
    await HandoffRedirect(props);
  } catch (e) {
    // Next's redirect() throws; the digest reads NEXT_REDIRECT;<type>;<url>;<status>;
    const digest = (e as { digest?: string }).digest ?? "";
    const [code, type, url, status] = digest.split(";");
    expect(code).toBe("NEXT_REDIRECT");
    return { type, url, status };
  }
  throw new Error("expected a redirect");
}

describe("/handoff/[threadId]", () => {
  it("redirects to the thread in the Inbox, temporarily", async () => {
    expect(await redirectTarget("abc-123")).toMatchObject({ url: "/inbox?thread=abc-123", status: "307" });
  });

  it("keeps open=app", async () => {
    expect((await redirectTarget("abc-123", "app")).url).toBe("/inbox?thread=abc-123&open=app");
  });

  it("drops any other open value, so the redirect never adds an auto-open the link did not ask for", async () => {
    for (const open of ["cli", "evil", "APP", "app ", "", ["app", "cli"], ["app", "app"]]) {
      expect((await redirectTarget("abc-123", open)).url).toBe("/inbox?thread=abc-123");
    }
  });

  it("cannot be steered off the Inbox by the id", async () => {
    for (const id of ["../admin", "a&open=app", "x?y=z#h", "a b"]) {
      const { url } = await redirectTarget(id);
      const parsed = new URL(url, "http://x");
      expect(parsed.pathname).toBe("/inbox");
      expect(parsed.searchParams.get("thread")).toBe(id);
      expect(parsed.searchParams.has("open")).toBe(false);
    }
  });
});
