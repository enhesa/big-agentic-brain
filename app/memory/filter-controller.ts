import { memoryHref } from "./memory-url";
import type { FilterValues } from "./memory-url";

export const SEARCH_DEBOUNCE_MS = 300;

export interface FilterControllerOptions {
  /** Go to a URL. `replace` for typing (no history flood), `push` for a deliberate select change. */
  navigate: (href: string, mode: "push" | "replace") => void;
  /** The filters the page currently shows (read when a change is applied, so it is never stale). */
  current: () => FilterValues;
  delayMs?: number;
}

/** The interaction rules of the filter bar, apart from React so they can be tested without a DOM:
 *  typing waits for a pause, Enter and select changes apply at once, and nothing navigates to the
 *  URL the list is already on. */
export function createFilterController({ navigate, current, delayMs = SEARCH_DEBOUNCE_MS }: FilterControllerOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The URL we last sent the page to (or arrived on). Typing "ab" then deleting back to the
  // shown text must not navigate, and a pending debounce must not re-send what Enter just sent.
  let lastHref: string | undefined;

  function cancel() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function apply(next: FilterValues, mode: "push" | "replace") {
    cancel();
    const href = memoryHref(next);
    if (href === (lastHref ?? memoryHref(current()))) return;
    lastHref = href;
    navigate(href, mode);
  }

  return {
    /** A key in the search box: apply after a pause, replacing the history entry. */
    typed(next: FilterValues) {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        apply(next, "replace");
      }, delayMs);
    },
    /** Enter in the search box: apply now. */
    submitted(next: FilterValues) {
      apply(next, "replace");
    },
    /** A select changed: apply now, as its own history entry (any pending search text goes with it). */
    changed(next: FilterValues) {
      apply(next, "push");
    },
    /** Called with the URL the page shows after each render. True when the page got there by
     *  something other than us (back button, a chip, a pill): the filter bar must then adopt the
     *  new values. A render of a URL we sent, or one that lands while our own navigation is
     *  still pending, is not that, and must not overwrite what the person has typed since. */
    arrived(href: string, pending: boolean): boolean {
      if (lastHref === undefined || href === lastHref) {
        lastHref = href;
        return false;
      }
      if (pending) return false;
      cancel();
      lastHref = href;
      return true;
    },
    cancel,
  };
}
