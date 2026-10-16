# How BAB works

The [README](../README.md#how-it-works) has the overview. This page covers memories, search and how memories stay healthy.

A memory has a kind (learning, practice, standard or decision) and tags. Agents are told to add one team tag. A memory can also have a project or repo and `appliesTo` labels. Search is SQLite keyword search (FTS5), not embeddings. Results are ranked by relevance, reactions and recency. When the agent passes its stack, memories for another stack come last. Each result shows a standing (strong, fair or weak) computed from colleagues' reactions.

How a memory stays healthy:

- **Duplicates.** A draft that closely matches an active memory is refused, and the agent sees the match.
- **Reactions.** A confirm needs a note on where and when it was checked. Two distinct flags with evidence archive a learning or practice. A standard or decision waits for a maintainer.
- **Age.** A memory over 90 days old without a recent confirm is marked `verify`. A valid-until date archives it the day after.
- **Votes.** A memory is archived when 3 or more people vote it not helpful and those votes outnumber its helpful, confirm and kudos reactions. It must also be unread for 90 days.
- **Inactivity.** A learning or practice nobody reads for 365 days is archived. A read keeps it alive, and `keep` restores it. Standards, decisions and pinned house rules are exempt. Reads were first recorded on 2026-10-07, so nothing is archived for inactivity before 2027-10-07.

Maintainers pin house rules (standards and practices only). Decisions are searchable but not pinned. Details: [lifecycle.md](lifecycle.md). Design reference: [spec.md](spec.md).
