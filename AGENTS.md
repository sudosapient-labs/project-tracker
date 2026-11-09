# Working on Sudo Sapient

How the code fits together is in [docs/architecture.md](docs/architecture.md); branches, CI and
releases in [docs/ci-and-releases.md](docs/ci-and-releases.md). Work branches come from `dev`.

## One feature, every surface

The same data is read and written in several places. A change to what a field can hold (a new
shape, a new value, a new meaning) isn't done until each of them handles it:

| Surface       | Where                                                        |
| ------------- | ------------------------------------------------------------ |
| Web app       | `src/`                                                       |
| Sync API      | `server/sync/` (`schemas.js`, `rules.js`)                    |
| REST API      | `server/api/` (`schemas.js` also generates the OpenAPI docs) |
| Server jobs   | `server/jobs.js`, `server/notify.js`                         |
| Stored data   | a migration in `server/migrations/` for values already saved |
| CLI           | `packages/cli`                                               |
| MCP server    | `packages/mcp` (also hosted at `/api/mcp`)                   |
| Slack bot     | `packages/slack-bot` (its tools, cards and prompt)           |
| Shared client | `packages/client`                                            |
| Docs          | `docs/`, each package's `README.md`                          |

Before changing a field, search the whole repo for it (`git grep -n "\.due\b"` and the like), and
go through every hit. Add or change a field in one surface only when the others are covered in the
same pull request or one stacked on it; say in the PR description which surfaces you checked and
what each one needed.

## One definition for each kind of value

- Rules about a kind of value (how it's checked, read, compared, shown, typed in) live in one
  module that everything imports. Don't write a second version in another package, even a small one.
  Shared by the app and server: `src/core/`. Needed by the CLI, MCP or Slack bot too:
  `packages/client` (the server and app import it from there as well).
- What a client tells a person or a model about a field (MCP tool schemas, Slack bot tools, CLI
  `--help`) must match what the API accepts. When the API's schema changes, change these with it.
- When you find a second copy of a rule, fold it into the shared one instead of fixing it twice.

## Dates and times

Starts and dues are `'YYYY-MM-DD'` (all day) or a UTC instant (`'2026-11-09T18:29:00.000Z'`), and
everything about them is in `packages/client/dates.js` (see
[docs/architecture.md](docs/architecture.md#dates-and-times)).

- Read a value's day or time only with `dayOf` / `timeOf` / `label` and the reader's time zone. Never
  `value.slice(0, 10)`: a time after midnight in India is the previous day in UTC.
- Compare and sort with `instant` / `compareDue`, never as strings.
- Turn what people or models type into a value with `parseWhen` / `fromWallClock`. Models and people
  give wall-clock times ("Friday 5pm"); code adds the time zone, not the model.
- On the server, a person's time zone and time format come from `server/lib/clock.js`.

## Tests

- A change in behaviour gets a test through the surface people use (an API call, a sync batch, a
  CLI command, an MCP tool call, a bot tool), not only a unit test of the helper.
- Include the case the change is about. For time zones, a time between midnight and 05:30 in
  `Asia/Kolkata` (the previous day in UTC).
- Before you push: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
