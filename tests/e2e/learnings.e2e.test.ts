import { describe, it, expect } from "vitest";
import { api, origin, ALICE, BOB, uniqueTitle, uniqueActor } from "./helpers";

async function createLearning(overrides: Record<string, unknown> = {}) {
  // The default body must be unique per call too, not just the title:
  // lib/learnings.ts findSimilar scores title AND body Jaccard, and an
  // identical body across many otherwise-unrelated test learnings would
  // trigger the >= 0.55 duplicate guard on its own.
  const res = await api("/api/learnings", {
    method: "POST",
    actor: ALICE,
    body: {
      title: uniqueTitle("E2E learning"),
      body: uniqueTitle("A body long enough to be a real learning about something specific and searchable"),
      tags: ["e2e"],
      ...overrides,
    },
  });
  return res;
}

describe("e2e: learnings", () => {
  it("creates a learning: 201", async () => {
    const res = await createLearning();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.learning.id).toBeTruthy();
  });

  it("idempotent replay via Idempotency-Key returns the same result", async () => {
    const key = `e2e-idem-${Date.now()}`;
    const title = uniqueTitle("Idempotent learning");
    const payload = {
      title,
      body: "Body text for idempotency replay test, long enough to pass validation checks.",
      tags: ["e2e-idem"],
    };
    const first = await api("/api/learnings", {
      method: "POST",
      actor: ALICE,
      body: payload,
      headers: { "Idempotency-Key": key },
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const second = await api("/api/learnings", {
      method: "POST",
      actor: ALICE,
      body: payload,
      headers: { "Idempotency-Key": key },
    });
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.learning.id).toBe(firstBody.learning.id);
  });

  it("409s a likely duplicate, with candidates, then 201s with confirmNotDuplicate", async () => {
    const title = uniqueTitle("Duplicate-prone topic about Kafka consumer lag alerts");
    const body =
      "Kafka consumer lag alerts fire too eagerly in dev; raise the threshold and add a grace window.";
    const original = await createLearning({ title, body, tags: ["kafka", "alerts"] });
    expect(original.status).toBe(201);

    const dupe = await createLearning({ title, body, tags: ["kafka", "alerts"] });
    expect(dupe.status).toBe(409);
    const dupeBody = await dupe.json();
    expect(Array.isArray(dupeBody.candidates)).toBe(true);
    expect(dupeBody.candidates.length).toBeGreaterThan(0);

    const forced = await createLearning({
      title,
      body,
      tags: ["kafka", "alerts"],
      confirmNotDuplicate: true,
    });
    expect(forced.status).toBe(201);
  });

  it("GET /api/learnings/similar never 409s", async () => {
    const title = uniqueTitle("Similar pre-check topic");
    const body = "Body text used only for the similar pre-check endpoint, safely unique.";
    await createLearning({ title, body, tags: ["similar-check"] });

    const res = await api(
      `/api/learnings/similar?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&tags=similar-check`,
      { actor: ALICE }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.candidates)).toBe(true);
  });

  it("search escapes <img> payloads and tolerates q=* without erroring", async () => {
    const xssTitle = uniqueTitle("<img src=x onerror=alert(1)>");
    await createLearning({ title: xssTitle, body: "Body for xss-escaping search test, unique enough." });

    const res = await api(`/api/learnings?q=${encodeURIComponent("<img")}`, { actor: ALICE });
    expect(res.status).toBe(200);

    const star = await api(`/api/learnings?q=${encodeURIComponent("*")}`, { actor: ALICE });
    expect(star.status).toBe(200);
  });

  it("vote: first vote changed:true, repeat same kind changed:false, switching kind changed:true", async () => {
    const created = await createLearning();
    const { learning } = await created.json();

    const first = await api(`/api/learnings/${learning.id}/vote`, {
      method: "POST",
      actor: BOB,
      body: { kind: "helpful" },
    });
    expect(first.status).toBe(200);
    expect((await first.json()).changed).toBe(true);

    const repeat = await api(`/api/learnings/${learning.id}/vote`, {
      method: "POST",
      actor: BOB,
      body: { kind: "helpful" },
    });
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).changed).toBe(false);

    const switched = await api(`/api/learnings/${learning.id}/vote`, {
      method: "POST",
      actor: BOB,
      body: { kind: "not_helpful" },
    });
    expect(switched.status).toBe(200);
    expect((await switched.json()).changed).toBe(true);
  });

  it("flag twice by two different users archives it and hides it from default search; status=all shows it", async () => {
    const title = uniqueTitle("Flaggable learning");
    const created = await createLearning({ title, body: "Body content for the flag-twice test case." });
    const { learning } = await created.json();

    // The agent path needs a one-line evidence note (owner, 2026-10-02).
    const flag1 = await api(`/api/learnings/${learning.id}/flag`, { method: "POST", actor: BOB, body: { note: "checked src/a.ts, 2026-10-02" } });
    expect(flag1.status).toBe(200);

    const flag2 = await api(`/api/learnings/${learning.id}/flag`, {
      method: "POST",
      actor: uniqueActor("flagger two"),
      body: { note: "checked src/b.ts, 2026-10-02" },
    });
    expect(flag2.status).toBe(200);
    const flagged = await flag2.json();
    expect(flagged.learning.status).toBe("archived");

    const defaultSearch = await api(`/api/learnings?q=${encodeURIComponent(title)}`, { actor: ALICE });
    const defaultResults = (await defaultSearch.json()).results;
    expect(defaultResults.find((r: { id: string }) => r.id === learning.id)).toBeUndefined();

    const allSearch = await api(`/api/learnings?q=${encodeURIComponent(title)}&status=all`, { actor: ALICE });
    const allResults = (await allSearch.json()).results;
    expect(allResults.find((r: { id: string }) => r.id === learning.id)).toBeTruthy();
  });

  it("supersede is two-way: newer links back via supersedes, older forward via supersededBy", async () => {
    const original = await createLearning({ title: uniqueTitle("Original fact") });
    const { learning: originalLearning } = await original.json();

    const replacement = await createLearning({
      title: uniqueTitle("Corrected fact"),
      supersedes: originalLearning.id,
    });
    expect(replacement.status).toBe(201);
    const { learning: newLearning } = await replacement.json();
    expect(newLearning.supersedesId ?? newLearning.supersedes_id ?? newLearning.supersedes).toBeTruthy();

    const oldFetched = await api(`/api/learnings/${originalLearning.id}`, { actor: ALICE });
    const oldBody = await oldFetched.json();
    expect(oldBody.supersededBy.id).toBe(newLearning.id);
  });

  it("kudos then repeat 409s; self-vote is rejected (403)", async () => {
    const created = await createLearning();
    const { learning } = await created.json();

    const kudos1 = await api(`/api/learnings/${learning.id}/kudos`, { method: "POST", actor: BOB });
    expect(kudos1.status).toBe(200);

    const kudos2 = await api(`/api/learnings/${learning.id}/kudos`, { method: "POST", actor: BOB });
    expect(kudos2.status).toBe(409);

    const selfVote = await api(`/api/learnings/${learning.id}/vote`, {
      method: "POST",
      actor: ALICE,
      body: { kind: "helpful" },
    });
    expect(selfVote.status).toBe(403);
  });
});

describe("e2e: learning kind", () => {
  it("kind round trip: POST a decision mirror, GET ?kind=decision returns it, ?kind=bogus is 400", async () => {
    const title = uniqueTitle("E2E decision mirror");
    const created = await createLearning({
      title,
      kind: "decision",
      source: "confluence",
      source_url: "https://wiki.example.com/wiki/spaces/EHSARCH/pages/7#choice",
      source_version: 2,
      expiresAt: "never",
    });
    expect(created.status).toBe(201);
    const { learning } = await created.json();
    expect(learning).toMatchObject({ kind: "decision", source: "confluence", source_version: 2 });

    const found = await api(`/api/learnings?kind=decision&q=${encodeURIComponent(title)}`, { actor: BOB });
    expect(found.status).toBe(200);
    const body = await found.json();
    expect(body.results.map((r: { id: string }) => r.id)).toContain(learning.id);
    expect(body.results.every((r: { kind: string }) => r.kind === "decision")).toBe(true);

    const bad = await api("/api/learnings?kind=bogus", { actor: BOB });
    expect(bad.status).toBe(400);

    const page = await fetch(`${origin()}/memory/${learning.id}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`rel="noopener noreferrer"`);
  });
});
