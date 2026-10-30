# AGENTS.md

The rules for AI agents working in this repository are in [CLAUDE.md](CLAUDE.md). Read it before you change anything; they apply to every agent, not only Claude.

The Public repository section below is copied from CLAUDE.md. `tests/public-guardrails.test.ts` keeps the two copies identical.

## Public repository

This repository is public. Code, tests, fixtures, docs, comments, the changelog, commit messages, branch names, PR and issue text, and review comments stay public forever, even after a force-push.

- Never add personal data: real names, emails, usernames or handles of real people, phone numbers, IP addresses, device ids or hostnames of personal machines.
- Never add company-internal information: internal hostnames or URLs, repository or service names, ticket keys, org structure, team or customer names, links to wikis, trackers or chat, cluster or namespace names, infrastructure details, incident details, pricing or contract terms.
- Never add secrets, tokens, keys or passwords, not even revoked or fake-looking real ones. Build credential-shaped test fixtures at runtime.
- Never paste production data, logs, stack traces, database rows or screenshots of real systems into code, tests, fixtures, docs or PR text.
- Use obvious placeholders: `example.com`, `user@example.com`, the `acme` org, `192.0.2.x` (or `198.51.100.x`, `203.0.113.x`), `KEY-1`.
- Keep examples generic. Describe a pattern, not the system where you saw it.
- Never put a ticket key in a tracked file, a branch name or PR text. A ticket key in a commit subject scope is the only exception.
- Scrub agent-written commit messages, PR titles, PR descriptions and review comments by the same rules before you post them.
- Keep deployment notes for a specific organization in that organization's private overlay, not here.
- When unsure whether something is safe to publish, leave it out and say so in the PR so a maintainer can decide.
- Do not weaken `scripts/check-public-content.sh` or `scripts/check-vendor-names.sh`. Add an exception to their allowlist only for a fictional or test value, with a reason.

### Before you open a pull request

- [ ] `pnpm check:public` and `pnpm check:vendor` pass.
- [ ] The diff, commit messages, branch name, PR title and PR body hold no names, emails, internal hosts, IPs, links, ticket keys, secrets or real data.
- [ ] Every example uses a placeholder from the list above.
- [ ] New allowlist lines are fictional values, each with a reason.
- [ ] Anything you were unsure about is listed in the PR for the maintainer.
