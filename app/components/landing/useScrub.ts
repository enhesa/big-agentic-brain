"use client";

import { useSyncExternalStore } from "react";
import { SCRUB_QUERY } from "@/lib/film-scroll";

const subscribe = (changed: () => void) => {
  const query = window.matchMedia(SCRUB_QUERY);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
};

/**
 * True while the film is pinned and played by scrolling (SCRUB_QUERY). False on the server, on a
 * phone and for people who ask for less motion: there the film is a player with its own buttons.
 */
export function useScrub(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(SCRUB_QUERY).matches,
    () => false,
  );
}
