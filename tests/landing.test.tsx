import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToReadableStream } from "react-dom/server.edge";

// The live-numbers band reads the database: point it at an empty one, never at the
// developer's local brain, so the render is the same on every machine.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bab-landing-"));
const { default: Home } = await import("../app/page");

// The page contains an async server component, so it needs the streaming
// renderer rather than the synchronous renderToStaticMarkup.
const html = await new Response(await renderToReadableStream(<Home />)).text();

/** Strips tags and decodes the few entities the page actually uses. */
const textOf = (fragment: string) =>
  fragment
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&copy;/g, "(c)")
    .replace(/\s+/g, " ")
    .trim();

describe("landing page", () => {
  it("labels the headline for screen readers", () => {
    expect(html).toContain('aria-label="One brain. Every agent."');
  });

  it("exposes the section anchor ids", () => {
    expect(html).toContain('id="how-it-works"');
    expect(html).toContain('id="what-it-holds"');
    expect(html).toContain('id="rules"');
    expect(html).toContain('id="get-started"');
  });

  it("links to the memory", () => {
    expect(html).toContain('href="/memory"');
  });

  it("installs through the opt-in plugin, not the old paste-in prompt", () => {
    expect(html).toContain("/plugin install bab@acme-plugins");
    expect(html).toContain("/plugin marketplace add acme/claude-plugins");
    expect(html).not.toContain("/instructions/install.md");
  });

  it("tells the story as a five-step diagram whose first scene is server-rendered", () => {
    expect(html).toContain("How it works, in five steps");
    expect(html).toContain("THE BRAIN");
    for (const who of ["Alice", "Bob", "Carl", "Dana"]) expect(html).toContain(who);
    for (const step of ["Save", "Find", "Ask", "Remind", "Everyone"]) expect(html).toContain(step);
    expect(html).toContain("Alice&#x27;s agent learns something.");
  });

  it("shows one example of each of the three things it holds", () => {
    for (const kind of ["Memories", "Reminders", "Messages"]) expect(html).toContain(kind);
  });

  it("answers the common how-do-I questions in a FAQ", () => {
    expect(html).toContain('id="faq"');
    expect(html).not.toContain("<details");
    expect(html).toContain("A decision, delete or message needs your yes.");
    expect(html).toContain("How does BAB save memories?");
  });

  it("states the four house rules", () => {
    for (const rule of ["Acts only as you", "Asks before saving", "Reference, not orders", "Everything audited"]) {
      expect(html).toContain(rule);
    }
  });

  it("keeps every paragraph to 20 words or fewer", () => {
    const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => textOf(m[1]));
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const p of paragraphs) {
      expect(p.split(" ").filter(Boolean).length, p).toBeLessThanOrEqual(20);
    }
  });

  it("drops the technical architecture vocabulary", () => {
    for (const word of ["MCP", "SQLite", "FTS5", "Forge", "redaction", "rate limit", "one pod"]) {
      expect(html).not.toContain(word);
    }
  });

  it("invents no numbers: the stats band only renders real counts", () => {
    // The render runs against an empty database, so the band must be absent.
    expect(html).not.toContain("In the brain right now");
    expect(html).not.toContain("500+");
  });

  it("draws everything inline, with no external image beyond the wordmark", () => {
    expect(html).toContain("<svg");
    expect((html.match(/<img/g) ?? []).length).toBe(2);
    expect(html).toContain("/branding/logo-light.svg");
  });
});
