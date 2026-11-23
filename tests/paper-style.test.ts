import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The paper look, pinned for every page at once: no white card, no card shadow, no text under
 * 12 pixels, no white text on a bright fill, motion that can be switched off, and no class a
 * page asks for that its stylesheet does not have. tests/memory-style.test.ts and
 * tests/inbox-style.test.ts pin the details of their own pages.
 */

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
/** A stylesheet without its comments, so a value named only in a comment does not count. */
const sheet = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "");

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) cssFiles(p, out);
    else if (entry.name.endsWith(".css")) out.push(p);
  }
  return out;
}

const ALL = cssFiles("app");
const globals = sheet("app/globals.css");

/** Every rule for the selector in one stylesheet. A selector that is gone fails the test. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = css.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`, "g"));
  expect(found, `${selector} has a rule`).not.toBeNull();
  return found!.join("\n");
}

/** A colour token from :root, as [r, g, b] and alpha. */
function token(name: string): { rgb: [number, number, number]; alpha: number } {
  const raw = globals.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  expect(raw, `${name} is defined`).toBeTruthy();
  // A token an operator may override, such as var(--accent, #1a3360), counts as its default.
  const value = raw!.match(/^var\(--[a-z-]+,\s*(#[0-9a-f]{6})\)$/i)?.[1] ?? raw;
  const hex = value!.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = value!.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
  expect(rgba, `${name} is a hex or rgba colour`).not.toBeNull();
  return { rgb: [Number(rgba![1]), Number(rgba![2]), Number(rgba![3])], alpha: Number(rgba![4]) };
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast of a token on a ground token. A see-through colour is laid on the ground first. */
function contrast(fg: string | [number, number, number], ground: string): number {
  const g = token(ground).rgb;
  let f: [number, number, number];
  if (typeof fg === "string") {
    const t = token(fg);
    f = t.rgb.map((v, i) => v * t.alpha + g[i] * (1 - t.alpha)) as [number, number, number];
  } else f = fg;
  const [a, b] = [luminance(f), luminance(g)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** The class names a component reads from the stylesheet it imports under this name. */
function used(file: string, name: "styles" | "buttons"): string[] {
  return [...new Set([...read(file).matchAll(new RegExp(`\\b${name}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"))].map((m) => m[1]))];
}

/** Every rule that sets a transition or an animation, by selector. */
function movingSelectors(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (/\b(transition|animation)(-[a-z-]+)?:\s*(?!none\b)/.test(m[2])) out.push(m[1].trim());
  }
  return out;
}

/** The stylesheet split in two: the text inside every prefers-reduced-motion block of this kind, and the rest. */
function motionBlocks(css: string, kind: "reduce" | "no-preference"): { inside: string; rest: string } {
  let inside = "";
  let rest = "";
  let from = 0;
  for (const m of css.matchAll(new RegExp(`@media[^{]*prefers-reduced-motion:\\s*${kind}[^{]*\\{`, "g"))) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    inside += css.slice(start, i);
    rest += css.slice(from, m.index!);
    from = i;
  }
  return { inside, rest: rest + css.slice(from) };
}

describe("the paper look on every page", () => {
  it("has no white or grey ground of its own", () => {
    for (const file of ALL) {
      expect(sheet(file), file).not.toMatch(/background(-color)?:\s*(#fff(fff)?|white)\b/i);
      // A page's own ground token (surface, plane, card) is never white either: it is a sheet.
      expect(sheet(file), file).not.toMatch(/--[\w-]*(surface|plane|card|ground|bg)[\w-]*:\s*(#fff(fff)?|white)\b/i);
    }
  });

  it("gives no card a shadow: a sheet has a hairline edge", () => {
    for (const file of ALL) {
      for (const m of sheet(file).matchAll(/box-shadow:\s*([^;]+);/g)) {
        const value = m[1].trim();
        // A ring (no blur, no offset) and an inset line are marks, not shadows.
        const ok = value === "none" || value.startsWith("inset") || /^0 0 0 /.test(value);
        expect(ok, `${file}: box-shadow: ${value}`).toBe(true);
      }
      expect(sheet(file), file).not.toMatch(/drop-shadow\(/);
    }
  });

  it("sets no text under 12 pixels", () => {
    // Text inside a drawing is sized in the drawing's own units and scales with it.
    const drawings: Record<string, RegExp> = { "app/docs/docs.module.css": /./, "app/landing.module.css": /\.glabel\b/ };
    for (const file of ALL) {
      const css = sheet(file);
      for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const size = m[2].match(/font-size:\s*([\d.]+)(rem|px)\b/);
        if (!size) continue;
        const px = size[2] === "rem" ? Number(size[1]) * 16 : Number(size[1]);
        if (px >= 12) continue;
        expect(drawings[file]?.test(m[1]) ?? false, `${file}: ${m[1].trim()} is ${size[1]}${size[2]}`).toBe(true);
      }
    }
  });

  it("lets every transition and animation be switched off", () => {
    for (const file of ALL) {
      const css = sheet(file);
      // Motion that only runs when nobody asked for less is already calm.
      const moving = movingSelectors(motionBlocks(css, "no-preference").rest);
      if (moving.length === 0) continue;
      const calm = motionBlocks(css, "reduce").inside;
      expect(calm, `${file} has a prefers-reduced-motion block`).not.toBe("");
      // A block that calms everything (*) covers the file. Otherwise each moving rule is named.
      if (/(^|[\s,}])\*/.test(calm)) continue;
      for (const selector of moving) {
        const names = [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
        const named = names.length === 0 ? calm.includes(selector.split(",")[0].trim()) : names.some((n) => new RegExp(`\\.${n}(?![\\w-])`).test(calm));
        expect(named, `${file}: ${selector.replace(/\s+/g, " ")} moves, and reduced motion does not calm it`).toBe(true);
      }
    }
  });

  it("keeps words and edges readable on paper, on a sheet and on sand", () => {
    // White text only on navy or the dark red; the bright coral is 3.2 to 1 with white.
    expect(contrast([255, 255, 255], "--alert")).toBeGreaterThanOrEqual(4.5);
    expect(contrast([255, 255, 255], "--navy")).toBeGreaterThanOrEqual(4.5);
    expect(contrast([255, 255, 255], "--coral")).toBeLessThan(4.5);
    for (const ground of ["--paper", "--sheet", "--sand"]) {
      for (const ink of ["--navy", "--steel", "--teal-ink", "--alert-ink", "--amber-ink", "--green-ink"]) {
        expect(contrast(ink, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // A field's edge is a control boundary: 3 to 1 against the page and the sheet.
    expect(contrast("--field-edge", "--paper")).toBeGreaterThanOrEqual(3);
    expect(contrast("--field-edge", "--sheet")).toBeGreaterThanOrEqual(3);
  });

  it("draws the unread count in white on the dark red, in the top bar and in the Inbox", () => {
    for (const [file, selector] of [
      ["app/components/shell/InboxBadge.module.css", ".badge"],
      ["app/inbox/inbox.module.css", ".unread"],
    ] as const) {
      const badge = rule(sheet(file), selector);
      expect(badge, file).toContain("background: var(--alert)");
      expect(badge, file).toMatch(/color:\s*#fff/);
      expect(badge, file).not.toContain("var(--coral)");
    }
  });

  it("has the shared parts every page builds on", () => {
    for (const selector of [".page-title", ".page-lede", ".btn-primary", ".btn-quiet", ".field", ".field-label", ".empty-state", ".back-link", ".sr-only", ".card"]) {
      rule(globals, selector);
    }
    expect(rule(globals, ".page-title")).toContain("font-size: var(--page-title)");
    expect(rule(globals, ".field")).toContain("border: 1px solid var(--field-edge)");
    expect(rule(globals, ".btn-primary")).toContain("background: var(--navy)");
    // One title size for the top of every page.
    for (const file of ["app/memory/memory.module.css", "app/inbox/inbox.module.css", "app/reminders/reminders.module.css", "app/tasks/tasks.module.css", "app/usage/usage.module.css", "app/feedback/feedback.module.css", "app/me/devices/devices.module.css"]) {
      expect(rule(sheet(file), ".h1"), file).toContain("font-size: var(--page-title)");
    }
  });

  it("has a rule for every class a restyled page asks for", () => {
    const pairs: [string, string[]][] = [
      ["app/feedback/feedback.module.css", ["app/feedback/page.tsx", "app/feedback/[id]/page.tsx", "app/feedback/new/page.tsx", "app/feedback/StatusChip.tsx"]],
      ["app/me/devices/devices.module.css", ["app/me/devices/page.tsx", "app/admin/page.tsx", "app/admin/links/page.tsx"]],
      ["app/changelog/changelog.module.css", ["app/changelog/page.tsx"]],
      ["app/not-found.module.css", ["app/not-found.tsx", "app/error.tsx"]],
      ["app/components/LinkBrowserNotice.module.css", ["app/components/LinkBrowserNotice.tsx"]],
      ["app/components/shell/LiveUpdates.module.css", ["app/components/shell/LiveUpdates.tsx"]],
    ];
    const buttons = sheet("app/components/shell/LinkActions.module.css");
    const has = (css: string, name: string) => new RegExp(`\\.${name}(?![A-Za-z0-9_-])`).test(css);
    for (const [css, files] of pairs) {
      for (const file of files) {
        const names = used(file, "styles");
        expect(names.length, `${file} uses a stylesheet`).toBeGreaterThan(0);
        for (const name of names) expect(has(sheet(css), name), `${file} uses .${name} of ${css}`).toBe(true);
        // Two of them also read the shared buttons sheet, under its own name.
        for (const name of used(file, "buttons")) expect(has(buttons, name), `${file} uses .${name} of the buttons sheet`).toBe(true);
      }
    }
  });
});

describe("one of each shared thing", () => {
  it("darkens every navy fill with the same token, mixed from the accent", () => {
    expect(globals).toMatch(/--navy-deep:\s*color-mix\(in srgb, var\(--navy\) \d+%, #000\)/);
    for (const file of ALL) expect(sheet(file), file).not.toMatch(/#12294f/i);
  });

  it("has one way back, the shared back link", () => {
    for (const file of ["app/feedback/feedback.module.css", "app/usage/usage.module.css", "app/me/devices/devices.module.css"]) {
      expect(sheet(file), file).not.toMatch(/(^|\n)\.back\b/);
    }
    for (const file of ["app/feedback/[id]/page.tsx", "app/feedback/new/page.tsx", "app/usage/page.tsx", "app/admin/links/page.tsx"]) {
      expect(read(file), file).toContain('className="back-link"');
    }
  });

  it("keeps a focused table sheet and its fields round: the global ring squares corners", () => {
    const devices = sheet("app/me/devices/devices.module.css");
    expect(rule(devices, ".tableSheet:focus-visible")).toContain("border-radius: var(--sheet-radius)");
    expect(devices).toMatch(/\.table td input\[type="email"\]:focus-visible\s*\{[^}]*border-radius: 12px/);
  });

  it("draws a heatmap cell as a rounded box with a centred navy number", () => {
    const usage = sheet("app/usage/usage.module.css");
    const cell = usage.match(/\.heatCell,\s*\.heatZero\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(cell).toContain("height: 28px");
    expect(cell).toContain("text-align: center");
    expect(rule(usage, ".heatCell")).toContain("color: var(--u-ink)");
  });
});

describe("the pages for an address that leads nowhere and for a failure", () => {
  it("draws the not-found page in the shell, with a way back", () => {
    expect(existsSync(join(root, "app/not-found.tsx"))).toBe(true);
    const src = read("app/not-found.tsx");
    expect(src).toContain("<Shell>");
    expect(src).toContain('href="/memory"');
    expect(src).toContain('href="/"');
    expect(src).toContain("page-title");
  });

  it("shows no detail of a failure, only the reference", () => {
    const src = read("app/error.tsx");
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src).toContain("error.digest");
    expect(src).not.toMatch(/error\.(message|stack)/);
    // The failure was on the server: ask it again, then clear the error.
    expect(src).toMatch(/router\.refresh\(\);\s*reset\(\);/);
  });
});

describe("live updates say their state in words", () => {
  it("shows a word beside the dot, so colour is never the only sign", () => {
    const src = read("app/components/shell/LiveUpdates.tsx");
    for (const word of ["Live", "Connecting", "Reconnecting"]) expect(src).toContain(`"${word}"`);
    expect(src).toContain('aria-hidden="true"');
  });
});
