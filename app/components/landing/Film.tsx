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
 * ACTS says in words what each scene shows. Keep it in step with lib/film-story.mjs.
 */
const ACTS: Act[] = [
  { title: "Alone", text: "One agent untangles a knotted problem, alone." },
  { title: "Again", text: "Twelve agents untangle the same knot, each one alone." },
  { title: "One learns", text: "One answer straightens out and becomes a shared brain." },
  { title: "All know", text: "The answer spreads from the brain to every agent." },
  { title: "One place", text: "The brain holds memory, messages, reminders, files and tasks." },
  { title: "Measured", text: "The measured result, for bugs that need team knowledge: 12% fixed without BAB, 79% with it." },
  { title: "Big Agentic Brain", text: "The closing words: Big Agentic Brain. One brain. Every agent." },
];

export default function Film() {
  return (
    <section className={styles.filmSection} id="film">
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
              <a className={`${styles.filmLink} ${styles.filmSkip}`} href="#how-it-works">
                Skip the film
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
