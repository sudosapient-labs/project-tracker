# CI and releases

## Branches

`prod` is the default branch and the only long-lived one. Work happens on short-lived branches and
lands through a pull request, squash-merged so the PR title becomes the commit on `prod`.

Branch protection is by convention for now (it needs a paid plan to enforce): don't push to `prod`
directly, and wait for the `ci-ok` check before merging.

### The `main` → `prod` rename

The repository started with `main` and was renamed to `prod` on 2026-11-05. Railway's deploy trigger
watches `prod`. Old `main` URLs redirect, but clones made before the rename need:

```bash
git branch -m main prod && git fetch origin && git branch -u origin/prod prod
```

## Pull request checks

Every pull request, and every push to `prod`, runs `.github/workflows/ci.yml`:

```
lint ─────────┐
typecheck ────┤
test ─────────┼──► ci-ok
build ─► e2e ─┤
pr-title ─────┘
```

| Job         | Runs                                                                  |
| ----------- | --------------------------------------------------------------------- |
| `lint`      | `pnpm lint` (ESLint) and `pnpm format:check` (Prettier)               |
| `typecheck` | `pnpm typecheck` (see below)                                          |
| `test`      | `pnpm test` (Vitest API tests)                                        |
| `build`     | `pnpm build`; the `dist/` it makes is handed to `e2e`                 |
| `e2e`       | `pnpm test:e2e:run`: the Playwright journeys against that build       |
| `pr-title`  | the PR title is a Conventional Commit (pull requests only)            |
| `ci-ok`     | passes when all of the above passed; this is the one check to require |

The jobs run in parallel apart from `e2e`, which waits for `build`. When branch protection becomes
available, require only `ci-ok`.

### Type checking

The code is plain JavaScript, so `tsc` checks only files that start with `// @ts-check`
(`checkJs` is off in `tsconfig.json`). That covers `server/` outside routes and scripts, plus
`src/core/`. To bring a file under the check, add the line, run `pnpm typecheck` and fix what it
reports. Don't add it to a file without fixing the errors.

## Releases

Versions come from [Conventional Commits](https://www.conventionalcommits.org) on `prod`, through
[release-please](https://github.com/googleapis/release-please) (`release-please-config.json`,
`.release-please-manifest.json`, `.github/workflows/release-please.yml`).

- `fix:` → patch, `feat:` → minor, and a `!` or `BREAKING CHANGE:` → minor while we're below 1.0, major after.
  `chore:`, `docs:`, `ci:`, `test:` and `refactor:` don't release on their own.
- After each push to `prod`, release-please opens or updates a **release PR** that bumps `version` in
  `package.json` and adds the new section to `CHANGELOG.md`.
- Merging that PR creates the `vX.Y.Z` tag and the GitHub release.

Tagging doesn't deploy anything by itself, but merging the release PR is a push to `prod`, so Railway
deploys it like any other change.

### Setup the release workflow needs

- The org and the repository both allow GitHub Actions to create pull requests (Settings → Actions →
  General → Workflow permissions). Without it the release PR can't be opened.
- PRs opened with the default `GITHUB_TOKEN` don't start other workflows, so CI doesn't run on the
  release PR; it only changes `package.json` and `CHANGELOG.md`. If you want it to run, add a
  `RELEASE_PLEASE_TOKEN` secret (a PAT or app token with contents and pull-requests write); the
  workflow uses it when present.

## npm packages

`packages/client`, `packages/cli` and `packages/mcp` are released on their own and published to npm as
`@sudosapient/client`, `@sudosapient/cli` and `@sudosapient/mcp`: **public** packages in the `sudosapient`
npm org (free plan), so anyone can install them. The CLI and MCP server also run with
`npx @sudosapient/cli` and `npx @sudosapient/mcp`; `client` is the library they share, not a command.
npm packages ship their source, so their code is readable. They hold only API client code (calls to the documented `/api/v1`), none of the server.
They stay `UNLICENSED` with no license file: visible, but all rights reserved.

- release-please treats each one as a component with its own version, `CHANGELOG.md` and tag
  (`client-vX.Y.Z`, `cli-vX.Y.Z`, `mcp-vX.Y.Z`). A commit counts for a package when it touches files in
  that package's folder; the app (`.`) ignores commits that only touch `packages/`. The same release PR
  carries every component that has something to release.
- Merging the release PR runs three jobs in `release-please.yml`, only when a package was released:

  ```
                 ┌─► check-npm ─┐
  release-please ┤              ├─► publish-npm (environment: npm)
                 └─► pack-npm ──┘
  ```

  | Job           | Permissions                 | Runs                                                                                                                                              |
  | ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `check-npm`   | `contents: read`            | `pnpm install`, then `lint`, `typecheck` and `test` again (CI runs on the same push in parallel); publishing waits for it                         |
  | `pack-npm`    | `contents: read`            | `pnpm pack` for each released package, with nothing installed: no dependency's code runs in the job whose output is published                     |
  | `publish-npm` | `id-token: write`, no other | downloads those tarballs and runs `npm publish <tarball> --access public --provenance` on each, `client` first; no checkout, no install, no cache |

  `pnpm pack` turns `workspace:*` into the real version from the workspace's own `package.json` files,
  which needs no `node_modules` (`pack-npm` fails if a tarball still has a `workspace:` dependency, or
  if anything was installed), and the tarballs reach `publish-npm` as the `npm-tarballs` artifact. A version
  that's already on npm is skipped, so re-running `publish-npm` is safe; the artifact is kept for 7 days.

- `publish-npm` is the only job in the repository with `id-token: write`, the permission that lets a job
  ask GitHub for the OIDC token npm accepts. Keeping it apart means the dev dependencies and tests that
  `check-npm` runs can't reach that token, and they never touch the tarballs either.
- It authenticates with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC):
  there is no npm token in GitHub. npm checks that `repository.url` in the package's `package.json` is
  this repository, so keep it. Each version gets a provenance attestation linking it to the workflow run.
- `publish-npm` runs in the `npm` GitHub environment (Settings → Environments → npm), which the trusted
  publisher on npm also names. Its deployment branch policy allows only `prod`. It has no required
  reviewers, on purpose: a publish waiting for approval keeps the release run open, and Railway's
  "Wait for CI" would wait on it.

The version `sudo-cli --version` and `sudo-mcp --version` print (and the MCP server reports) is a
constant in `packages/cli/src/cli.js` and `packages/mcp/src/protocol.js`, marked
`// x-release-please-version`; release-please bumps it with `package.json` (`extra-files`), and a
test fails if the two differ.

`cli` and `mcp` pin the exact `client` version they were released with. A `client`-only release
doesn't reach them until they're released again.

### One-time npm setup

npm attaches a trusted publisher to a package that already exists, so the first version of each package
is published by hand, once:

1. Sign in to npm as an owner of the `sudosapient` org: `npm login`.
2. From a clean checkout of `prod`, publish each package, `client` first:

   ```bash
   pnpm install --frozen-lockfile
   for p in client cli mcp; do (cd packages/$p && pnpm publish --access public --no-git-checks); done
   ```

3. On npmjs.com, for each of the three packages: **Settings → Trusted publishing → GitHub Actions**, with
   organization `sudosapient-labs`, repository `project-tracker`, workflow filename `release-please.yml`
   and environment `npm`. Allow **`npm publish`** (new configurations allow only `npm stage publish` by
   default, which the workflow doesn't use). A new configuration expires if it isn't used within 2 days,
   but it is only used when a release PR that bumps the package is merged, so set it up just before that.
4. Optional, once a CI publish has worked: **Settings → Publishing access → Require two-factor
   authentication and disallow tokens** on each package.

release-please starts each package at `0.1.0` (`initial-version`), so its first release PR for the
packages proposes the version you published by hand. Merging it creates the GitHub releases and tags;
the publish step sees the version is already on npm and skips it.

## Dependencies

Dependabot (`.github/dependabot.yml`) opens a weekly PR for npm (minor and patch updates grouped;
majors come one by one), one for GitHub Actions and one for the Dockerfile's base image. Their titles
are already Conventional Commits (`chore(deps)`, `ci(deps)`).

Every third-party action, in the workflows and in `.github/actions/setup`, is pinned to a full commit SHA
with the version in a comment (`uses: actions/checkout@<sha> # v4.4.0`), so a moved tag can't change
what runs. Dependabot updates the SHA and the comment together; keep the comment when pinning by hand.
The Dockerfile's base image is pinned the same way, by the digest of its multi-arch index
(`FROM node:24-slim@sha256:…`); to move it by hand, take the digest from
`docker buildx imagetools inspect node:24-slim` and update both `FROM` lines.
