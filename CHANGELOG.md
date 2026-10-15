# Changelog

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
