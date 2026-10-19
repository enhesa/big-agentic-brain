# Changelog

## [2.2.0](https://github.com/enhesa/big-agentic-brain/compare/v2.1.0...v2.2.0) (2026-10-19)


### Features

* usage page covers 12 months, hero tiles show cumulative totals ([#21](https://github.com/enhesa/big-agentic-brain/issues/21)) ([a1e53be](https://github.com/enhesa/big-agentic-brain/commit/a1e53bee78046be7c1172a89849bc4b56c84ae7b))

## [2.1.0](https://github.com/enhesa/big-agentic-brain/compare/v2.0.0...v2.1.0) (2026-10-16)


### Features

* area contacts and home team ([#17](https://github.com/enhesa/big-agentic-brain/issues/17)) ([2631f32](https://github.com/enhesa/big-agentic-brain/commit/2631f32182419fc967923f3134553b2db50b3c24))
* render memory bodies as markdown ([#14](https://github.com/enhesa/big-agentic-brain/issues/14)) ([03a03e0](https://github.com/enhesa/big-agentic-brain/commit/03a03e0a709765323a63c5ae9b0a07ffd278d4e0))


### Bug Fixes

* freeze the clock in the memory age test so it no longer flakes ([2631f32](https://github.com/enhesa/big-agentic-brain/commit/2631f32182419fc967923f3134553b2db50b3c24))
* stop masking YAML keys and prose as secrets, while still masking plain default passwords ([2631f32](https://github.com/enhesa/big-agentic-brain/commit/2631f32182419fc967923f3134553b2db50b3c24))

## [2.0.0](https://github.com/enhesa/big-agentic-brain/compare/v1.1.0...v2.0.0) (2026-10-15)


### ⚠ BREAKING CHANGES

* BAB_TRUST_PROXY_IDENTITY=1 without BAB_PROXY_SECRET no longer starts unless BAB_TRUST_PROXY_WITHOUT_SECRET=1 is set. "forge" is no longer a built-in applies-to label (set BAB_EXTRA_APPLIES_TO=forge to keep it). Schema v44 renames tables on startup: back up /data first and deploy with a Recreate strategy. The identity source value "forge" is now "proxy" in API responses.

### Features

* security hardening from an external review, proxy naming, README with savings data ([#11](https://github.com/enhesa/big-agentic-brain/issues/11)) ([276fa9f](https://github.com/enhesa/big-agentic-brain/commit/276fa9f640480992e7bfa7c7e819b58a9b0ad11d))

## [1.1.0](https://github.com/enhesa/big-agentic-brain/compare/v1.0.0...v1.1.0) (2026-10-15)


### Features

* reminder details in the inbox panel, maintainer-only pinning, stricter API validation ([b995188](https://github.com/enhesa/big-agentic-brain/commit/b9951888004938eac5440c2c741cec5410e6b1a8))

## 1.0.0 (2026-10-12)


### Features

* Big Agentic Brain 1.0.0, shared memory for AI agents

## Changelog
