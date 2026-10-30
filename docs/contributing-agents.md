# Contributing with an AI agent

Read this on demand, before you change the area a section names. It lists the rules that tests and CI enforce, and the ones they cannot. Every pointer is `file:line` at the time of writing, so search for the symbol if a line has moved. The rules for every change are in [CLAUDE.md](../CLAUDE.md); the human guide is [CONTRIBUTING.md](../CONTRIBUTING.md).

## Guard tests you will trip over

- Keep the MCP instructions text at 1980 characters or fewer for the live origin (`tests/mcp-instructions.test.ts:18`). Any origin must stay under 2000 (`:22`).
- Keep the identify rule, the `bab_link_session` rule and the "may be stale" line before character 2048 (`tests/mcp-instructions.test.ts:26`). The text is `mcpInstructions` in `lib/mcp.ts:110`.
- Keep the house-rules block at `HOUSE_RULES_MAX_CHARS` (1200), set in `lib/learnings.ts:2298` and pinned by `tests/house-rules.test.ts:164`.
- Keep the `/docs` page to diagrams. The visible word cap is 1350 (`tests/docs-page.test.ts:220`). Prose is a lede, one caption per section and a footnote, with word limits (`:226-234`). Shorten text. Do not raise the cap.
- Keep `app/docs` components as server components, with no `"use client"` (`tests/docs-page.test.ts:244`).
- Change the tool count in `tests/docs-page.test.ts:198` and `tests/mcp-identify.test.ts:133` when you add or remove an MCP tool. Both expect 12 today.
- Name every MCP tool in `docs/spec.md`, both skill files and the /docs page. `tests/docs-drift.test.ts` and `tests/docs-page.test.ts` fail on a tool that is missing.
- Keep `content/instructions/*.md` free of control bytes except tab, LF and CR (`tests/instructions.test.ts:76`). Write them with an editor tool, never a shell heredoc (`tests/instructions.test.ts:72-74`). They must stay LF (`.gitattributes:4`).
- Keep the served `{origin}` placeholders substituted (`tests/instructions.test.ts:51-59`). Keep the `skill.md` frontmatter valid (`:62`).
- Know that any edit to `install.md` or `skill.md` changes the served version hash (`tests/instructions.test.ts:14-47`, `docs/spec.md:605`). Agents refresh themselves from it.
- Start every write example in `skill.md` with `curl -X POST` (`tests/instructions.test.ts:96-103`). A permission rule matches that prefix.
- Ship no scripts in `content/instructions`, and never tell anyone to run `node` (`tests/instructions.test.ts:107-118`).
- Keep `content/instructions/skill.md` and `plugins/claude-code/skills/big-agentic-brain/SKILL.md` in step by hand. No test links them. Both describe the tools.
- Give every new route or page an identity helper, a `PUBLIC_PATHS` entry or an `ANONYMOUS_OK` entry with a one-line reason (`tests/route-inventory.test.ts:12`, `lib/public-paths.ts:8`). Remove `ANONYMOUS_OK` entries for deleted routes (`:55`).
- Set `CURRENT_VERSION` in `lib/db.ts:13` to the highest migration (`tests/db.test.ts:487`).
- Add a line to `CHANGELOG` in `lib/changelog.ts` for every change (`lib/changelog.ts:3-10`). Dates are ISO, newest first, one entry per day. Lines have 20 words or fewer and no em-dash (`tests/changelog.test.ts:14`, `:28-36`).
- Keep vendor, organization and Jira-key strings out of tracked files. The scan is `scripts/check-vendor-names.sh:8`. It covers `app lib content plugins docs tests`, `README.md`, `scripts` and `.github`. Exceptions go in `scripts/vendor-allowlist.txt` as `path:substring`.
- Person-name checks only run when `VENDOR_EXTRA_PATTERN` is set (`scripts/check-vendor-names.sh:7-9`). A clean scan does not prove a file has no names.
- Do not use `NEXT_PUBLIC_` in `app` or `lib`. Only CI checks it (`.github/workflows/ci.yml:31`). `runTest.sh` does not.
- Keep the coverage gates: 85 percent lines and functions, 75 percent branches (`vitest.config.mts:43`). They cover `lib`, `app/api` and `app/instructions`. See [CONTRIBUTING.md](../CONTRIBUTING.md).
- Keep pages that post a form on a referrer policy that sends the origin to itself. `no-referrer` breaks `sameOrigin` (`tests/referrer-policy.test.ts:4-9`).

## Adding a migration

- Add `runMigrationVN(database)` in `lib/db.ts` and a block `if (appliedVersion < N)` after the last one (`lib/db.ts:297`). The block inserts the version row and sets `appliedVersion`.
- Raise `CURRENT_VERSION` (`lib/db.ts:13`). If it lags, a database returns early and never gets your block (`lib/db.ts:10-12`, `:39`).
- Pick a unique number. The runner reads `MAX(version)` (`lib/db.ts:34-37`). If a higher number ships first, your lower one is skipped forever. Renumber on rebase.
- Guard `ALTER TABLE ... ADD COLUMN` with a `PRAGMA table_info` check (`lib/db.ts:315`). SQLite has no `IF NOT EXISTS` for columns.
- Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` (`lib/db.ts:318-326`).
- Write `UPDATE` and backfill statements so they can run twice (`lib/db.ts:1358`). A process can die before the version row is written.
- Never edit an old migration. Migrations only go forward.
- `DATA_DIR` is the only environment read in `lib/db.ts` (`lib/db.ts:15`). Do not read other settings there.
- Wrap multi-statement writes in `inTransaction(database, fn)` (`lib/db.ts:1331`). It is `BEGIN IMMEDIATE` and it throws on nesting.
- Call `emit()` after `inTransaction` returns, never inside it (`lib/db.ts:1327-1329`).
- Test a migration by rewinding. Delete the version rows, close the database, reopen it (`tests/db-v33.test.ts:37`, `tests/agent-reads.test.ts:439`, `tests/area-contacts.test.ts:293`). Then assert the data.

## Adding a setting

- Add one entry `{ env, default, description }` to `lib/config-spec.mjs`.
- Parse and validate it in `lib/config.ts`. Throw `ConfigError` for a bad value (`lib/config.ts:95`, `:102`). A bad setting must stop startup. Do not default it to an empty value.
- Read settings with `config()` only (`lib/config.ts:285`). Do not read `process.env` in app code. The exceptions are `DATA_DIR` in `lib/db.ts:17` and `NEXT_RUNTIME` in `instrumentation.ts:7`.
- Run `pnpm docs:config` to regenerate `docs/configuration.md`. The file must equal the generator output byte for byte, with LF only (`tests/docs-config.test.ts:16-20`, `.gitattributes:6`).
- Boolean settings accept 1, true, yes, on and 0, false, no, off (`lib/config.ts:93-94`). Reuse that parser.
- Add the variable to `ACME_ENV` in `tests/setup-env.ts:17` only when many tests need it. Test one-off values in the test itself.
- `tests/config.test.ts:10` clears every `BAB_*` variable before each test. Set what you need there.

## Adding an MCP tool or field

- Add the tool to the `TOOLS` table in `lib/mcp.ts:682`. Keep `run` thin. It calls the same `lib` function as the matching REST route (`lib/mcp.ts:1-6`).
- Refuse with an `ApiError` subclass: `ValidationError`, `NotFoundError`, `ForbiddenError`, `ConflictError` (`lib/errors.ts:9-52`). The route turns them into `isError` results (`lib/mcp.ts:8-13`). Anything else is a bug and surfaces as a protocol error.
- Give an `action` argument no default. Say "required, has no default" (`lib/mcp.ts:889`, `:941`).
- Refuse an unknown filter value. Never read it as "no filter" (`lib/learnings.ts:574-580`, used at `lib/mcp.ts:194`).
- Update the tool count in `tests/docs-page.test.ts:198` and `tests/mcp-identify.test.ts:133`, and the "twelve MCP tools" comment (`lib/mcp.ts:2`). Name the tool in `docs/spec.md`, both skill files and the /docs architecture text alternative (`tests/docs-drift.test.ts`).
- Re-check the instruction length tests (`tests/mcp-instructions.test.ts`) if the tool needs a rule in `mcpInstructions`.
- Know that the lean tool list (`?tools=lean`, `LEAN_TOOL_NAMES` in `lib/mcp.ts`) hides every new tool. Add yours there only if a coding agent needs it, and update `tests/mcp-lean.test.ts` (it expects 4 lean and 12 full tools).
- Update both skill files (see the first section).
- When a REST route does the same job, call the same `lib` function and pass the same audit `via` value (`app/api/todos/route.ts:22`).

## Adding an API route

- Copy `app/api/todos/route.ts`. Export `dynamic = "force-dynamic"` (`:9`).
- Resolve the actor with `requireActorForApi()` and return a thrown `Response` as is (`:15-21`, `:37-43`).
- Call `auditRequest({ actor, method, path, via })` (`:22`, `:44`).
- Wrap POST in `withIdempotency(req, user.id, fn)`. `fn` returns `{ status, body }` (`:46-73`). Map errors with `toApiError` (`:71`).
- Do not make a route public to skip identity. `PUBLIC_PATHS` is a fixed list that configuration cannot widen (`lib/public-paths.ts:2-7`).
- Keep `/api/hook` answering 200 with `{}` on every failure (`app/api/hook/route.ts:164-183`, `:296`). A hook must never break a session.
- Pick the right rate-limit bucket (`lib/rate-limit.ts:11-22`). Agent API calls use the actor bucket. Browser routes use `checkUiRateLimit` (`:54`). Anonymous calls use the anon buckets (`app/mcp/route.ts:178-184`).
- Rate limits are constants, not settings, and each one has one source (`lib/rate-limit.ts:2-6`). Error texts build from them.
- Call `emit()` after the write commits. Event payloads hold ids, titles and a kind only. `/api/events` is public (`lib/events.ts:21-26`).
- Pass every new free-text write through `redact()` (`lib/redact.ts:229`). Reject a label or key that redaction would change (`lib/area-contacts.ts:57`).

## Adding a web page or form route

- Resolve the viewer with `getViewer()` (`lib/notify-auth.ts:20`) or `currentUser()` (`lib/user.ts:26`). Both read the sign-in proxy headers.
- Never take identity from a form field, a query string or a body. Agent headers are not a viewer (`lib/notify-auth.ts:15-19`).
- Start every POST with `if (!sameOrigin(req)) return forbiddenResponse()` (`lib/feedback-web.ts:9`, `app/inbox/read/route.ts:21`). The cookie makes a cross-site post possible.
- Answer a plain form post with a 303 redirect (`lib/feedback-web.ts:40`). Answer a JSON caller with JSON.
- A device secret never drives an SSO page or route (`lib/session.ts:40-41`).
- Check the rate limit with `checkUiRateLimit(viewer.ownerId)` (`app/inbox/read/route.ts:26`).

## Plugin changes

- Do not edit version fields. release-please owns them in `package.json` and `plugins/claude-code/.claude-plugin/plugin.json` (`release-please-config.json:9-13`).
- The mod never hands Claude a colleague's text. It uses fixed prompts, and a colleague's message is data (`plugins/claude-code/hooks/register.tsx:87-91`). It strips control characters before it draws text (`:195`).
- Accept only an `https` origin, or `http` for loopback (`plugins/claude-code/hooks/register.tsx:33-41`). Do not hardcode a host (`:29`). The server supplies `origin`.
- Update `plugins/claude-code/README.md` when hook behaviour changes (`:25-37`).
- Keep `.sh` scripts LF (`.gitattributes:2`). A CRLF shebang breaks them.
- Add a changelog line when plugin behaviour ships (`lib/changelog.ts:5-7`).

## Security

- Render memory, message and feedback text as React text. Never as HTML (`app/memory/[id]/page.tsx:207`, `app/reminders/ReminderBody.tsx:27`).
- The one `dangerouslySetInnerHTML` is the search snippet (`app/memory/page.tsx:357`). It is safe only because `renderSnippetHtml` escapes first and then swaps the marker bytes for `<mark>` (`lib/learnings.ts:678-713`). Do not reorder this.
- Render markdown bodies with `lib/markdown.ts` and `app/components/Markdown.tsx`. Every node is a React element.
- Take the actor from the proxy headers only. Never trust a client-supplied author id, email or name (`lib/user.ts:21-24`).
- Never log a device secret or its hash. Never write either to an audit row (`lib/devices.ts:21`).
- Compare tokens with `safeEqual` and no early exit (`lib/gate.ts:6`, `:21-31`).
- A token bound to an email (`token=email`) is that person. The address acts only with its token, never through headers, devices or connections (`lib/session.ts:104-108`, `:285`).
- Redaction: a YAML key is not a value. `passwordSecret:` followed by `secretName: app-user` stays as is (`lib/redact.ts:28-33`).
- Redaction: keep masking config lines such as `password: postgres` (`lib/redact.ts:38-40`, `tests/redact-prose.test.ts:24-28`).
- Build credential-shaped test fixtures at runtime so the source holds no real-looking secret (`tests/redact-prose.test.ts:4`).

## Test gotchas

- Run one file while you iterate: `pnpm vitest run tests/x.test.ts`. The suite is serial on purpose (`vitest.config.mts:33`).
- Each test file runs in its own process (`vitest.config.mts:23`). The test timeout is 20 seconds (`:19`). Page render tests import the whole app on first run.
- Run vitest from the repo root with the repo config. Vitest collects any `*.test.ts` below the working folder, so a stray checkout inside it adds tests.
- The e2e suite needs a build (`tests/e2e/global-setup.ts:124-136`). Set `E2E_SKIP_BUILD=1` to reuse a build.
- Give each test file its own `DATA_DIR` and reset in `beforeEach` and `afterEach`: `mkdtempSync`, `vi.resetModules()`, `_resetDbForTests()`, `rmSync` (`tests/docs-page.test.ts:17-31`). `tests/setup-env.ts:37-38` sets a per-process default.
- A `vi.doMock("next/headers", ...)` binds when a module is first imported. A route module already loaded keeps its identity. Either seed state through `getDb()`, or mock with a mutable variable (`tests/api-feedback.test.ts:28-31`).
- Pin time in UI tests. Use `vi.useFakeTimers({ toFake: ["Date"], now })` and write timestamps from the same clock (`tests/memory-project-ui.test.ts:218-221`).
- If only `tests/perf.test.ts` fails on a busy machine, rerun it alone. Read the `db factor` it prints (`tests/perf.test.ts:165`, `:176-181`). Never loosen a budget. Set `PERF_TIMINGS_FILE` to log timings from green runs (`:44-52`).
- A headless screenshot of `/usage` never reaches network idle. The page holds an SSE stream open (`app/components/shell/LiveUpdates.tsx:60`). Wait for `load`.
- On Windows, read and write files as UTF-8. Python defaults to cp1252. Run `.sh` scripts under Git Bash.
