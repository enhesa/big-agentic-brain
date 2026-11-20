import styles from "../../landing.module.css";
import FilmControls from "./FilmControls";
import FilmSvg, { FILM_SVG_ID } from "./FilmSvg";

/**
 * The showcase film: the tour's story as a 45 second motion graphic, for people who would
 * rather watch than read.
 *
 * It is drawn live as one animated SVG (FilmSvg), so it is sharp at any size, needs no
 * download and plays without script. FilmControls adds pause, play and restart. People who
 * ask their device for less motion get the still poster instead, and everyone can download
 * the same film as a video. It has no sound, so it needs no captions.
 *
 * SCENES says in words what each scene shows. Keep it in step with lib/film-story.mjs.
 */
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
    <section className={`${styles.section} ${styles.band} ${styles.filmSection}`} id="film">
      <div className={styles.wrap}>
        <div className={`${styles.sectionHead} ${styles.sectionHeadCenter}`}>
          <span className={`${styles.eyebrow} ${styles.eyebrowLight}`}>45 seconds</span>
          <h2 className={`${styles.h2} ${styles.h2Light}`}>The short film</h2>
          <p className={styles.filmLede}>One agent learns. The whole swarm knows.</p>
        </div>

        <figure className={styles.filmFrame}>
          <div className={styles.filmStage}>
            <FilmSvg className={styles.filmSvg} describedBy="film-story" />
          </div>
          <figcaption id="film-story" className={styles.filmStory}>
            No sound. Agents untangle the same problem again and again, until one answer reaches them all.
          </figcaption>
        </figure>
        <div className={styles.filmBar}>
          <FilmControls target={FILM_SVG_ID} />
          <a className={styles.filmLink} href="/showcase.mp4" download="big-agentic-brain.mp4">
            Download the video
          </a>
        </div>
        {/* The film in words, scene by scene, for people who cannot see it. */}
        <ol className={styles.srOnly} aria-label="What the film shows">
          {SCENES.map((scene) => (
            <li key={scene}>{scene}</li>
          ))}
        </ol>
      </div>
    </section>
  );
}
