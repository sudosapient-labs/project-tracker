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

## Dependencies

Dependabot (`.github/dependabot.yml`) opens a weekly PR for npm (minor and patch updates grouped;
majors come one by one) and one for GitHub Actions. Their titles are already Conventional Commits
(`chore(deps)`, `ci(deps)`).
