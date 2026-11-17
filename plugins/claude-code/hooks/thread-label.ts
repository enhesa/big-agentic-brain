// Pure helpers that name a thread in the inbox panel, for 1:1 and group threads.
// No imports: tests load this file on its own.

/** The parts of a bab_inbox listing row these helpers read. Older servers send no `participants`. */
export type LabelThread = {
  lastMessage?: { from_id?: string; to_id?: string }
  participants?: { id?: string }[]
}

/**
 * Everyone in the thread but `me`, in the order they joined, when the server lists more than one
 * of them (a group thread). An empty list means a 1:1 thread or an older server.
 */
export function groupOthers(t: LabelThread, me: string | undefined): string[] {
  const ids = (t.participants ?? []).map(p => p?.id).filter((id): id is string => typeof id === 'string' && id !== '')
  const others = [...new Set(ids)].filter(id => id !== me)
  return others.length > 1 ? others : []
}

/** "Bob, Carol" for two names, "Bob, Carol +2" for more. */
export function groupLabel(names: string[]): string {
  const shown = names.slice(0, 2).join(', ')
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown
}
