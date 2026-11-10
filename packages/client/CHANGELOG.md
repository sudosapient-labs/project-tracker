# Changelog

## [0.2.1](https://github.com/sudosapient-labs/project-tracker/compare/client-v0.2.0...client-v0.2.1) (2026-11-10)


### Bug Fixes

* let the Slack bot, MCP and CLI set and show due times, on the person's clock ([#42](https://github.com/sudosapient-labs/project-tracker/issues/42)) ([f85a471](https://github.com/sudosapient-labs/project-tracker/commit/f85a471049a1d8a6ac6d2733d6db28e0ebb1598f))
* show a task's newest comments in get_task and sudo-cli show ([#35](https://github.com/sudosapient-labs/project-tracker/issues/35)) ([0f82586](https://github.com/sudosapient-labs/project-tracker/commit/0f825863d13981cd28cb89e30b86e16b7615058a))
* show and enter every time on each person's own clock ([#44](https://github.com/sudosapient-labs/project-tracker/issues/44)) ([fc130f8](https://github.com/sudosapient-labs/project-tracker/commit/fc130f8b6cda0070b490421d175e128858867d1a))
* store and read due times one way everywhere, in the reader's time zone ([#41](https://github.com/sudosapient-labs/project-tracker/issues/41)) ([f0f168c](https://github.com/sudosapient-labs/project-tracker/commit/f0f168c7908e526a7a00427da003380a5f916262))

## [0.2.0](https://github.com/sudosapient-labs/project-tracker/compare/client-v0.1.0...client-v0.2.0) (2026-11-07)


### Features

* **api:** cover everything people do in the app, as the key's person ([273cc9e](https://github.com/sudosapient-labs/project-tracker/commit/273cc9ea3b21ed4b8cd9459aa04f0e87f7120af0))


### Bug Fixes

* **client:** wait out rate limits using Retry-After ([5d9a675](https://github.com/sudosapient-labs/project-tracker/commit/5d9a67507e71be49308e317ed4b721fb26d6bfff))

## 0.1.0 (2026-11-07)


### Features

* API keys, bot members, REST API, MCP, CLI and npm releases ([#11](https://github.com/sudosapient-labs/project-tracker/issues/11)) ([c8f9770](https://github.com/sudosapient-labs/project-tracker/commit/c8f9770047dfa6a23605dbfddf50bbd2d5db917a))


### Bug Fixes

* **cli:** write the config owner-only through a fresh file, warn about --key, and revoke on logout ([cb5fd2f](https://github.com/sudosapient-labs/project-tracker/commit/cb5fd2f4672867d04af6c0e6b036b3e718689939))
* close high and medium findings from the platform audit ([193642a](https://github.com/sudosapient-labs/project-tracker/commit/193642ac08c5058da09306dce1d34d14edcb6d91))
* close low findings from the platform audit and its reviews ([7f55827](https://github.com/sudosapient-labs/project-tracker/commit/7f55827802bd2a6e78ce97c504cff2b9500ede74))
* **packages:** require Node 22 or later ([c37431e](https://github.com/sudosapient-labs/project-tracker/commit/c37431ef16d8ccbf91bd67a3b9db78b2e27dd0ef))
