import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
const css = read("app/memory/memory.module.css");
const globals = read("app/globals.css");

/** Every rule for the selector, media queries included. A selector that is gone fails the test. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = css.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{[^}]*\\}`, "g"));
  expect(found, `${selector} has a rule`).not.toBeNull();
  return found!.join("\n");
}

/** The body of one `@media (...) { ... }` block, found by its condition. */
function media(condition: string): string {
  const start = css.indexOf(`@media ${condition}`);
  expect(start, `@media ${condition} exists`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`@media ${condition} is not closed`);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the Memory pages on paper", () => {
  it("cards, lists and fields are sheets: one warm white and one hairline, from tokens", () => {
    const sheet = globals.match(/--sheet:\s*(#[0-9a-f]{6})/)?.[1];
    expect(sheet, "--sheet is defined").toBeTruthy();
    expect(globals).toMatch(/--hairline:\s*rgba\(/);
    expect(globals).toMatch(/--sheet-radius:\s*\d+px/);
    // Steel and the dark teal are the two text colours a sheet carries besides navy.
    expect(ratio("#3f5175", sheet!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio("#006b61", sheet!)).toBeGreaterThanOrEqual(4.5);
    for (const selector of [".list", ".body", ".react", ".reviewItem"]) {
      expect(rule(selector), selector).toContain("background: var(--sheet)");
      expect(rule(selector), selector).toContain("var(--hairline)");
    }
    // No stark white card on paper is left in the list.
    expect(rule(".rowLink")).not.toMatch(/background:\s*#fff/);
  });

  it("the list is one sheet of rows, and a row never cuts its title", () => {
    expect(rule(".row + .row")).toContain("border-top: 1px solid var(--hairline)");
    expect(rule(".title")).not.toMatch(/white-space:\s*nowrap|text-overflow/);
    expect(rule(".snippet")).toMatch(/-webkit-line-clamp:\s*2/);
    // The whole row is the link (.title::after), so the row is its own positioning context
    // and the focus ring is drawn on the row.
    expect(rule(".rowLink")).toContain("position: relative");
    expect(rule(".title::after")).toContain("inset: 0");
    expect(rule(".title:focus-visible::after")).toContain("outline: 3px solid var(--teal-ink)");
    // The project chip stays its own link above the stretched one.
    expect(rule(".project")).toMatch(/z-index:\s*2/);
  });

  it("the search box and the filters keep the keyboard focus ring every page has", () => {
    expect(css).not.toMatch(/\.(search|select):focus[^{]*\{[^}]*outline:\s*none/);
    expect(rule(".search:focus-visible,\n.select:focus-visible")).toContain("border-color: var(--teal-ink)");
    expect(globals).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--teal-ink\)/);
  });

  it("each filter carries its name inside the control, two to a row on a phone", () => {
    expect(rule(".filterLabel")).toMatch(/position:\s*absolute/);
    expect(rule(".filterLabel")).toContain("pointer-events: none");
    const phone = media("(max-width: 640px)");
    expect(phone).toMatch(/\.filterBar\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
    // The label swallows no clicks, so the hint moved to the select, where a pointer rests.
    expect(read("app/memory/FilterBar.tsx")).toMatch(/className=\{styles\.select\}\s*title=\{f\.description\}/);
  });

  it("a phone still shows standing and the trust warning on a row", () => {
    const phone = media("(max-width: 640px)");
    const signals = phone.match(/\.signals\s*\{[^}]*\}/)?.[0];
    expect(signals, "the phone block styles .signals").toBeTruthy();
    expect(signals).not.toMatch(/display:\s*none/);
    expect(signals).toContain("flex-direction: row");
  });

  it("standing is words with a dot, and every literal text colour reads on a sheet", () => {
    expect(rule(".standing")).not.toMatch(/background/);
    expect(rule(".standing::before")).toMatch(/border-radius:\s*50%/);
    const sheet = globals.match(/--sheet:\s*(#[0-9a-f]{6})/)![1];
    for (const selector of [".signalKudos", ".trustChipFlagged", ".trustBanner"]) {
      const hex = rule(selector).match(/(?:^|[\s;{])color:\s*(#[0-9a-f]{6})/)?.[1];
      expect(hex, `${selector} sets a literal colour`).toBeTruthy();
      expect(ratio(hex!, sheet), `${selector} on a sheet`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("a memory's page reads in one column, with its facts beside it on a wide screen", () => {
    expect(rule(".detail")).toContain("display: grid");
    const wide = media("(min-width: 1000px)");
    expect(wide).toMatch(/\.detail > \.facts\s*\{[^}]*grid-column:\s*2/);
    expect(wide).toMatch(/\.detail > \.facts\s*\{[^}]*position:\s*sticky/);
    // The facts stay a direct child of .detail: the order on a phone is the order in the page.
    const page = read("app/memory/[id]/page.tsx");
    expect(page.indexOf("className={styles.body}")).toBeLessThan(page.indexOf("className={styles.facts}"));
    expect(page.indexOf("className={styles.facts}")).toBeLessThan(page.indexOf("<CommentsPanel"));
    expect(rule(".facts")).toContain("background: var(--sand)");
  });

  it("motion is off for every transition when the reader asks for less", () => {
    const calm = media("(prefers-reduced-motion: reduce)");
    for (const selector of [".rowLink", ".chip", ".search", ".select", ".pill", ".reactBtn"]) {
      expect(calm, selector).toContain(selector);
    }
    expect(calm).toMatch(/\.row\s*\{[^}]*animation:\s*none/);
  });
});
