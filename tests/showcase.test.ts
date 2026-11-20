import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const size = (path: string) => statSync(join(root, path)).size;

const MB = 1024 * 1024;

describe("the showcase film", () => {
  it("keeps its rendered files small", () => {
    expect(size("public/showcase.mp4")).toBeLessThan(1.5 * MB);
    expect(size("docs/images/showcase.gif")).toBeLessThan(1.75 * MB);
    expect(size("public/showcase-poster.png")).toBeLessThan(0.2 * MB);
  });

  it("is a real mp4 that starts playing before it has fully loaded", () => {
    const head = readFileSync(join(root, "public/showcase.mp4")).subarray(0, 64 * 1024);
    expect(head.subarray(4, 8).toString("latin1")).toBe("ftyp");
    // "faststart" puts the index (moov) before the picture data (mdat).
    const moov = head.indexOf("moov", 0, "latin1");
    const mdat = head.indexOf("mdat", 0, "latin1");
    expect(moov).toBeGreaterThan(0);
    expect(mdat === -1 || moov < mdat).toBe(true);
  });

  it("is shown in the README with a text alternative", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/<img src="docs\/images\/showcase\.gif"[^>]* alt="[^"]{40,}"/);
    expect(readme).toContain('href="public/showcase.mp4"');
    expect(readme).toContain("showcase/README.md");
  });

  it("repeats the measured figures of the README", () => {
    const film = read("showcase/film.js");
    const readme = read("README.md");
    expect(readme).toContain("fixed 12% without BAB and 79% with it");
    expect(film).toContain("share: 0.12");
    expect(film).toContain("share: 0.79");
    expect(film).toContain("Claude Sonnet 5.5");
  });

  it("draws every frame from its number alone, so a render is repeatable", () => {
    const film = read("showcase/film.js");
    expect(film).not.toMatch(/Math\.random\(|Date\.now\(/);
    // performance.now() drives only the in-browser preview loop, never a rendered frame.
    expect(film.match(/performance\.now\(/g)).toHaveLength(1);
  });

  it("stays out of the container image, except for the rendered film", () => {
    const ignored = read(".dockerignore").split(/\r?\n/);
    expect(ignored).toContain("showcase");
    expect(ignored).not.toContain("public");
  });
});
