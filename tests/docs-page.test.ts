import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /docs is the only page that explains the system to a human, so its claims have to
 * track the code. The assertions below are the ones that would quietly become lies if
 * someone reintroduced a background process or a script to install, or brought back the
 * expiry that was replaced on 2026-10-07.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-docs-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

async function render() {
  const { default: DocsPage } = await import("../app/docs/page");
  return renderToStaticMarkup(await DocsPage());
}

const DOCS_DIR = path.join(__dirname, "..", "app", "docs");

/** The visible words: tags and their attributes (so the aria-labels) are not text on the page. */
function visibleWords(html: string): number {
  return html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
}

/** Every opening `<svg ...>` tag on the page. */
function svgTags(html: string): string[] {
  return html.match(/<svg\b[^>]*>/g) ?? [];
}

/** The page's sections, as the h2 headings people read. */
const SECTIONS = ["Memories", "Trust and care", "Messages and reminders", "About BAB", "Under the hood"];

/** Every use case on the page, by its diagram title. */
const DIAGRAMS = [
  // Memories
  "A memory&#x27;s life",
  "Kinds of memory",
  "Saving something worth keeping",
  "Duplicate guard",
  "Masking",
  "How search ranks",
  "Answering a question",
  "Before a change",
  // Trust and care
  "Reacting to a memory",
  "Correcting or retiring",
  "House rules",
  "Who you are",
  // Messages and reminders
  "Messaging a colleague",
  "Asking for a review",
  "A note to yourself",
  "What BAB tells your session",
  "The inbox",
  "Reminders",
  "Files and keys",
  // About BAB
  "Feedback about BAB",
  "Seeing how BAB is used",
  // Under the hood
  "Deployment",
  "The data",
  "A request&#x27;s path",
  "What keeps itself tidy",
];

/** The stylesheet without its comments, as rules: a selector list and the declarations it gets. */
function cssRules(): { selectors: string[]; body: string }[] {
  const css = readFileSync(path.join(DOCS_DIR, "docs.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector.split(",").map((s) => s.trim()),
    body,
  }));
}

/** Everything the stylesheet says about one class. */
function declarationsOf(cssClass: string): string {
  return cssRules()
    .filter((rule) => rule.selectors.includes(`.${cssClass}`))
    .map((rule) => rule.body)
    .join(";");
}

describe("/docs", () => {
  it("renders without an identity, like the other read-only pages", async () => {
    const html = await render();
    expect(html).toContain("How it works");
  });

  it("draws the diagram with a text alternative, not just boxes", async () => {
    const html = await render();
    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="[^"]{80,}"/);
  });

  it("gives every diagram its own text alternative of a full sentence", async () => {
    const html = await render();
    const tags = svgTags(html);
    // The architecture diagram, one per use case, and the lifecycle's second layout: a wide and a
    // tall drawing of the same states, of which CSS shows one (see LifecycleDiagram).
    expect(tags.length).toBe(DIAGRAMS.length + 2);
    for (const tag of tags) {
      expect(tag).toContain('role="img"');
      expect(tag).toMatch(/aria-label="[^"]{80,}"/);
    }
  });

  it("states the two things people get wrong: no daemon or listener (only the optional inbox pill polls), and who can read what", async () => {
    const html = await render();
    expect(html).toContain("No daemon, no listener");
    expect(html).toContain("only the optional inbox pill polls, every 15 seconds");
    expect(html).toContain("Memories are readable by everyone at Acme");
    expect(html).toContain("Messages are visible to the people in the thread and to maintainers");
    expect(html).toContain("Only your reminders are private");
  });

  it("describes messaging as inbox only: no sessions to address, no presence, no long-poll", async () => {
    const html = await render();
    expect(html).toContain("into their inbox");
    expect(html).not.toMatch(/toSession|presence|listening|inbox\/wait|long-poll/i);
  });

  it("shows what is installed, and does not promise a script or a daemon", async () => {
    const html = await render();
    expect(html).toContain("Four skills");
    expect(html).toContain("Three hooks");
    expect(html).toContain("Twelve tools");
    expect(html).toContain("four with ?tools=lean");
    expect(html).not.toMatch(/listen\.mjs|hook\.mjs|guard\.mjs/);
    // The old install, with its curl hooks and permission rules, is not what the card draws any more.
    expect(html).not.toMatch(/Two curl hooks|Two permission rules/);
  });

  it("names the Next.js and Node majors the build really uses (docs guardrail)", async () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const nextMajor = pkg.dependencies.next.replace(/^[^\d]*/, "").split(".")[0];
    const dockerfile = readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
    const nodeMajor = /node:(\d+)/.exec(dockerfile)?.[1];
    expect(nodeMajor).toBeTruthy();
    const html = await render();
    expect(html).toContain(`Next.js ${nextMajor} `);
    expect(html).toContain(`Node ${nodeMajor} `);
  });

  it("draws the lean tool list the way the code does", async () => {
    const { LEAN_TOOL_NAMES } = await import("../lib/mcp");
    const html = await render();
    expect(html).toContain("?tools=lean");
    expect(LEAN_TOOL_NAMES).toHaveLength(4);
  });

  it("names every MCP tool, so the page cannot fall behind lib/mcp.ts (docs drift check)", async () => {
    const { TOOLS } = await import("../lib/mcp");
    const html = await render();
    const missing = TOOLS.map((t) => t.name).filter((name) => !html.includes(name));
    expect(missing, "name these tools on /docs (the architecture text alternative lists them)").toEqual([]);
  });

  it("describes the newer features: files, keys, comments, web votes, new-device notices and the footer links", async () => {
    const html = await render();
    expect(html).toContain("Files and keys");
    expect(html).toContain("25 MB a file, 100 MB each");
    expect(html).toContain("14 days, 30 at most");
    expect(html).toContain("shared, plus a message");
    expect(html).toContain("locks, counters, a shared pace");
    expect(html).toContain("Never secrets or customer data");
    expect(html).toContain("context, also on the web");
    expect(html).toContain("search, vote, comment");
    expect(html).toContain("a new device as you: told once");
    expect(html).toContain("Docs and Feedback: home page footer");
    expect(html).toContain("file_shares");
  });

  it("counts the tools the way the code does", async () => {
    // The card says twelve tools. Add or remove one in lib/mcp.ts and this fails, so the card, and
    // its list of what the tools do, get a look in the same change.
    const { TOOLS } = await import("../lib/mcp");
    expect(TOOLS).toHaveLength(12);
  });

  // The whole complaint that produced this page was that it read like an essay.
  it("draws each use case instead of describing it", async () => {
    const html = await render();
    for (const diagram of DIAGRAMS) {
      expect(html).toContain(diagram);
    }
    // Sections are a heading and one caption line each, over a grid of diagrams.
    for (const section of SECTIONS) {
      expect(html).toMatch(new RegExp(`<h2[^>]*>${section}</h2>`));
    }
    // The cap is deliberate. The page is diagrams, not essays: it grew from 400 words to this
    // when it went from four use cases to every feature (2026-10-07), and it measures about 910
    // now, about 90 of them the lifecycle's tall layout repeating the wide one. It went from 900
    // to 1000 for the four diagrams that came last (duplicate guard, masking, messaging one
    // session, what BAB tells your session). It went from 1000 to 1330 for "Under the hood" (2026-10-08), then 1350 for the failed-command note:
    // four technical drawings whose labels (table names, paths, numbers) add about 375 words to the
    // page's 925 or so, 1315 in all. If a change pushes past the cap, shorten a label or
    // cut a diagram's detail instead of raising the number: a step that needs a sentence is the
    // wrong step.
    expect(visibleWords(html)).toBeLessThan(1350);
  });

  it("keeps the prose to a lede, a caption for each section and a footnote", async () => {
    const html = await render();
    const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
    const words = (text: string) => text.split(/\s+/).length;
    // In page order: the lede, then one caption per section, then the footnote. Nothing else is prose.
    expect(paragraphs).toHaveLength(SECTIONS.length + 2);
    const [lede, ...rest] = paragraphs;
    const footnote = rest.pop()!;
    expect(words(lede), lede).toBeLessThanOrEqual(25);
    expect(words(footnote), footnote).toBeLessThanOrEqual(25);
    for (const caption of rest) {
      expect(words(caption), caption).toBeLessThanOrEqual(12);
    }
  });

  it("never needs a script, a form or a client component", async () => {
    const html = await render();
    expect(html).not.toMatch(/<script|<form|<input|<textarea/i);

    for (const file of readdirSync(DOCS_DIR).filter((f) => /\.tsx?$/.test(f))) {
      const source = readFileSync(path.join(DOCS_DIR, file), "utf8");
      expect(source, `${file} must stay a server component`).not.toMatch(/^\s*["']use client["']/m);
    }
  });

  it("gives every element id once, so the arrowheads of two diagrams never share a name", async () => {
    const html = await render();
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(DIAGRAMS.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("handles reduced motion in CSS: with a request for less movement the arrows are simply drawn", () => {
    const css = readFileSync(path.join(DOCS_DIR, "docs.module.css"), "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.step\s*\{[^}]*opacity:\s*1[^}]*animation:\s*none/);
  });

  describe("arrows", () => {
    // Decided: arrowheads are solid, never semi-transparent, in light and dark mode.
    it("draws every arrowhead solid, in a theme token", () => {
      for (const head of ["arrowHead", "arrowHeadTeal"]) {
        const body = declarationsOf(head);
        expect(body, `.${head} needs a fill`).toMatch(/fill:\s*var\(--(steel|teal)\)/);
        // Neither `opacity` nor `fill-opacity`.
        expect(body, `.${head} must not be see-through`).not.toMatch(/opacity/);
      }
    });

    it("puts no opacity on anything that carries an arrowhead, or on any group around one", () => {
      // A marker is drawn as part of the element it ends, so `opacity` on that element fades the
      // head with it. A line that should look lighter takes `stroke-opacity`, which leaves the head alone.
      for (const carrier of ["edge", "arrow", "arrowBack", "lcEdge", "lcEdgeGood", "fanEdge"]) {
        expect(declarationsOf(carrier), `.${carrier} carries an arrowhead`).not.toMatch(/(^|[;\s])opacity\s*:/);
      }
      // The only `opacity` in the stylesheet is the fade-in of a step, which ends at full opacity.
      const fading = new Set(
        cssRules()
          .filter((rule) => /(^|[;\s])opacity\s*:/.test(rule.body))
          .flatMap((rule) => rule.selectors),
      );
      expect(fading).toEqual(new Set([".step", "from", "to"]));
      expect(declarationsOf("step")).toMatch(/animation:[^;]*forwards/);
    });

    it("puts the tip of every arrowhead on the end of its path, pointing along it", async () => {
      const html = await render();
      const markers = html.match(/<marker\b[^>]*>/g) ?? [];
      expect(markers.length).toBeGreaterThan(DIAGRAMS.length);
      for (const marker of markers) {
        // The head is the triangle (0 0) (8 4) (0 8): its tip is (8, 4), and that is the reference point.
        expect(marker).toContain('refX="8"');
        expect(marker).toContain('refY="4"');
        expect(marker).toContain('orient="auto"');
      }
      expect(html).not.toMatch(/\s(fill-|stroke-)?opacity="/);
    });

    it("ends every connector of a fan exactly on the left edge of its chip, on a straight stretch", async () => {
      const html = await render();
      const fans = (html.match(/<svg\b[\s\S]*?<\/svg>/g) ?? []).filter((svg) => svg.includes("fanEdge"));
      // Kinds, Duplicate guard, Masking, Reacting, Correcting and Seeing.
      expect(fans.length).toBeGreaterThanOrEqual(6);
      for (const svg of fans) {
        const chips = new Set([...svg.matchAll(/<rect class="[^"]*chipTeal[^"]*" x="([\d.]+)"/g)].map((m) => Number(m[1])));
        const paths = [...svg.matchAll(/<path class="[^"]*fanEdge[^"]*" d="([^"]*)"/g)].map((m) => m[1]);
        expect(paths.length).toBeGreaterThan(0);
        expect(chips.size).toBe(1);
        for (const d of paths) {
          const end = Number(d.match(/H([\d.]+)$/)?.[1]);
          expect(chips.has(end), `${d} should end at a chip's left edge`).toBe(true);
          // A curve hands over to a straight run at least as long as the head (8px).
          const bend = d.match(/,\s*([\d.]+) [\d.]+ H[\d.]+$/);
          if (bend) expect(end - Number(bend[1])).toBeGreaterThanOrEqual(8);
        }
      }
    });
  });

  describe("a memory's life", () => {
    it("draws the memory lifecycle: read, archived after a year, kept, never archived this way", async () => {
      const html = await render();
      const tag = svgTags(html).find((t) => t.includes("A memory&#x27;s life"));
      expect(tag).toBeDefined();
      const label = tag!;
      // An unread memory is archived after a year, and the date it first can be.
      expect(label).toMatch(/unread memory is archived after a year/i);
      expect(label).toContain("7 Oct 2027");
      // What is exempt, and what does not count as a read.
      expect(label).toMatch(/standards, decisions and pinned house rules are never archived this way/i);
      expect(label).toMatch(/a person opening a page does not count/i);
      // The two ways back and forth that were decided.
      expect(label).toMatch(/valid-until date/i);
      expect(label).toMatch(/keep, with a note/i);
      // The same facts are drawn, not only spoken.
      for (const drawn of [
        "no agent read it for a year",
        "its valid-until date passed",
        "keep: anyone, with a note",
        "Counts as a read",
        "Does not count",
        "a person opening a page",
        "Never archived this way",
        "standards",
        "decisions",
        "pinned house rules",
      ]) {
        expect(html).toContain(drawn);
      }
    });

    it("is drawn wide and tall, and CSS shows one of the two", async () => {
      const html = await render();
      expect(svgTags(html).filter((t) => t.includes("A memory&#x27;s life"))).toHaveLength(2);
      const css = readFileSync(path.join(DOCS_DIR, "docs.module.css"), "utf8");
      expect(css).toMatch(/\.lifeNarrow\s*\{\s*display:\s*none/);
      expect(css).toMatch(/@media \(max-width: 740px\)\s*\{[^}]*\.lifeWide\s*\{\s*display:\s*none[^}]*\}[^}]*\.lifeNarrow\s*\{\s*display:\s*block/);
    });

    it("never mentions the expiry that was retired in favour of archiving unread memories", async () => {
      const html = await render();
      expect(html).not.toMatch(/expire soon|expiring/i);
      // 180 days is the audit log's retention now, drawn under the hood. Before that section it was the
      // old expiry window, so everything above it must still be free of it.
      expect(html.slice(0, html.indexOf('id="under-the-hood-h"'))).not.toMatch(/180 days/i);
    });
  });

  describe("under the hood", () => {
    /** The opening `<svg ...>` tag of the diagram with this title, or its aria-label text. */
    async function labelOf(title: string): Promise<string> {
      const html = await render();
      const tag = svgTags(html).find((t) => t.includes(`aria-label="${title}`));
      expect(tag, `${title} should be drawn`).toBeDefined();
      return tag!;
    }

    it("is the last section, with the four drawings in order", async () => {
      const html = await render();
      const from = html.indexOf('id="under-the-hood-h"');
      expect(from).toBeGreaterThan(html.indexOf('id="about-h"'));
      const section = html.slice(from);
      const positions = ["Deployment", "The data", "A request&#x27;s path", "What keeps itself tidy"].map((t) => section.indexOf(t));
      expect(positions.every((p) => p > 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it("draws the deployment: SQLite in WAL mode on a persistent volume, one container behind the reverse proxy", async () => {
      const label = await labelOf("Deployment");
      expect(label).toContain("SQLite");
      expect(label).toContain("WAL");
      expect(label).toMatch(/persistent volume/i);
      expect(label).toMatch(/reverse proxy/);
      expect(label).toMatch(/one container/i);
    });

    it("draws the tables that matter, and counts the migrations the way the code does", async () => {
      const label = await labelOf("The data");
      for (const table of ["learnings", "votes", "threads", "messages", "todos", "users", "audit_log"]) {
        expect(label, table).toContain(table);
      }
      const { CURRENT_VERSION } = await import("../lib/db");
      expect(label).toContain(`numbered 1 to ${CURRENT_VERSION}`);
      const AUDIT_RETENTION_DAYS = (await import("../lib/config")).config().retention.auditDays;
      expect(label).toContain(`audit_log, kept ${AUDIT_RETENTION_DAYS} days`);
    });

    it("does not draw tables a migration dropped", async () => {
      const label = await labelOf("The data");
      for (const dropped of ["api_tokens", "device_connects", "push_subscriptions"]) {
        expect(label, dropped).not.toContain(dropped);
      }
    });

    it("draws a request in the order the code does it: through the proxy, identity and limit, audit, then the search", async () => {
      const label = await labelOf("A request&#x27;s path");
      const order = ["POST /mcp", "public path", "a minute limit", "audit_log", "FTS5", "record agent reads", "JSON"].map((t) => label.indexOf(t));
      expect(order.every((p) => p > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      const { RATE_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
      expect(label).toContain(`${RATE_LIMIT_PER_MINUTE} a minute limit`);
    });

    it("draws what the hourly sweep keeps tidy, with the windows from the code", async () => {
      const label = await labelOf("What keeps itself tidy");
      expect(label).toMatch(/a year/);
      expect(label).toContain(`${(await import("../lib/config")).config().retention.auditDays} days`);
      expect(label).toMatch(/30 days/);
      expect(label).toMatch(/90 days/);
      expect(label).toMatch(/7 days/);
      expect(label).toMatch(/500 rows/);
      expect(label).toMatch(/every 20 h/);
    });
  });
});
