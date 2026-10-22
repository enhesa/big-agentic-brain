# Changelog

## [2.7.0](https://github.com/enhesa/big-agentic-brain/compare/v2.6.1...v2.7.0) (2026-10-22)


### Features

* **reminders:** a time of day on reminders ([#62](https://github.com/enhesa/big-agentic-brain/issues/62)) ([2946979](https://github.com/enhesa/big-agentic-brain/commit/2946979435f93fa3fe3329a9a5a05dfe5c98b684))


### Bug Fixes

* **hooks:** accept a trailing slash in bab_url; keep doc placeholders unmasked ([#59](https://github.com/enhesa/big-agentic-brain/issues/59)) ([d2db97c](https://github.com/enhesa/big-agentic-brain/commit/d2db97ca824f2f94e1b312f51ae089289416dd8e))

## [2.6.1](https://github.com/enhesa/big-agentic-brain/compare/v2.6.0...v2.6.1) (2026-10-21)


### Bug Fixes

* **docs:** refresh README and the /docs page for v2.6 ([#57](https://github.com/enhesa/big-agentic-brain/issues/57)) ([ebc8265](https://github.com/enhesa/big-agentic-brain/commit/ebc82655913cfdd47442c73f67a0657ab524e7a4))

## [2.6.0](https://github.com/enhesa/big-agentic-brain/compare/v2.5.1...v2.6.0) (2026-10-21)


### Features

* **search:** multi-phrasing search and aliases at save time ([#55](https://github.com/enhesa/big-agentic-brain/issues/55)) ([e6570bf](https://github.com/enhesa/big-agentic-brain/commit/e6570bf780c6d1abcf5fc7247ab8021a2073ca24))

## [2.5.1](https://github.com/enhesa/big-agentic-brain/compare/v2.5.0...v2.5.1) (2026-10-21)


### Bug Fixes

* **landing:** explain in the FAQ how BAB keeps sensitive data out ([#53](https://github.com/enhesa/big-agentic-brain/issues/53)) ([fe6028f](https://github.com/enhesa/big-agentic-brain/commit/fe6028f2992f5a3ccb11aac71fdd60ec87dc8d1d))

## [2.5.0](https://github.com/enhesa/big-agentic-brain/compare/v2.4.1...v2.5.0) (2026-10-20)


### Features

* **hook:** ask for a structured learning after a finished task ([#46](https://github.com/enhesa/big-agentic-brain/issues/46)) ([65a6ae3](https://github.com/enhesa/big-agentic-brain/commit/65a6ae3b880049293085623223d49ffccfa1ce97)), closes [#31](https://github.com/enhesa/big-agentic-brain/issues/31)
* **hook:** nudge agents to search BAB first on a new task ([#45](https://github.com/enhesa/big-agentic-brain/issues/45)) ([95c55e5](https://github.com/enhesa/big-agentic-brain/commit/95c55e5b35c4ef7bfbc6032e23476cb42f4848ee)), closes [#29](https://github.com/enhesa/big-agentic-brain/issues/29)
* **hook:** show the best matching memories on a new task ([#48](https://github.com/enhesa/big-agentic-brain/issues/48)) ([cda79e1](https://github.com/enhesa/big-agentic-brain/commit/cda79e16ccd3118823c5329b72da808cd46dadab))
* **mcp:** lean tool list and shorter tool descriptions ([#51](https://github.com/enhesa/big-agentic-brain/issues/51)) ([a465c8f](https://github.com/enhesa/big-agentic-brain/commit/a465c8f734c391073ed52780b5452a4d6acbcc79))
* **search:** improve recall for paraphrase and error-only queries ([#49](https://github.com/enhesa/big-agentic-brain/issues/49)) ([97cc1ec](https://github.com/enhesa/big-agentic-brain/commit/97cc1ec5b3c36671a8447203017beac3bde0fd84))
* **search:** warn next to the title when a memory may be out of date ([#50](https://github.com/enhesa/big-agentic-brain/issues/50)) ([c8c960a](https://github.com/enhesa/big-agentic-brain/commit/c8c960a2d706ead080275466f98d0c75abf5121d)), closes [#32](https://github.com/enhesa/big-agentic-brain/issues/32)


### Bug Fixes

* **memory:** list every author in the Author filter ([#52](https://github.com/enhesa/big-agentic-brain/issues/52)) ([b76e54b](https://github.com/enhesa/big-agentic-brain/commit/b76e54b39d795f4831f629da13687f08ae62cc03))

## [2.4.1](https://github.com/enhesa/big-agentic-brain/compare/v2.4.0...v2.4.1) (2026-10-20)


### Bug Fixes

* **evals:** skip the symlink tests where symlinks cannot be created ([#43](https://github.com/enhesa/big-agentic-brain/issues/43)) ([ac1d148](https://github.com/enhesa/big-agentic-brain/commit/ac1d1481fb13f196d4e484ac0fbeb38f70fd9c35))

## [2.4.0](https://github.com/enhesa/big-agentic-brain/compare/v2.3.1...v2.4.0) (2026-10-20)


### Features

* **memory:** sort the memory list ([#41](https://github.com/enhesa/big-agentic-brain/issues/41)) ([96b3b39](https://github.com/enhesa/big-agentic-brain/commit/96b3b39e8b7222f357786099df06b6bbb2a44f10))


### Bug Fixes

* **mcp:** search all kinds before any task, not only before repo changes ([#40](https://github.com/enhesa/big-agentic-brain/issues/40)) ([d5d4e93](https://github.com/enhesa/big-agentic-brain/commit/d5d4e93e04977e6b1b80bc19a4054df5cc2ce1a5))

## [2.3.1](https://github.com/enhesa/big-agentic-brain/compare/v2.3.0...v2.3.1) (2026-10-19)


### Miscellaneous Chores

* release 2.3.1 to ship the in-app changelog ([#35](https://github.com/enhesa/big-agentic-brain/issues/35)) ([ade3087](https://github.com/enhesa/big-agentic-brain/commit/ade30878f929028d72c143f014a84453eef22730))

## [2.3.0](https://github.com/enhesa/big-agentic-brain/compare/v2.2.0...v2.3.0) (2026-10-19)


### Features

* optional install screenshot on the landing page ([#23](https://github.com/enhesa/big-agentic-brain/issues/23)) ([47a59f5](https://github.com/enhesa/big-agentic-brain/commit/47a59f543b46fd1b6bade7ebe138c1d45f1ce319))
* ship the Claude app install screenshot by default ([#25](https://github.com/enhesa/big-agentic-brain/issues/25)) ([8f78273](https://github.com/enhesa/big-agentic-brain/commit/8f7827343576937fa4b6ab89175ca267e3a7c506))

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
