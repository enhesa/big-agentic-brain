export type InboxView = {
  /** Unread messages across all threads, counted over every unread thread BAB lists (up to a cap). */
  unread: number
  /** BAB has more unread threads than were counted, so `unread` is a lower bound: drawn with a plus. */
  isPartial: boolean
  /** Who wrote the unread threads, newest first, one name each: a first name, or "Note to self". */
  from: string[]
  /** Subject of the newest unread thread, if any. */
  subject: string | null
  /** Id of the newest unread thread. */
  threadId: string | null
  /** Epoch ms until which the pill shows the "new" highlight. */
  newUntil: number
  /** Open reminders due today or earlier. */
  due: number
  /** Title of the oldest of those, if any: the pill names it when there is no mail. */
  dueTitle: string | null
  /** That reminder is overdue, not only due today. */
  isDueLate: boolean
  /** Epoch ms of the last answer from BAB, shown in the panel header; 0 before the first. */
  checkedAt: number
  /** BAB answered with a notice instead of an inbox (for example it does not know you): show nothing misleading. */
  isOffline: boolean
  /** The last check could not reach BAB; the panel says so while it retries. */
  isDown: boolean
}

/** One row of the panel's thread list. */
export type ThreadRow = {
  id: string
  subject: string
  /** First name of the other side, drawn in the list. */
  who: string
  /** Full name of the other side, drawn in the header of the open thread. */
  whoFull: string
  /** Id of the other side, which picks the colour of the name; empty when unknown. */
  whoId: string
  /** A thread with only yourself in it, drawn as "Note to self". */
  isSelf: boolean
  /** One line of the last message, drawn dim; never handed to the model. */
  preview: string
  /** The goal of the last message's request, when it carries one; drawn, never handed to the model. */
  ask: string | null
  unread: number
  /** Epoch ms of the last message; null when BAB sent no usable time. */
  ts: number | null
}

/** One message of an open thread, as drawn; never handed to the model. */
export type MessageLine = {
  fromId: string
  who: string
  isMine: boolean
  ts: number | null
  /** At most one cap long; a longer message ends in an ellipsis and sets `isCut`. */
  body: string
  isCut: boolean
}

export type OpenThread = {
  id: string
  subject: string
  /** It had unread messages when it was opened: its row keeps its place until it is closed. */
  wasUnread: boolean
  /** It was read and folded away (a note to self, or quiet for two weeks) when it was opened. */
  wasFolded: boolean
  /** How many messages the thread has, of which `messages` are the last ones. */
  total: number
  messages: MessageLine[]
}

/** One open reminder of the person, as the panel draws it. */
export type Reminder = {
  id: string
  /** Shortened for the row. */
  title: string
  /** The whole title, shown when the row is opened. */
  fullTitle: string
  /** The reminder's text, if any, shown when the row is opened. */
  body: string | null
  /** A ticket or key the reminder is about, if any. */
  relatedKey: string | null
  due: string
  isDue: boolean
  isOverdue: boolean
}

/** What a clicked row says under itself: that it is opening, or why it could not. */
export type RowNote = { id: string; text: string; isError: boolean }

/** Why a reminder could not be updated, drawn under that reminder. */
export type ReminderNote = { id: string; text: string }

/** What BAB counted at the last load of the panel's list, which the loaded rows may not show in full. */
export type UnreadCount = {
  /** Threads with something unread, as BAB counts them: the panel says "all caught up" only when this is 0. */
  threads: number
  /** Of those, how many the panel did not load (it loads up to a cap). */
  hidden: number
}

/** The take-up prompt of one thread, shown to copy by hand where the clipboard refused it. */
export type CopyPrompt = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    bab: {
      view: InboxView
      hiddenAt: number
      /** Null until the first load, so the panel can say "Loading" instead of "No conversations". */
      threads: ThreadRow[] | null
      open: OpenThread | null
      notice: string | null
      rowNote: RowNote | null
      reminders: Reminder[]
      reminderNote: ReminderNote | null
      copyText: CopyPrompt | null
      showOlder: boolean
      /** The rest of the conversations past the first five are shown. */
      showMore: boolean
      /** The reminders that are not yet due are shown. */
      showLater: boolean
      /** The reminder whose full text is open under its row, if any. */
      openReminder: string | null
      /** Why BAB's MCP server is not connected in this session, in words a person can act on; null while it is. */
      connectProblem: string | null
      /** Null until the first load of the list. */
      unreadCount: UnreadCount | null
    }
  }
}
