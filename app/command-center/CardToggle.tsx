"use client";

import { useEffect } from "react";

/**
 * A click anywhere on an initiative card opens or closes its details, like the Details toggle
 * itself. Clicks on links, buttons, forms, the toggle or the opened details are left alone, and so
 * is a click that ends a text selection. Keyboard users use the Details toggle (a <summary>).
 */
export default function CardToggle() {
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const t = e.target;
      if (!(t instanceof Element) || e.defaultPrevented || e.button !== 0) return;
      const card = t.closest("[data-initiative]");
      if (!card || t.closest("a, button, input, select, textarea, form, summary, [data-more] > :not(summary)")) return;
      if (window.getSelection()?.toString()) return;
      const more = card.querySelector<HTMLDetailsElement>("details[data-more]");
      if (more) more.open = !more.open;
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}
