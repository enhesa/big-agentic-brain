import type { ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";
import styles from "./markdown.module.css";

/**
 * Renders a memory body written in markdown. Everything goes through React elements, so a
 * body can never inject HTML; see lib/markdown.ts for what is supported.
 */
export default function Markdown({ source, className }: { source: string; className?: string }) {
  return <div className={[styles.md, className].filter(Boolean).join(" ")}>{blocks(parseMarkdown(source))}</div>;
}

function blocks(bs: Block[]): ReactNode[] {
  return bs.map((b, i) => block(b, i));
}

function block(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "p":
      return <p key={key}>{inline(b.c)}</p>;
    case "h": {
      // Page headings are h1 (title) and h2 (sections), so a body's headings start at h3.
      const Tag = (["h3", "h4", "h5", "h6", "h6", "h6"] as const)[b.level - 1];
      return <Tag key={key}>{inline(b.c)}</Tag>;
    }
    case "pre":
      return (
        <pre key={key} data-lang={b.lang ?? undefined}>
          <code>{b.v}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={key}>{blocks(b.c)}</blockquote>;
    case "list": {
      const items = b.items.map((it, k) => <li key={k}>{tight(it)}</li>);
      return b.ordered ? (
        <ol key={key} start={b.start === 1 ? undefined : b.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table":
      return (
        <div key={key} className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                {b.head.map((c, k) => (
                  <th key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, k) => (
                <tr key={k}>
                  {r.map((c, n) => (
                    <td key={n} style={b.align[n] ? { textAlign: b.align[n]! } : undefined}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} />;
  }
}

/** A list item that is a single paragraph renders without the <p>, so lists stay compact. */
function tight(it: Block[]): ReactNode {
  if (it.length === 0) return null;
  if (it[0].t === "p") return [<span key="first">{inline(it[0].c)}</span>, ...it.slice(1).map((b, k) => block(b, k + 1))];
  return blocks(it);
}

function inline(ns: Inline[]): ReactNode[] {
  return ns.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "br":
        return <br key={i} />;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "strong":
        return <strong key={i}>{inline(n.c)}</strong>;
      case "em":
        return <em key={i}>{inline(n.c)}</em>;
      case "del":
        return <del key={i}>{inline(n.c)}</del>;
      case "link": {
        const external = /^(https?:|mailto:)/i.test(n.href);
        return external ? (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {inline(n.c)}
          </a>
        ) : (
          <a key={i} href={n.href}>
            {inline(n.c)}
          </a>
        );
      }
    }
  });
}
