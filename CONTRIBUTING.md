# Contributing

Thanks for helping. Keep changes small and tested.

## Setup

```bash
corepack enable
pnpm install
DATA_DIR=./.data pnpm dev   # http://localhost:4310
```

The container default data directory is `/data`, which a dev machine usually cannot write, so point `DATA_DIR` at a local folder.

## Before you open a PR

- Run `pnpm check` (config docs check, typecheck, unit tests with coverage, e2e, vendor-name scan).
- Add or update tests with the change. `tests/regression.md` lists the manual checks to run before a release.
- Update the **Roadmap** section in the README, or tick the box in the PR template saying it is not needed.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`). Releases are generated from them.
- Releases are cut by release-please from Conventional Commits. The first release (v1.0.0) used a one-time `release-as` pin, since removed.
- No sign-off (DCO) is required.

## Where configuration lives

Settings are declared in `lib/config-spec.mjs`. After a change run `pnpm docs:config` to regenerate `docs/configuration.md`. Do not hard-code organization names, domains or people: they belong in settings.

## Conduct and security

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
