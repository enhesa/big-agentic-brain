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

  it("plays the short film as an animated drawing, with the video as a download", () => {
    expect(html).toContain('id="film"');
    const film = html.match(/<svg\b[^>]*id="film-svg"[^>]*>[\s\S]*?<\/svg>/)?.[0] ?? "";
    expect(film).toMatch(/^<svg\b[^>]*role="img"[^>]*aria-label="The Big Agentic Brain film"/);
    // The film says in drawing what the film's story module says in data.
    for (const words of ["Every", "zero.", "swarm", "MEASURED", "12%", "79%", "Agentic"]) expect(film).toContain(words);
    // One shared clock: every animation runs the film's 45 seconds, or the brain's own breath.
    const clocks = new Set([...film.matchAll(/\bdur="([^"]+)"/g)].map((m) => m[1]));
    expect([...clocks].sort()).toEqual(["2.6s", "45s"]);
    expect(film).not.toMatch(/<script|<foreignObject|\bon[a-z]+=/);
    // Every animation is well formed: its times run from 0 to 1 in order, with an easing per step.
    const animations = [...film.matchAll(/<animate(?:Transform|Motion)?\b[^>]*>/g)].map((m) => m[0]);
    expect(animations.length).toBeGreaterThan(100);
    for (const animation of animations) {
      const times = animation.match(/keyTimes="([^"]+)"/)?.[1].split(";").map(Number);
      if (!times) continue; // the breath, which has no key times
      expect(times[0], animation).toBe(0);
      expect(times.every((t, i) => i === 0 || t > times[i - 1]), animation).toBe(true);
      const splines = animation.match(/keySplines="([^"]+)"/)?.[1].split(";");
      if (splines) {
        expect(times[times.length - 1], animation).toBe(1);
        expect(splines, animation).toHaveLength(times.length - 1);
        for (const n of splines.join(" ").split(" ").map(Number)) expect(n >= 0 && n <= 1, animation).toBe(true);
      }
    }
    // Small enough to send with the page.
    expect(film.length).toBeLessThan(150_000);
    // No video player: the video is a download, and nothing fetches it unasked.
    expect(html).not.toContain("<video");
    expect(html).toMatch(/<a\b[^>]*href="\/showcase\.mp4"[^>]*download=/);
    // People can stop it.
    expect(html).toMatch(/<button\b[^>]*aria-controls="film-svg"[^>]*>Pause<\/button>/);
    expect(html).toMatch(/<button\b[^>]*aria-controls="film-svg"[^>]*>Restart<\/button>/);
    // The film has no sound, so the page says what happens in it instead of captions.
    expect(film).toContain('aria-describedby="film-story"');
    expect(html).toContain('id="film-story"');
    // And scene by scene for people who cannot see it, with the same figures the film shows.
    const scenes = html.match(/<ol\b[^>]*aria-label="What the film shows"[^>]*>([\s\S]*?)<\/ol>/)?.[1] ?? "";
    expect(scenes.match(/<li>/g)).toHaveLength(7);
    expect(scenes).toContain("for bugs that need team knowledge: 12% fixed without BAB, 79% with it");
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
    for (const word of ["MCP", "SQLite", "FTS5", "redaction", "rate limit", "one pod"]) {
      expect(html).not.toContain(word);
    }
  });

  it("invents no numbers: the stats band only renders real counts", () => {
    // The render runs against an empty database, so the band must be absent.
    expect(html).not.toContain("In the brain right now");
    expect(html).not.toContain("500+");
  });

  it("draws everything inline, with no image beyond the wordmark and the install screenshot", () => {
    expect(html).toContain("<svg");
    expect((html.match(/<img/g) ?? []).length).toBe(3);
    expect(html).toContain("/branding/logo-light.svg");
    expect(html).toContain('src="/install/claude-app-plugins.png"');
  });
});
