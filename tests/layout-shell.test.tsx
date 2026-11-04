import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Every page shares one footer and one page width, so the top bar sits on the same pixels
 * on every page (decided: "all pages have the same max width, so the navbar is not jumpy").
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const FOOTER_LINKS = ['href="/memory"', 'href="/docs"', 'href="/changelog"', 'href="/feedback"'];

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-layout-test-"));
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

function footerOf(html: string): string {
  const m = html.match(/<footer[\s\S]*<\/footer>/);
  expect(m, "the page renders a footer").not.toBeNull();
  return m![0];
}

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "api") continue;
      out.push(...pageFiles(full));
    } else if (name === "page.tsx") {
      out.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  }
  return out;
}

describe("one footer on every page", () => {
  it("the Shell renders the home page footer with all its links", async () => {
    const { default: Shell } = await import("../app/components/shell/Shell");
    const footer = footerOf(renderToStaticMarkup(Shell({ children: <div>content</div> })));
    for (const link of FOOTER_LINKS) expect(footer).toContain(link);
  });

  it("the home page, /docs and /changelog render the same footer", async () => {
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: Home } = await import("../app/page");
    const home = (await new Response(await renderToReadableStream(<Home />)).text()).replace(/<!-- -->/g, "");
    const { default: DocsPage } = await import("../app/docs/page");
    const docs = renderToStaticMarkup(await DocsPage());
    const { default: ChangelogPage } = await import("../app/changelog/page");
    const changelog = renderToStaticMarkup(await ChangelogPage());

    const footers = [home, docs, changelog].map((html) => footerOf(html).replace(/<!-- -->/g, ""));
    for (const footer of footers) {
      for (const link of FOOTER_LINKS) expect(footer).toContain(link);
    }
    expect(footers[1]).toBe(footers[0]);
    expect(footers[2]).toBe(footers[0]);
  });

  it("every page either renders the Shell, is the home page with the shared footer, or only redirects", () => {
    const pages = pageFiles(path.join(ROOT, "app"));
    expect(pages.length).toBeGreaterThan(10);
    for (const file of pages) {
      const src = read(file);
      if (file === "app/page.tsx") {
        expect(src).toContain('from "./components/shell/Footer"');
        continue;
      }
      if (/\bredirect\(/.test(src) && !src.includes("<")) continue;
      const redirectOnly = /\bredirect\(/.test(src) && !/return\s*\(?\s*</.test(src);
      if (redirectOnly) continue;
      expect(src, `${file} renders inside the Shell, so it gets the footer and the shared width`).toContain("<Shell");
    }
  });

  it("there is one footer component", () => {
    const landing = readdirSync(path.join(ROOT, "app/components/landing"));
    expect(landing).not.toContain("Footer.tsx");
  });
});

describe("one page width", () => {
  const globals = read("app/globals.css");

  it("globals.css defines the width token once", () => {
    expect(globals.match(/--shell-max-width:\s*\d+px;/g)).toHaveLength(1);
    expect(globals).toMatch(/--shell-gutter:\s*\d+px;/);
    expect(globals).toMatch(/scrollbar-gutter:\s*stable/);
  });

  it("the inner pages' container and the home page wrap both read the token", () => {
    const container = globals.match(/\.container\s*\{[^}]*\}/)![0];
    expect(container).toContain("max-width: var(--shell-max-width)");
    expect(container).toContain("padding: 0 var(--shell-gutter)");
    const wrap = read("app/landing.module.css").match(/\.wrap\s*\{[^}]*\}/)![0];
    expect(wrap).toContain("max-width: var(--shell-max-width)");
    expect(wrap).toContain("padding: 0 var(--shell-gutter)");
  });

  it("both top bars and the footer sit in that box", () => {
    expect(read("app/components/shell/TopNav.tsx")).toMatch(/className=\{`container /);
    expect(read("app/components/landing/TopBar.tsx")).toContain("styles.wrap");
    expect(read("app/components/shell/Footer.tsx")).toMatch(/className=\{`container /);
  });

  it("both bars reserve the bold width of each link, so the current page does not nudge the nav", () => {
    for (const file of ["app/components/shell/TopNav.tsx", "app/components/landing/TopBar.tsx"]) {
      expect(read(file)).toContain("data-label={item.label}");
    }
    for (const file of ["app/components/shell/Shell.module.css", "app/landing.module.css"]) {
      expect(read(file)).toMatch(/\.navLink::before\s*\{[^}]*content:\s*attr\(data-label\)[^}]*font-weight:\s*600/);
    }
  });

  it("no stylesheet outside the token hard-codes the old page widths", () => {
    const cssFiles: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".css")) cssFiles.push(full);
      }
    };
    walk(path.join(ROOT, "app"));
    for (const file of cssFiles) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/(?<!-)max-width:\s*(1160|1180)px/);
    }
  });
});
