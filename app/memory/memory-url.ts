/** The /memory URL for a set of filters. The URL is the source of truth for the list page:
 *  the server page and the filter bar both build links with this, so they always agree.
 *  Empty values are left out, so the plain list stays `/memory`. */
export const FILTER_KEYS = ["q", "tag", "repo", "project", "author", "status", "kind", "applies"] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];
export type FilterValues = Record<FilterKey, string>;

export function memoryHref(values: Partial<FilterValues> & { page?: number }): string {
  const p = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    // The search text is trimmed: "abc " and "abc" are the same search, and a lone space is no search.
    const v = key === "q" ? values.q?.trim() : values[key];
    if (v) p.set(key, v);
  }
  // Page 1 is the default, so the first page never carries a `page` it doesn't need.
  if (values.page && values.page > 1) p.set("page", String(values.page));
  const s = p.toString();
  return s ? `/memory?${s}` : "/memory";
}
