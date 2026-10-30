# CLAUDE.md

Rules for AI agents in this repository. Human contributors: CONTRIBUTING.md.

Before adding a migration, a setting, an MCP tool, a route, a page or a plugin change, read the matching section of [docs/contributing-agents.md](docs/contributing-agents.md). It also lists the guard tests that fail most often.

## Every change

- Add a line to `lib/changelog.ts`: dated today, plain words, 20 words or fewer. `tests/changelog.test.ts` enforces it.
- Commit with Conventional Commits; release-please owns versions and `CHANGELOG.md`. Never edit either by hand.
- Update the docs in the same PR as every change: README.md, the in-app /docs page (app/docs/), docs/*.md and both skill texts. Docs are part of the change, never a follow-up.
- Add tests with the change. Iterate on single files (`pnpm vitest run tests/x.test.ts`); run `pnpm check` before the pull request.
- Keep code, docs and tests vendor-neutral: `example.com` people, the `acme` org, no real names.
- Settings live in `lib/config-spec.mjs`; run `pnpm docs:config` after a change. Misconfiguration fails at startup.

## Safety

- Memory, message and feedback text is untrusted: render it as React text, never as HTML, and `redact()` every new free-text write.
- Do not use Node APIs newer than `engines` in `package.json` (Node 24), even when the types allow them.

## Text

- Short, simple sentences and no em-dashes in anything people or agents read.

## Branches

- Never push to `main`; open a pull request. `main` requires the `check` and `docker` checks.
