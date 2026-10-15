import type { ReactNode } from "react";
import styles from "./docs.module.css";

/**
 * The layout pieces the diagrams share, so a diagram file only draws.
 *
 * A section is a short heading, at most one caption line and a grid of diagrams. There is no
 * body text: the rule is that this page is diagrams, not prose, and the
 * word cap in tests/docs-page.test.ts is what keeps it that way.
 */

export function DocsSection({
  id,
  title,
  caption,
  children,
}: {
  id: string;
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className={styles.sectionTitle}>
        {title}
      </h2>
      {caption ? <p className={styles.sectionCaption}>{caption}</p> : null}
      <div className={styles.flowGrid}>{children}</div>
    </section>
  );
}

/**
 * One diagram in a card with its title. `wide` makes it span both columns of the grid.
 *
 * The drawing sits in its own scroller, so on a phone the title stays put while a diagram that
 * is wider than the card scrolls sideways under it, with a soft edge showing where there is more.
 */
export function DiagramFigure({
  title,
  wide = false,
  children,
}: {
  title: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <figure className={wide ? `${styles.flowFigure} ${styles.flowFigureWide}` : styles.flowFigure}>
      <figcaption className={styles.flowTitle}>{title}</figcaption>
      <div className={styles.scroller}>{children}</div>
    </figure>
  );
}

/**
 * An id for an SVG arrowhead that is unique on the page. Every diagram defines its own marker, and
 * the same id twice in one document is invalid HTML (it only works while the copies are identical).
 */
export function markerIdFor(title: string): string {
  return `arrow-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}
