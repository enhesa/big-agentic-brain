import styles from "../../landing.module.css";
import Tour from "./Tour";

/**
 * The demo, as a section (decided: the hero stays as it was; the explaining
 * happens here, as a moving diagram with as few words as possible).
 */
export default function HowItWorks() {
  return (
    <section className={`${styles.section} ${styles.tourSection}`} id="how-it-works">
      <div className={styles.wrap}>
        <div className={`${styles.sectionHead} ${styles.sectionHeadCenter}`}>
          <span className={styles.eyebrow}>30 seconds</span>
          <h2 className={styles.h2}>How it works</h2>
        </div>
        <div className={styles.tourWrap}>
          <Tour />
        </div>
      </div>
    </section>
  );
}
