/**
 * The primary navigation, in one place.
 *
 * The landing page and the inner pages render their own header components, because each
 * owns its own CSS module and the two are deliberately mirrored rather than shared. The
 * LINKS are not allowed to differ though (same navbar on
 * all pages), so they come from here and neither component keeps its own list.
 *
 * Every item is a plain link. There is no call-to-action pill: a button in the nav implied
 * one of these was more important than the others, which it is not.
 *
 * "How it works" (/docs) and Feedback (/feedback) are not here on purpose: they live in the
 * homepage footer next to News. There is no Chats item: the /conversations list page is gone,
 * and the Inbox (/inbox) is the way to read threads.
 */
export const NAV_ITEMS = [
  { href: "/memory", label: "Memory" },
  { href: "/inbox", label: "Inbox" },
  { href: "/reminders", label: "Reminders" },
  { href: "/changelog", label: "News" },
  { href: "/usage", label: "Usage" },
  { href: "/#get-started", label: "Get started" },
] as const;
