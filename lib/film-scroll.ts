import { FILM, SCENES } from "./film-story.mjs";

/**
 * The landing page's film, played by scrolling.
 *
 * On a wide screen the film is pinned while the page scrolls past it, and the scroll position
 * is the film's clock: scroll down and the story moves forward, scroll up and it runs back.
 * Everything here is a pure function, so the mapping can be tested without a browser.
 */

/**
 * When the film is pinned and scrubbed: a wide and tall enough window, motion welcome, script
 * running. Everyone else gets the film as a player in the page. app/landing.module.css says the
 * same words in its media query (tests/film-scroll.test.ts keeps the two in step).
 */
export const SCRUB_QUERY =
  "(min-width: 900px) and (min-height: 620px) and (prefers-reduced-motion: no-preference) and (scripting: enabled)";

/**
 * The film starts when its section has risen this far into the window, as a share of the
 * window's height: early, so the first lines are already being drawn as the stage comes up.
 */
const LEAD = 0.85;
/**
 * The share of the film that plays while the stage rises, before it is pinned: a first stroke,
 * no more. The first act is told once the film holds still.
 */
const RISE = 0.03;
/** The last share of the scroll rests on the closing frame. */
const HOLD = 0.06;
/**
 * The latest moment shown: the closing frame, fully drawn. In its last half second the film
 * fades out to loop, and at its very end the clock wraps to the first frame.
 */
export const LAST_SECOND = FILM.seconds - 0.6;
/** How much of the gap to the scroll position the film closes each frame: it glides, it does not jump. */
export const GLIDE = 0.2;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * How far the page has scrolled through the film section, 0 to 1.
 * top: the section's top edge, in pixels below the top of the window. height: the section's
 * height. viewport: the window's height. pin: how far below the top of the window the film
 * is pinned (the height of the page's top bar).
 *
 * Two stretches. While the stage rises to its pin, only the first moments play. Once it is
 * pinned, the rest plays evenly, until the section's bottom meets the window's bottom.
 */
export function scrollProgress(top: number, height: number, viewport: number, pin = 0): number {
  // A section no taller than the window is not pinned: there is nothing to scroll through.
  if (!(height > viewport)) return 0;
  const lead = viewport * LEAD;
  if (top > pin) return lead > pin ? clamp01((lead - top) / (lead - pin)) * RISE : 0;
  return RISE + clamp01((pin - top) / (height - viewport + pin)) * (1 - RISE);
}

/** The film's moment, in seconds, for a scroll progress of 0 to 1. */
export function filmTimeAt(progress: number): number {
  return Math.min(1, clamp01(progress) / (1 - HOLD)) * LAST_SECOND;
}

/** Which act a moment belongs to. Neighbours cross-fade, so an act takes over halfway through the fade. */
export function actAt(seconds: number): number {
  let act = 0;
  SCENES.forEach((scene, i) => {
    if (i > 0 && seconds >= (scene.start + SCENES[i - 1].end) / 2) act = i;
  });
  return act;
}

/**
 * Whether the film's night covers the page at this moment. In one scene a navy ground spreads
 * from the brain past the edges of the stage. While it does, the page gives the pinned film
 * the same ground and turns the words beside it light, in any window shape. It begins once
 * the ground has started to spread, and ends halfway through the scene's fade.
 */
export function nightAt(seconds: number): boolean {
  const night = SCENES.find((scene) => scene.id === "knows");
  return night !== undefined && seconds >= night.start + 0.45 && seconds < night.end - 0.2;
}

/** Where each act after the first begins on the progress rail, as a share of its length. */
export const ACT_MARKS: number[] = SCENES.slice(1).map((scene, i) => (scene.start + SCENES[i].end) / 2 / LAST_SECOND);

/** Moves the film a step from where it is toward where the scroll says, and lands when it is close. */
export function glide(now: number, goal: number): number {
  return Math.abs(goal - now) < 0.02 ? goal : now + (goal - now) * GLIDE;
}
