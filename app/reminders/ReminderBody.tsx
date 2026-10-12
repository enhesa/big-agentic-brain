import { Fragment, type ReactNode } from "react";
import { parseBody, type Inline } from "./format";
import styles from "./reminders.module.css";

function renderInline(parts: Inline[]): ReactNode {
  return parts.map((p, i) => {
    if (p.kind === "code") {
      return (
        <code key={i} className={styles.code}>
          {p.text}
        </code>
      );
    }
    if (p.kind === "link") {
      return (
        <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className={styles.link}>
          {p.text}
        </a>
      );
    }
    return <Fragment key={i}>{p.text}</Fragment>;
  });
}

/**
 * Renders a reminder body from parseBody()'s tree. Only React elements, never
 * dangerouslySetInnerHTML, so markup typed into a body stays visible text.
 */
export default function ReminderBody({ text }: { text: string }) {
  const blocks = parseBody(text);
  return (
    <div className={styles.body}>
      {blocks.map((b, i) => {
        if (b.kind === "p") {
          return (
            <p key={i}>
              {b.lines.map((line, li) => (
                <Fragment key={li}>
                  {li > 0 ? <br /> : null}
                  {renderInline(line)}
                </Fragment>
              ))}
            </p>
          );
        }
        const items = b.items.map((it, ii) => <li key={ii}>{renderInline(it)}</li>);
        return b.kind === "ol" ? (
          <ol key={i} start={b.start} className={styles.steps}>
            {items}
          </ol>
        ) : (
          <ul key={i} className={styles.bullets}>
            {items}
          </ul>
        );
      })}
    </div>
  );
}
