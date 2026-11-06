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
npm org (free plan), so anyone can `npx` them. npm packages ship their source, so their code is
readable. They hold only API client code (calls to the documented `/api/v1`), none of the server.
They stay `UNLICENSED` with no license file: visible, but all rights reserved.

- release-please treats each one as a component with its own version, `CHANGELOG.md` and tag
  (`client-vX.Y.Z`, `cli-vX.Y.Z`, `mcp-vX.Y.Z`). A commit counts for a package when it touches files in
  that package's folder; the app (`.`) ignores commits that only touch `packages/`. The same release PR
  carries every component that has something to release.
- Merging the release PR runs the `publish-npm` job in `release-please.yml`. It runs `lint`,
  `typecheck` and `test` again (CI runs on the same push in parallel), then packs each released package
  with `pnpm pack` (which turns `workspace:*` into the real version) and runs `npm publish`, `client`
  first. A version that's already on npm is skipped, so re-running the job is safe.
- It authenticates with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC):
  there is no npm token in GitHub. npm checks that `repository.url` in the package's `package.json` is
  this repository, so keep it.
- The job runs in the `npm` GitHub environment. Add required reviewers there (Settings → Environments
  → npm) if a person should approve each publish.

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
majors come one by one) and one for GitHub Actions. Their titles are already Conventional Commits
(`chore(deps)`, `ci(deps)`).
