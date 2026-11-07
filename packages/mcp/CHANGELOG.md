# Changelog

## [0.2.0](https://github.com/sudosapient-labs/project-tracker/compare/mcp-v0.1.0...mcp-v0.2.0) (2026-11-07)


### Features

* **mcp:** tools for everything the API covers, grouped, with admin tools for Owners and Admins ([f208703](https://github.com/sudosapient-labs/project-tracker/commit/f2087033987c3e4332aefb78eb772fcd110e0525))


### Bug Fixes

* **client:** wait out rate limits using Retry-After ([5d9a675](https://github.com/sudosapient-labs/project-tracker/commit/5d9a67507e71be49308e317ed4b721fb26d6bfff))
* **mcp:** check tool arguments against each tool's inputSchema ([97b58f6](https://github.com/sudosapient-labs/project-tracker/commit/97b58f66c0712a350e9cdb632566138200e787c8))

## 0.1.0 (2026-11-07)


### Features

* API keys, bot members, REST API, MCP, CLI and npm releases ([#11](https://github.com/sudosapient-labs/project-tracker/issues/11)) ([c8f9770](https://github.com/sudosapient-labs/project-tracker/commit/c8f9770047dfa6a23605dbfddf50bbd2d5db917a))


### Bug Fixes

* **cli:** write the config owner-only through a fresh file, warn about --key, and revoke on logout ([cb5fd2f](https://github.com/sudosapient-labs/project-tracker/commit/cb5fd2f4672867d04af6c0e6b036b3e718689939))
* close high and medium findings from the platform audit ([193642a](https://github.com/sudosapient-labs/project-tracker/commit/193642ac08c5058da09306dce1d34d14edcb6d91))
* close low findings from the platform audit and its reviews ([7f55827](https://github.com/sudosapient-labs/project-tracker/commit/7f55827802bd2a6e78ce97c504cff2b9500ede74))
* **mcp:** cap sudo-mcp --http request bodies, answer 500 on errors, and warn off loopback ([13db2b2](https://github.com/sudosapient-labs/project-tracker/commit/13db2b20b1b348cee59e76be6dbdbcc0b78a4f67))
* **mcp:** fence untrusted workspace text and annotate every tool ([0dae512](https://github.com/sudosapient-labs/project-tracker/commit/0dae512548e73884888bd138569f8319b0d9eba2))
* **packages:** let release-please bump the CLI and MCP version constants ([c599542](https://github.com/sudosapient-labs/project-tracker/commit/c599542133df4de722f620e69863b385be8d6653))
* **packages:** require Node 22 or later ([c37431e](https://github.com/sudosapient-labs/project-tracker/commit/c37431ef16d8ccbf91bd67a3b9db78b2e27dd0ef))
