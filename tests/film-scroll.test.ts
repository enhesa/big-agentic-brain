import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FILM, SCENES } from "../lib/film-story.mjs";
import { ACT_MARKS, FRAME, HOLD, LAST_SECOND, SCRUB_QUERY, actAt, filmTimeAt, glide, nightAt, scrollProgress } from "../lib/film-scroll";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/** The landing page's film is played by scrolling. These are the sums behind it. */
describe("the film played by scroll", () => {
  it("plays a first stroke as the film rises, and the rest once it is pinned", () => {
    const viewport = 900;
    const height = 6840;
    const pin = 68;
    const at = (top: number) => scrollProgress(top, height, viewport, pin);
    // Below the window, or only just in it: not started.
    expect(at(900)).toBe(0);
    expect(at(800)).toBe(0);
    // Risen a good way in, but not yet pinned: the first line is being drawn.
    expect(at(450)).toBeGreaterThan(0);
    expect(at(450)).toBeLessThan(at(pin));
    // Pinned: the first act has only just begun, so it is told while the film holds still.
    const first = SCENES[0];
    expect(filmTimeAt(at(pin))).toBeGreaterThan(0.5);
    expect(filmTimeAt(at(pin))).toBeLessThan(first.end / 3);
    expect(actAt(filmTimeAt(at(pin)))).toBe(0);
    // No jump where the rise ends and the pin begins.
    expect(at(pin + 0.01)).toBeCloseTo(at(pin), 4);
    expect(at(pin - 0.01)).toBeCloseTo(at(pin), 4);
    // The section's bottom meets the window's bottom: the pin lets go, the film is over.
    expect(at(viewport - height)).toBe(1);
    expect(at(-99999)).toBe(1);
    // While pinned it moves with the scroll, evenly.
    expect(at(-1000) - at(0)).toBeCloseTo(at(-2000) - at(-1000), 10);
    // Every act gets a fair stretch of scroll: none flashes by.
    const perSecond = (pin - (viewport - height)) / (LAST_SECOND / (1 - HOLD));
    expect(((SCENES[1].start + first.end) / 2 - filmTimeAt(at(pin))) * perSecond).toBeGreaterThan(400);
    // Without a top bar the pin is the top of the window.
    expect(scrollProgress(0, height, viewport)).toBeCloseTo(at(pin), 6);
  });

  it("is still, not broken, when the section is no taller than the window", () => {
    expect(scrollProgress(0, 400, 900)).toBe(0);
    expect(scrollProgress(-100, 900, 900)).toBe(0);
    expect(scrollProgress(0, 0, 0)).toBe(0);
  });

  it("maps the scroll to the film from its first second to its closing frame, and rests there", () => {
    expect(filmTimeAt(0)).toBe(0);
    expect(filmTimeAt(-1)).toBe(0);
    expect(filmTimeAt(1)).toBe(LAST_SECOND);
    expect(filmTimeAt(2)).toBe(LAST_SECOND);
    // The last stretch of scroll holds the closing frame.
    expect(filmTimeAt(0.95)).toBe(LAST_SECOND);
    expect(filmTimeAt(0.5)).toBeGreaterThan(20);
    expect(filmTimeAt(0.5)).toBeLessThan(26);
    // Forward only: more scroll is never an earlier moment.
    for (let p = 0; p < 1; p += 0.01) expect(filmTimeAt(p + 0.01)).toBeGreaterThanOrEqual(filmTimeAt(p));
  });

  it("stops on the closing frame: before the film fades out to loop, inside the last scene", () => {
    const last = SCENES[SCENES.length - 1];
    expect(LAST_SECOND).toBeLessThanOrEqual(FILM.seconds - 0.5);
    expect(LAST_SECOND).toBeGreaterThan(last.start + 4);
  });

  it("names the act a moment belongs to, one act per scene", () => {
    expect(actAt(0)).toBe(0);
    SCENES.forEach((scene, i) => {
      // Well inside a scene it is that scene's act.
      expect(actAt((scene.start + Math.min(scene.end, FILM.seconds)) / 2), scene.id).toBe(i);
    });
    expect(actAt(LAST_SECOND)).toBe(SCENES.length - 1);
    // Halfway through a cross-fade the next act takes over.
    expect(actAt(SCENES[1].start + 0.1)).toBe(0);
    expect(actAt(SCENES[0].end - 0.1)).toBe(1);
  });

  it("marks where each act after the first begins on the rail, in order", () => {
    expect(ACT_MARKS).toHaveLength(SCENES.length - 1);
    expect(ACT_MARKS.every((m, i) => m > 0 && m < 1 && (i === 0 || m > ACT_MARKS[i - 1]))).toBe(true);
  });

  it("knows when the film's night covers the page, so the words beside it can turn light", () => {
    const night = SCENES.find((scene) => scene.id === "knows")!;
    expect(nightAt(0)).toBe(false);
    // The navy ground needs a moment to spread, and leaves as the scene fades.
    expect(nightAt(night.start)).toBe(false);
    expect(nightAt(night.start + 1)).toBe(true);
    expect(nightAt((night.start + night.end) / 2)).toBe(true);
    expect(nightAt(night.end)).toBe(false);
    expect(nightAt(LAST_SECOND)).toBe(false);
    // The page turns the act's words and the rail light, only while pinned.
    const css = read("app/landing.module.css");
    const scrub = css.slice(css.indexOf(`@media ${SCRUB_QUERY} {`));
    for (const part of [".actTitle", ".actText", ".actNo", ".rail"]) {
      expect(scrub, part).toContain(`.filmSection[data-night] ${part}`);
    }
    expect(css.slice(0, css.indexOf(`@media ${SCRUB_QUERY} {`))).not.toContain("data-night");
    // The pin takes the navy ground, so the film's own paper must not show as a box on it.
    expect(scrub).toMatch(/\.filmGround\s*\{[^}]*display:\s*none/);
    expect(read("app/components/landing/FilmSvg.tsx")).toContain("className={styles.filmGround}");
    expect(read("app/components/landing/FilmScroll.tsx")).toContain('section.toggleAttribute("data-night", nightAt(now))');
  });

  it("glides toward the scroll position and lands on it", () => {
    expect(glide(10, 10)).toBe(10);
    expect(glide(10, 10.01)).toBe(10.01);
    const step = glide(0, 10);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(10);
    let now = 0;
    for (let i = 0; i < 200 && now !== 10; i++) now = glide(now, 10);
    expect(now).toBe(10);
    // Backwards too.
    expect(glide(10, 0)).toBeLessThan(10);
    // As fast on a fast screen as on a slow one: two half frames make one frame.
    expect(glide(glide(0, 10, FRAME / 2), 10, FRAME / 2)).toBeCloseTo(glide(0, 10), 10);
    expect(glide(0, 10, FRAME * 2)).toBeGreaterThan(glide(0, 10));
    // A frame that took no time moves nothing.
    expect(glide(0, 10, 0)).toBe(0);
    expect(glide(0, 10, -5)).toBe(0);
  });

  it("the page pins the film under the same conditions the script plays it", () => {
    const css = read("app/landing.module.css");
    expect(css).toContain(`@media ${SCRUB_QUERY} {`);
    // Less motion, a small window and no script all keep the film a player in the page.
    for (const part of ["prefers-reduced-motion: no-preference", "scripting: enabled", "min-width: 900px", "min-height: 620px"]) {
      expect(SCRUB_QUERY).toContain(part);
    }
    const scrub = css.slice(css.indexOf(`@media ${SCRUB_QUERY} {`));
    expect(scrub).toMatch(/\.filmPin\s*\{[^}]*position:\s*sticky/);
    // Outside that query nothing is pinned and the film's own buttons are shown.
    const before = css.slice(0, css.indexOf(`@media ${SCRUB_QUERY} {`));
    expect(before).not.toMatch(/\.filmPin\s*\{/);
    expect(before).not.toMatch(/\.filmControls\s*\{[^}]*display:\s*none/);
    expect(scrub).toMatch(/\.filmControls\s*\{[^}]*display:\s*none/);
    // The bar holds only those buttons. Left in, its empty box would push the pinned film up.
    expect(scrub).toMatch(/\.filmBar\s*\{[^}]*display:\s*none/);
    // hidden would make the page its own scroll box, and nothing could be pinned to the window.
    expect(css).toMatch(/\.page\s*\{[^}]*overflow-x:\s*clip/);
  });

  it("one writer for the film's clock: the buttons stand down while the scroll plays it", () => {
    const controls = read("app/components/landing/FilmControls.tsx");
    expect(controls).toContain("if (!svg || scrub) return;");
    const scroll = read("app/components/landing/FilmScroll.tsx");
    expect(scroll).toContain("svg.pauseAnimations()");
    expect(scroll).toContain("svg.setCurrentTime(now)");
    expect(scroll).toContain('{ passive: true }');
    // The film is pinned under the top bar as tall as it really is, and measured again when the page changes shape.
    expect(scroll).toContain('section.style.setProperty("--bar"');
    expect(scroll).toContain("new ResizeObserver(size)");
    // It tidies up: no observer, no frame and no borrowed styles are left behind.
    for (const part of ["shape?.disconnect()", "cancelAnimationFrame(frame)", 'section.style.removeProperty("--bar")', "svg.setCurrentTime(0)"]) {
      expect(scroll, part).toContain(part);
    }
  });
});
