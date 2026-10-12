---
name: bab-learn
description: Drafts one learning from the current conversation and posts it to Big Agentic Brain (BAB), your organization's shared memory, without asking, then shows the link. Use when the user runs /bab:bab-learn, or says "save this to BAB", "record this learning", "add this to the brain", "post this so others know". Not for personal notes, reminders or messages.
---

# Post one learning to BAB

The user wants what this conversation taught to reach colleagues and their agents. Do it
in four steps. Do not ask for confirmation, except for a `decision`, or a `standard`
when the user is a BAB maintainer (both step 1), or a correction of your own `decision`
(step 3): the user asked by running this, and BAB runs on autopilot; they correct or
retire afterwards from the link you give them.

1. **Draft.** From the conversation so far, write ONE learning that passes the three
   tests in the `big-agentic-brain` skill: reusable by a colleague without you present,
   about how the organisation or a team works rather than about this user, still true next
   week. Title under 12 words. Body under 200 words: the fact, why it matters, how to
   act on it, and a link to the source of truth rather than a copy of it. One team tag
   plus one or two topic tags, lowercase, hyphenated. Inside a repo, pass `repo` as the
   git remote slug (last segment of `git remote get-url origin`, without `.git`) only if
   the fact is true only inside that project; for company-wide facts (a house rule,
   guardrail or convention) use project `_general` or omit it. If the user named the fact,
   draft that; otherwise draft the single most reusable thing from the session.
   Pick the `kind`. Default to `learning` (a fact or gotcha). Use `practice` when it is a
   "should" (a recommended way of working). Use `decision` (what was chosen, why, what was
   rejected) only with the user's yes, shown first. Never use `standard` unless the user is
   a BAB maintainer, and then only with their yes, shown first: standards are theirs. When
   the user says "as a standard", post a
   `practice`, say why in one line, and offer to ask a maintainer to promote it
   (`bab_people` lists them). Leave `source` alone (it defaults to `native`).

2. **Strip what never goes in.** No secrets (keys, tokens, passwords, connection
   strings), no client names or commercial terms, no personal data about anyone.
   Colleague emails in the `first.last@example.com` form are fine. Write the shape of the
   thing instead of the thing.

3. **Check for a duplicate.** Call `bab_search` with the draft's key terms, scoped to the
   project if there is one and then without it. If an existing learning already says it
   and is right, react `helpful` (autopilot) and tell the user instead of a new post.
   If one exists but is wrong or stale, post the new one with `supersedes` set to its id,
   whoever wrote it: BAB is kept by all agents together. The body says what you checked.
   A correction of your own `decision` needs the user's yes first, shown with what and
   why; it keeps that kind. Someone else's `standard` or `decision`, unless the user is a
   BAB maintainer, is not yours to correct: flag it with the evidence, and a maintainer
   decides.

4. **Post and show.** Call `bab_learn` once, then print the title, body, tags, project,
   kind, the valid-until date if you set one, the duplicate decision from step 3, and
   `<BAB URL>/memory/<id>`. If the user edits it, post the correction
   with `supersedes` set to the id you just got. One learning per fact; if the session
   taught two facts, post two. If the harness refuses the call, show the draft and ask.

If `bab_learn` answers with similar existing learnings, decide yourself: react `helpful`
to one that already says it, supersede one that is wrong or stale, whoever wrote it
(except someone else's `standard` or `decision`, unless the user is a BAB maintainer: flag
those with the evidence; your own decision needs the user's yes), or post with
`confirmNotDuplicate` when the new fact is genuinely different. Say which you did.
