# CI and releases

## Branches

`prod` is the default branch and the only long-lived one. Work happens on short-lived branches and
lands through a pull request, squash-merged so the PR title becomes the commit on `prod`.

Branch protection is by convention for now (it needs a paid plan to enforce): don't push to `prod`
directly, and wait for the `ci-ok` check before merging.

### Renaming `main` to `prod` (once, by an admin)

The repository was created with `main`; the workflows, docs and release config already assume `prod`.
Do these in order, ideally in one sitting:

1. **Rename the branch:** Settings → Branches → the pencil next to `main` → `prod`. (Or
   `gh api -X POST repos/sudosapient-labs/project-tracker/branches/main/rename -f new_name=prod`.)
   GitHub retargets open PRs and redirects old `main` URLs; forks and local clones need
   `git branch -m main prod && git fetch origin && git branch -u origin/prod prod`.
2. **Point Railway at `prod`:** service → Settings → Source → branch. Railway keeps tracking `main`
   until you change it, so skip this and deploys stop.
3. **Confirm CI runs:** push or merge anything to `prod` and check that the `CI` and `Release`
   workflows start.

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

Releasing doesn't deploy: Railway deploys whatever is on `prod`.

### Setup the release workflow needs

- Settings → Actions → General → Workflow permissions → tick **Allow GitHub Actions to create and
  approve pull requests**, or the release PR can't be opened.
- PRs opened with the default `GITHUB_TOKEN` don't start other workflows, so CI won't run on the
  release PR. If you want it to, add a `RELEASE_PLEASE_TOKEN` secret (a PAT or app token with
  contents and pull-requests write); the workflow uses it when present.

## Dependencies

Dependabot (`.github/dependabot.yml`) opens a weekly PR for npm (minor and patch updates grouped;
majors come one by one) and one for GitHub Actions. Their titles are already Conventional Commits
(`chore(deps)`, `ci(deps)`).
