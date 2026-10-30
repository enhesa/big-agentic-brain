# Contributing

Thanks for helping. Keep changes small and tested.

## Setup

```bash
corepack enable
pnpm install
DATA_DIR=./.data pnpm dev   # http://localhost:4310
```

About 2,000 tests sit behind coverage gates (85 percent of lines and functions, 75 percent of branches). An end-to-end suite boots the standalone server. CI runs `pnpm check` and a Docker build on every push to main and every pull request. BAB needs Node 24 or newer.

The container default data directory is `/data`, which a dev machine usually cannot write, so point `DATA_DIR` at a local folder.

## Before you open a PR

- Run `pnpm check` (config docs check, typecheck, unit tests with coverage, e2e, vendor-name scan, public-content scan).
- Add or update tests with the change. `tests/regression.md` lists the manual checks to run before a release.
- Update the **Roadmap** section in the README, or tick the box in the PR template saying it is not needed.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`). Releases are generated from them.
- Releases are cut by release-please from Conventional Commits. The first release (v1.0.0) used a one-time `release-as` pin, since removed.
- No sign-off (DCO) is required.

## Everything here is public

This repository is public, and so are its commits, branch names, pull requests, issues and review comments. They stay public after a force-push.

- Do not add personal data: names, emails or handles of real people, phone numbers, IP addresses, device ids.
- Do not add internal details of any organization: hostnames, URLs, repository or service names, ticket keys, team or customer names, wiki, tracker or chat links, cluster names, incident details, pricing.
- Do not add secrets or tokens, not even revoked ones, and do not paste production data or logs into tests, fixtures, docs or PR text.
- Use placeholders: `example.com`, `user@example.com`, the `acme` org, `192.0.2.x`.
- If you are unsure, leave it out and ask in the pull request.

`pnpm check:public` (`scripts/check-public-content.sh`) scans tracked files for emails, internal hosts, private IPs, workplace links, ticket references and token shapes. A second CI workflow (`pr-text`) scans the PR title, body and commit messages. Exceptions for fictional test values go in `scripts/public-allowlist.txt` with a reason; maintainers review each one. If you published something by mistake, see [SECURITY.md](SECURITY.md).

## Where configuration lives

Settings are declared in `lib/config-spec.mjs`. After a change run `pnpm docs:config` to regenerate `docs/configuration.md`. Do not hard-code organization names, domains or people: they belong in settings.

## Conduct and security

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Agent evals

The coding-agent eval harness lives under `evals/`. See [evals/README.md](evals/README.md).
