"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createFilterController } from "./filter-controller";
import { memoryHref } from "./memory-url";
import type { FilterKey, FilterValues } from "./memory-url";
import styles from "./memory.module.css";

export type FilterOption = { value: string; label: string };
export type FilterOptionGroup = { group: string; options: FilterOption[] };

/** One select of the filter bar. Plain data, built by the server page, so this component needs
 *  nothing from the database layer. */
export type FilterField = {
  name: Exclude<FilterKey, "q" | "tag" | "repo">;
  id: string;
  label: string;
  /** Explains the filter on hover and to screen readers. */
  description?: string;
  options: Array<FilterOption | FilterOptionGroup>;
};

export interface FilterBarProps {
  /** What the URL says right now. The URL stays the source of truth; this just mirrors it. */
  values: FilterValues;
  fields: FilterField[];
}

type Router = ReturnType<typeof useRouter>;

/** The search box and filters of /memory. Everything applies as it is changed: selects at once,
 *  the search text after a short pause (Enter skips the pause). The URL is updated, and the
 *  server page re-renders from it. Without JavaScript this is a plain GET form, and the hidden
 *  submit button is what Enter in the search box presses. */
export default function FilterBar({ values, fields }: FilterBarProps) {
  // useRouter() throws outside a mounted App Router (the page render tests render server
  // components directly). Real requests always have it; without it the form stays a plain GET form.
  let router: Router | null;
  try {
    router = useRouter();
  } catch {
    router = null;
  }
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<FilterValues>(values);
  const draftRef = useRef(draft);

  // The controller lives for the life of the component; it reads the latest of these through refs.
  const live = useRef({ router, values, startTransition });
  live.current = { router, values, startTransition };
  const [controller] = useState(() =>
      createFilterController({
        current: () => live.current.values,
        navigate: (href, mode) => {
          const { router: r, startTransition: start } = live.current;
          // scroll:false, or every refresh while typing jumps the page back to the top.
          if (r) start(() => (mode === "push" ? r.push(href, { scroll: false }) : r.replace(href, { scroll: false })));
          else window.location.assign(href);
        },
      }),
  );
  useEffect(() => () => controller.cancel(), [controller]);

  // Adopt the URL when something else moved it (back button, a tag chip, a filter pill). Our own
  // navigations are recognised and leave the draft alone, so the box keeps its text and caret.
  const shownHref = memoryHref(values);
  useEffect(() => {
    if (controller.arrived(shownHref, pending)) {
      draftRef.current = values;
      setDraft(values);
    }
    // `values` is covered by shownHref, which is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, shownHref, pending]);

  function update(name: FilterKey, value: string): FilterValues {
    const next = { ...draftRef.current, [name]: value };
    draftRef.current = next;
    setDraft(next);
    return next;
  }

  return (
    <form
      className={styles.filters}
      action="/memory"
      method="get"
      role="search"
      aria-label="Search and filter memories"
      aria-busy={pending}
      data-pending={pending ? "true" : "false"}
      onSubmit={(e) => {
        // Enter: apply at once. Without the router (or JavaScript) the browser submits the form itself.
        if (!router) return;
        e.preventDefault();
        controller.submitted(draftRef.current);
      }}
    >
      <div className={styles.searchForm}>
        <svg className={styles.searchIcon} viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M13 13l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          name="q"
          value={draft.q}
          onChange={(e) => controller.typed(update("q", e.target.value))}
          placeholder="Search the memory…"
          className={styles.search}
          aria-label="Search memories"
          autoComplete="off"
        />
      </div>
      {values.tag ? <input type="hidden" name="tag" value={values.tag} /> : null}
      {values.repo ? <input type="hidden" name="repo" value={values.repo} /> : null}

      <div className={styles.filterBar}>
        {fields.map((f) => (
          <div key={f.name} className={styles.filterField}>
            <label htmlFor={f.id} className={styles.filterLabel} title={f.description}>
              {f.label}
            </label>
            <select
              id={f.id}
              name={f.name}
              value={draft[f.name]}
              onChange={(e) => controller.changed(update(f.name, e.target.value))}
              className={styles.select}
              aria-description={f.description}
            >
              {f.options.map((o) =>
                "group" in o ? (
                  <optgroup key={o.group} label={o.group}>
                    {o.options.map((g) => (
                      <option key={g.value} value={g.value}>
                        {g.label}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ),
              )}
            </select>
          </div>
        ))}
      </div>

      {/* For Enter without JavaScript. Hidden from the eye, not from keyboards or screen readers. */}
      <button type="submit" className={styles.srOnly}>
        Apply filters
      </button>
    </form>
  );
}
