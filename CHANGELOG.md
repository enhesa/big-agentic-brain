# Changelog

## [2.16.0](https://github.com/enhesa/big-agentic-brain/compare/v2.15.1...v2.16.0) (2026-10-30)


### Features

* **kv:** add bab_kv atomic key-value store for agents ([b9927d5](https://github.com/enhesa/big-agentic-brain/commit/b9927d52003e631a57759128d235228699b42bdb))

## [2.15.1](https://github.com/enhesa/big-agentic-brain/compare/v2.15.0...v2.15.1) (2026-10-29)


### Bug Fixes

* **files:** tell a connection-only caller to link its device with bab_identify ([#95](https://github.com/enhesa/big-agentic-brain/issues/95)) ([d1216ae](https://github.com/enhesa/big-agentic-brain/commit/d1216aea6b3204fffca90c7302e21781ec60a782))
* **usage:** name the memory columns and show messages and conversations to everyone ([6373f61](https://github.com/enhesa/big-agentic-brain/commit/6373f61ab050fb78aad647aa1f6bb208ad478a6c))

## [2.15.0](https://github.com/enhesa/big-agentic-brain/compare/v2.14.0...v2.15.0) (2026-10-29)


### Features

* **files:** file store with bab_files, per-person quota and expiry ([#91](https://github.com/enhesa/big-agentic-brain/issues/91)) ([aa510f6](https://github.com/enhesa/big-agentic-brain/commit/aa510f6fb991dab2942fc38f3d24ced5ad370f8a))


### Bug Fixes

* **files:** review fixes for the file store ([#93](https://github.com/enhesa/big-agentic-brain/issues/93)) ([5961c0f](https://github.com/enhesa/big-agentic-brain/commit/5961c0f78ed4a2e56aa79d3d588f8fdd4bfb1899))

## [2.14.0](https://github.com/enhesa/big-agentic-brain/compare/v2.13.0...v2.14.0) (2026-10-28)


### Features

* **memory:** comments on memories, from the page and bab_react ([#89](https://github.com/enhesa/big-agentic-brain/issues/89)) ([d850fa9](https://github.com/enhesa/big-agentic-brain/commit/d850fa91b757cc0a5fb4fbb228e8fdaed5c5a8dc))

## [2.13.0](https://github.com/enhesa/big-agentic-brain/compare/v2.12.0...v2.13.0) (2026-10-28)


### Features

* **usage:** messages, conversations and reminders per week, memories saved and used per person ([f54a0c4](https://github.com/enhesa/big-agentic-brain/commit/f54a0c4050b7291ce22d45471176df3692678f78))

## [2.12.0](https://github.com/enhesa/big-agentic-brain/compare/v2.11.1...v2.12.0) (2026-10-28)


### Features

* **memory:** react on a memory's page from a linked browser ([#85](https://github.com/enhesa/big-agentic-brain/issues/85)) ([f921901](https://github.com/enhesa/big-agentic-brain/commit/f92190180c752391811abd037ba4cd29ee2f75b3))

## [2.11.1](https://github.com/enhesa/big-agentic-brain/compare/v2.11.0...v2.11.1) (2026-10-28)


### Bug Fixes

* **docker:** drop the base image's unused npm from the runtime stage ([#83](https://github.com/enhesa/big-agentic-brain/issues/83)) ([460a021](https://github.com/enhesa/big-agentic-brain/commit/460a021eead64e519bd74a3b4a83002f83fde61a))

## [2.11.0](https://github.com/enhesa/big-agentic-brain/compare/v2.10.0...v2.11.0) (2026-10-27)


### Features

* **usage:** measure agent time and tokens saved per reuse ([#81](https://github.com/enhesa/big-agentic-brain/issues/81)) ([852c191](https://github.com/enhesa/big-agentic-brain/commit/852c1913176e1850f2093f6777c3bdc42aaa55b4))

## [2.10.0](https://github.com/enhesa/big-agentic-brain/compare/v2.9.0...v2.10.0) (2026-10-27)


### Features

* **usage:** time saved, searches that found nothing, unused memories, weekly people ([#78](https://github.com/enhesa/big-agentic-brain/issues/78)) ([3fafbe8](https://github.com/enhesa/big-agentic-brain/commit/3fafbe8261d5ba2f4b60b28abff325f2d3c48042))

## [2.9.0](https://github.com/enhesa/big-agentic-brain/compare/v2.8.1...v2.9.0) (2026-10-27)


### Features

* **usage:** show memories still in BAB and the share of searches that helped ([#76](https://github.com/enhesa/big-agentic-brain/issues/76)) ([1d9f96c](https://github.com/enhesa/big-agentic-brain/commit/1d9f96ccc67cb34268113948e1b2d57974ec8a0f))

## [2.8.1](https://github.com/enhesa/big-agentic-brain/compare/v2.8.0...v2.8.1) (2026-10-27)


### Bug Fixes

* **plugin:** approve only BAB tools on the plugin's own server ([#74](https://github.com/enhesa/big-agentic-brain/issues/74)) ([c39ebe5](https://github.com/enhesa/big-agentic-brain/commit/c39ebe5308d85d4e7808a57c3c5793ed30ed62b6))

## [2.8.0](https://github.com/enhesa/big-agentic-brain/compare/v2.7.2...v2.8.0) (2026-10-27)


### Features

* **admin:** maintainers can link a refused browser on /admin/links ([#69](https://github.com/enhesa/big-agentic-brain/issues/69)) ([ac34035](https://github.com/enhesa/big-agentic-brain/commit/ac3403552ba17d44ddb39bece9fb256ad6926c9f))
* **plugin:** approve BAB's own tools without a permission dialog ([#72](https://github.com/enhesa/big-agentic-brain/issues/72)) ([44ad3a7](https://github.com/enhesa/big-agentic-brain/commit/44ad3a73ab6e6936ec7d1668a6c37116ed38b2d0))


### Bug Fixes

* **plugin:** pause the inbox poll when a BAB call goes unanswered ([#71](https://github.com/enhesa/big-agentic-brain/issues/71)) ([e7cc4d2](https://github.com/enhesa/big-agentic-brain/commit/e7cc4d2e1d98d0b19498528d562bc833b87f45da))

## [2.7.2](https://github.com/enhesa/big-agentic-brain/compare/v2.7.1...v2.7.2) (2026-10-26)


### Bug Fixes

* **identity:** accept SSO aliases with a two- or three-letter first-name prefix ([#67](https://github.com/enhesa/big-agentic-brain/issues/67)) ([0a1209c](https://github.com/enhesa/big-agentic-brain/commit/0a1209c50a793b122bcbe19fab8465b0bd3995f3))

## [2.7.1](https://github.com/enhesa/big-agentic-brain/compare/v2.7.0...v2.7.1) (2026-10-22)


### Bug Fixes

* **plugin:** fewer permission prompts: read-only tool hints, pause polling when refused ([#64](https://github.com/enhesa/big-agentic-brain/issues/64)) ([567a71f](https://github.com/enhesa/big-agentic-brain/commit/567a71f8d3c08f915720c76db57e8415ac4b42b9))

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
