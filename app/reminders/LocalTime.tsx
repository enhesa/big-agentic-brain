"use client";

import { useEffect, useState } from "react";

/** "2026-10-21 20:00 UTC": what the server renders, and what shows until the browser formats it. */
function utcText(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * A due instant in the viewer's own time zone. The server render shows UTC (it cannot know the
 * viewer's zone); after hydration the browser swaps in its local date and time.
 */
export default function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState(() => utcText(iso));

  useEffect(() => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return;
    setText(d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
  }, [iso]);

  return <time dateTime={iso}>{text}</time>;
}
