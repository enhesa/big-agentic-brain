import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/** The maintainer nudge in POST /api/hook: counts only, once per batch of new feedback. */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-hook-feedback-test-"));
  process.env.DATA_DIR = dataDir;
  delete process.env.BAB_MAINTAINERS;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
  vi.resetModules();
});

const MAINT = "maria.m@example.com";
const BOB = "bob.b@example.com";

async function post(body: unknown) {
  const { POST } = await import("../app/api/hook/route");
  return (
    await POST(
      new Request("https://bab.example.com/api/hook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  ).json();
}

async function linkedSession(owner: string, sessionId: string) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: owner, email: owner, name: null, roles: [] });
  const first = await post({ hook_event_name: "UserPromptSubmit", session_id: sessionId });
  const token = first.hookSpecificOutput.additionalContext.match(/[0-9a-f]{32}/)![0];
  const { redeemLinkToken } = await import("../lib/session-links");
  redeemLinkToken(token, owner);
}

async function fileFeedback(title: string) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: BOB, email: BOB, name: null, roles: [] });
  const { create } = await import("../lib/feedback");
  create({ authorId: BOB, source: "agent", kind: "bug", area: "web", title, body: `${title} happens every single time` });
}

const text = (json: { hookSpecificOutput?: { additionalContext: string } }) => json.hookSpecificOutput?.additionalContext ?? "";

describe("maintainer feedback nudge", () => {
  it("tells a maintainer how many items are new, once", async () => {
    process.env.BAB_MAINTAINERS = MAINT;
    await linkedSession(MAINT, "s1");
    await fileFeedback("alpha widget crashes");
    await fileFeedback("bravo gadget flickers");

    const first = await post({ hook_event_name: "UserPromptSubmit", session_id: "s1" });
    expect(text(first)).toContain(
      "Big Agentic Brain: 2 new feedback items about BAB since you last looked. Call bab_feedback with action list to triage.",
    );
    const second = await post({ hook_event_name: "UserPromptSubmit", session_id: "s1" });
    expect(text(second)).not.toContain("feedback item");
  });

  it("shows up on SessionStart too, but not after a compaction", async () => {
    process.env.BAB_MAINTAINERS = MAINT;
    await linkedSession(MAINT, "s2");
    await fileFeedback("alpha widget crashes");

    const compact = await post({ hook_event_name: "SessionStart", session_id: "s2", source: "compact" });
    expect(text(compact)).not.toContain("feedback item");
    const start = await post({ hook_event_name: "SessionStart", session_id: "s2", source: "startup" });
    expect(text(start)).toContain("1 new feedback item about BAB");
  });

  it("is silent for a non-maintainer and while BAB_MAINTAINERS is unset", async () => {
    await linkedSession(MAINT, "s3");
    await fileFeedback("alpha widget crashes");
    expect(text(await post({ hook_event_name: "UserPromptSubmit", session_id: "s3" }))).not.toContain("feedback item");

    process.env.BAB_MAINTAINERS = "someone.else@example.com";
    expect(text(await post({ hook_event_name: "UserPromptSubmit", session_id: "s3" }))).not.toContain("feedback item");
  });

  it("carries no titles or bodies", async () => {
    process.env.BAB_MAINTAINERS = MAINT;
    await linkedSession(MAINT, "s4");
    await fileFeedback("secret zebra title");
    const out = text(await post({ hook_event_name: "UserPromptSubmit", session_id: "s4" }));
    expect(out).toContain("1 new feedback item");
    expect(out).not.toContain("zebra");
  });
});
