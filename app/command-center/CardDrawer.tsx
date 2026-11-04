"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./command-center.module.css";

type Panel = { id: string; title: string; body: React.ReactNode };

/**
 * The detail drawer: a native <dialog> opened with showModal(), so Esc closes it, focus stays
 * inside and the page behind is inert. A click anywhere on a card (or its title button) opens
 * that card; clicks on links, buttons, forms and text selections are left alone. The open card
 * id is client state, so a poll refresh (router.refresh) keeps the drawer open with fresh content.
 * The bodies are server-rendered React text; every one is in the HTML, hidden unless open.
 */
export default function CardDrawer({ panels }: { panels: Panel[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const openPanel = openId ? panels.find((p) => p.id === openId) : undefined;

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const t = e.target;
      if (!(t instanceof Element) || e.defaultPrevented || e.button !== 0) return;
      const opener = t.closest<HTMLElement>("[data-open-card]");
      if (opener) {
        setOpenId(opener.dataset.openCard ?? null);
        return;
      }
      const card = t.closest<HTMLElement>("[data-card]");
      if (!card || t.closest("a, button, input, select, textarea, form, label")) return;
      if (window.getSelection()?.toString()) return;
      setOpenId(card.dataset.card ?? null);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // Open or close the dialog to match the state; a card gone after a refresh closes it.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (openPanel && !d.open) {
      d.showModal();
      // Start on the panel itself, not its close button, so the drawer opens calm; Tab moves on.
      d.querySelector<HTMLElement>(`[data-detail="${CSS.escape(openPanel.id)}"]`)?.focus();
    } else if (!openPanel && d.open) d.close();
  }, [openPanel]);

  const onClose = useCallback(() => {
    const id = openId;
    setOpenId(null);
    // Look the card up by id: a refresh may have replaced the node that opened the drawer.
    if (id) document.querySelector<HTMLElement>(`[data-open-card="${CSS.escape(id)}"]`)?.focus();
  }, [openId]);

  return (
    <dialog
      ref={ref}
      className={styles.drawer}
      aria-labelledby={openPanel ? `cc-d-${openPanel.id}` : undefined}
      onClose={onClose}
      // A click on the backdrop (the dialog box itself, outside the panel) closes it.
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      data-drawer=""
    >
      {panels.map((p) => (
        <div key={p.id} className={styles.drawerPanel} data-detail={p.id} hidden={p.id !== openId} tabIndex={-1}>
          <div className={styles.drawerHead}>
            <h2 id={`cc-d-${p.id}`} className={styles.drawerTitle}>
              {p.title}
            </h2>
            <button type="button" className={styles.drawerClose} aria-label="Close details" onClick={() => ref.current?.close()}>
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {p.body}
        </div>
      ))}
    </dialog>
  );
}
