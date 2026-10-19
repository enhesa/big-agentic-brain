# CLAUDE.md

Rules for AI agents working in this repository. CONTRIBUTING.md has the full contributor guide.

## Every change

- Add a line to `lib/changelog.ts` in the same commit as the change, for every change: features, fixes, wording people or agents read, plugin changes, and a short line for internal work. Add to the top entry when it is dated today, otherwise start a new entry with today's date. Write for the people using BAB, in plain words, at most 20 words a line. `tests/changelog.test.ts` fails when a release is newer than the newest entry.
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). release-please builds versions and `CHANGELOG.md` from them: `feat` cuts a minor release, `fix` a patch, `!` a major. Do not edit `CHANGELOG.md` by hand.
- Run `pnpm check` before opening a pull request: config docs, typecheck, unit tests with coverage gates, e2e, vendor-name scan.
- Add or update tests with the change.
- Update the README roadmap when a change ships or adds a roadmap item.

## Content

- Keep the code and docs vendor-neutral: no company, client or real person names. Use `example.com` people and the `acme` org in tests. `scripts/check-vendor-names.sh` enforces it.
- New settings go in `lib/config-spec.mjs`; then run `pnpm docs:config` to regenerate `docs/configuration.md`. Misconfiguration fails at startup, never silently.
- Text people read: short, simple sentences, no em-dashes.
- Memory bodies are untrusted input from any agent: render them as React elements, never as HTML.

## Branches and merges

- Never push to `main`; open a pull request. `main` requires the `check` and `docker` checks.
- release-please pull requests get no CI run; a maintainer merges them with the admin bypass.
