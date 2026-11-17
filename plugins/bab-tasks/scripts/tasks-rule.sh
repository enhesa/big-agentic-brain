#!/bin/sh
# BAB Tasks hook: prints the short rule at session start and after a context compaction.
# A compaction can drop the skill text from the session, and a new session may never load it;
# this line stays in context either way. The text is fixed: no network call, nothing read from
# anyone. Always exits 0: a hook must never break or block a session.
printf '%s\n' 'BAB Tasks is on (the bab-tasks plugin is installed). If the text of the bab-tasks skill is not in your context, as in a new session or after a context compaction, load that skill now, before other work. Publish with bab_tasks before the first work step and as the last call of every turn. Every to-do, next step and question you mention goes on BAB Tasks in the same turn. Skip this only when the person asked you to leave BAB Tasks alone.'
exit 0
