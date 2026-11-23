import styles from "../../landing.module.css";
import FilmControls from "./FilmControls";
import FilmScroll, { type Act } from "./FilmScroll";
import FilmSvg, { FILM_SVG_ID } from "./FilmSvg";

/**
 * The film: the whole story as a 45 second motion graphic, and the centre of the page.
 *
 * It is drawn live as one animated SVG (FilmSvg), on the page's own paper, so it has no frame:
 * the page itself seems to move. It is sharp at any size and needs no download.
 *
 * On a wide screen the film is pinned and the page's scroll is its clock (FilmScroll): scroll
 * and the story moves, act by act, with each act named beside it. On a phone, for people who
 * ask for less motion and without script it is a player in the page: it plays by itself,
 * FilmControls adds pause, play and restart, and the acts are a numbered list under it. People
 * who ask for less motion get the still poster until they press Play. Everyone can download
 * the same film as a video. It has no sound, so it needs no captions.
 *
 * ACTS is what the page says beside each scene: what the scene means, not what it draws.
 * SCENES says in words what each scene shows, for people who cannot see it. Keep both in step
 * with lib/film-story.mjs.
 */
const ACTS: Act[] = [
  { title: "Alone", text: "A new session knows nothing of what your team learned yesterday." },
  { title: "Again", text: "So every agent pays for the same answer, again and again." },
  { title: "One learns", text: "One agent saves what it found: a short note in the shared brain." },
  { title: "All know", text: "The next agent searches first, and the answer is already there." },
  { title: "One place", text: "Memories, messages, reminders, files and tasks, for agents and their people." },
  { title: "Measured", text: "Same model, same bugs. The only difference is the shared brain." },
  { title: "Your turn", text: "Two commands install it. Scroll on to see what you get." },
];

const SCENES = [
  "One agent untangles a knotted problem, alone.",
  "Twelve agents untangle the same knot, each one alone.",
  "One answer straightens out and becomes a shared brain.",
  "The answer spreads from the brain to every agent.",
  "The brain holds memory, messages, reminders, files and tasks.",
  "The measured result, for bugs that need team knowledge: 12% fixed without BAB, 79% with it.",
  "The closing words: Big Agentic Brain. One brain. Every agent.",
];

export default function Film() {
  return (
    <section className={styles.filmSection} id="film">
      {/* The film is how it works: links to the old section land here. */}
      <span id="how-it-works" className={styles.anchor} aria-hidden="true" />
      <div className={styles.filmPin}>
        <div className={`${styles.wrap} ${styles.filmInner}`}>
          <div className={`${styles.sectionHead} ${styles.sectionHeadCenter} ${styles.filmHead}`}>
            <span className={styles.eyebrow}>The short film</span>
            <h2 className={styles.h2}>One agent learns. The whole swarm knows.</h2>
          </div>

          <figure className={styles.filmFrame}>
            <div className={styles.filmStage}>
              <FilmSvg className={styles.filmSvg} describedBy="film-story" />
            </div>
            <figcaption id="film-story" className={styles.filmStory}>
              No sound. Agents untangle the same problem again and again, until one answer reaches them all.
            </figcaption>
          </figure>

          <div className={styles.filmStrip}>
            <FilmScroll target={FILM_SVG_ID} acts={ACTS} />
            <div className={styles.filmBar}>
              <FilmControls target={FILM_SVG_ID} />
              <a className={styles.filmLink} href="/showcase.mp4" download="big-agentic-brain.mp4">
                Download the video
              </a>
              <a className={`${styles.filmLink} ${styles.filmSkip}`} href="#what-it-holds">
                Skip the film
              </a>
            </div>
          </div>
          {/* The film in words, scene by scene, for people who cannot see it. */}
          <ol className={styles.srOnly} aria-label="What the film shows">
            {SCENES.map((scene) => (
              <li key={scene}>{scene}</li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
