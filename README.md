# DORA Dashboard

Point it at a repository and see how work actually flows through pull requests: how quickly work becomes a PR, how long it waits for review, how long it takes to merge, who is doing it, and the four DORA measures. Compare several repositories side by side, aligned to their start and normalised per contributor.

Self-hosted, and your credentials never leave the machine it runs on.

## Why it measures what it measures

The dashboard rests on a small number of principles, which the home page of the web app explains in full with diagrams.

- **Speed and stability move together.** The DORA research programme, described in the book _Accelerate_ and the yearly State of DevOps reports, has found that teams who deploy more often also tend to fail less and recover sooner. Its four keys come in two pairs. Deployment frequency and lead time for changes describe throughput, while change failure rate and time to restore describe stability, and they are most useful read together.
- **Cheap throughput needs a second look.** AI assistance makes deploying often and merging quickly easier without saying whether the work was worth doing, so read throughput beside stability and not on its own. The rework tile shows how many deploys shipped a revert or hotfix, the AI cohort table compares assisted and unassisted pull requests, and ADR 0016 explains how each is worked out and where it falls short.
- **Batch size is the lever.** Small pull requests are reviewed sooner, merged sooner and are easier to undo, which improves all four keys at once. Lead time is mostly waiting rather than working, so the dashboard splits it into coding, waiting for review, in review, to merge and to deploy to show where the queue is.
- **Simple code keeps it that way.** Delivery can only stay fast while the code it flows through stays easy to change. Kent Beck's [four rules of simple design](https://martinfowler.com/bliki/BeckDesignRules.html), in priority order, are that the code passes the tests, reveals intention, has no duplication and has the fewest elements. The code health grade measures what can be read from the files, namely tests and CI for the first rule, and complexity, long functions and long parameter lists for the second and fourth. Duplication is not measured and is best caught in review.
- **Code quality shows up in the four keys.** Complex, untested code leads to larger and riskier changes, slower reviews and more failed deploys, which in turn create pressure to cut corners. Simple, tested code runs the same circle the other way.
- **Measure the system, not the person.** Figures describe a team's way of working. Per-person views are off by default (ADR 0008), trends matter more than targets, and repositories should be compared only with the fairness options switched on.

## Quick start

Requires Node 22.13 or later and, for the default sign-in, the [GitHub CLI](https://cli.github.com) signed in with `gh auth login`.

```bash
make all                                  # install, create .env, build, run every gate
cp repos.local.example.json repos.local.json   # list the repositories you want
make crawl-all                            # crawl them into data/dora.sqlite
make dev                                  # API on :8787, open http://localhost:5181
```

Or add repositories from the web app by pasting `owner/name` or a GitHub URL.

### Code health (optional)

Each crawl also clones the deploy branch, measures the complexity of every function and discards the clone (ADR 0011). The clone is made with `git`, so `git` must be on the machine that runs the API for code health in every language. JavaScript and TypeScript are then measured in process from a syntax tree (ADR 0025) and need nothing more. Every other language needs [lizard](https://github.com/terryyin/lizard), and a repository that holds only JavaScript and TypeScript does not need it at all.

To measure other languages, install lizard with whichever of these suits the machine that runs the API:

```bash
# Any platform, with uv or pipx
uv tool install lizard
pipx install lizard

# macOS, with Homebrew
brew install pipx && pipx ensurepath && pipx install lizard
```

```powershell
# Windows, with winget
winget install --id astral-sh.uv -e
uv tool install lizard

# Windows, with Python already installed
py -m pip install --user pipx
py -m pipx ensurepath
py -m pipx install lizard
```

Open a new terminal and check that `lizard --version` works. If the API was already running, restart it so it can find lizard on its PATH, then crawl again, and the files that were left out are measured. The repository page shows the same commands, with a count of the files left unmeasured, when the API cannot find lizard.

Without lizard the JavaScript and TypeScript are still measured and the page shows a notice counting the files in other languages that were not. A lizard that is found but does not run, or that times out, fails the analysis. If an analysis fails, the crawl still completes and the repository page explains why code health is unavailable, keeping the last good figures when there are any. A crawl skips the clone when the branch has not moved, and a full crawl always analyses again. Set `CODE_ANALYSIS=off` in `.env` to skip the clone altogether. The result is served at `GET /api/repos/:id/code-health`.

The first analysis after upgrading to syntax tree measurement can lower a JavaScript or TypeScript repository's grade with no change to its code. Lizard used to drop or cut short functions it could not follow, often the largest components, so their lines and branches were never counted. On one private repository this hid 44% of the code inside functions and turned a high maintainability band into a medium one. The bands are unchanged and the lower grade is the accurate one (ADR 0026).

## Signing in

GitHub no longer accepts passwords over its API, so there is no username and password box. Choose one of two modes in `.env`:

- `AUTH_MODE=gh-cli` (default) reuses your local `gh` login. Nothing to register.
- `AUTH_MODE=oauth` shows "Sign in with GitHub". Register an OAuth App with the callback `http://localhost:5181/api/auth/github/callback`, then set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and a long random `SESSION_SECRET`.

Tokens are held in memory only and never sent to the browser (ADR 0004).

[SETUP.md](SETUP.md) walks through setup step by step, including the browser sign-in offered when the GitHub CLI is not signed in and how to test it locally.

## Jira (optional)

Jira Cloud can be connected through OAuth 2.0 (3LO) so that issues can be read beside pull requests. It is off until `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET` are set together, and setting only one stops the API at start-up. `ATLASSIAN_REDIRECT_URI` is optional and defaults to `WEB_ORIGIN` followed by `/api/auth/jira/callback`. Grants are held in memory only and dropped after 8 hours without use (ADR 0020). [SETUP.md](SETUP.md) walks through registering the Atlassian app, connecting it, and what each `jira=` outcome or crawl message means.

## What it measures

See [docs/metrics.md](docs/metrics.md) for every definition. In short: coding time, time to first review, open to merge (reviewed and unreviewed apart), cycle time by stage, throughput per author-week, and DORA deployment frequency, lead time, change failure rate and time to restore, each with its band. Each DORA tile can be opened to explain its band, the gap to the next, its drivers and the practices that address it (ADR 0022). Each linked Jira space gets a delivery page under `/spaces` with issue cycle and lead time, throughput, work in progress, time per column, flow efficiency, idea to production and board hygiene (ADR 0021). Each repository page also shows code health, with cyclomatic complexity per function, its distribution and the most complex functions with advice on where to start simplifying (ADR 0015), and an overall grade for maintainability, testing and hygiene worked out from the repository's files and pull requests without running any of its code (ADR 0013). Run a full crawl once after upgrading so that pull request file lists and branch names are fetched.

The **Review queue** page (`/review-queue`) shows open pull requests across your repositories as they are now, read live from GitHub and cached for about a minute, with a refresh button to read again. It sorts each one into a lane by who has to act next, bands the review wait in weekday hours (UTC), lists what needs attention first and groups pull requests that belong to one piece of work. Names are hidden until you turn them on, and pull request descriptions never leave the server (ADR 0017).

DORA figures need a deploy workflow. The API guesses one from workflow file names; set it explicitly per repository if the guess is wrong.

## Layout

```
packages/core   domain types and pure metric functions
apps/api        Fastify API: crawl, SQLite cache, reports (clean architecture)
apps/web        React dashboard
docs/           metrics reference and architecture decision records
.claude/        agents and skills for working on this repository with Claude Code
```

`make help` lists every command.

## Contributing

- `make quality` must pass: formatting, the private-name guard, typecheck and coverage floors.
- Take dependency updates with `make upgrade`, which offers them under the same cooldown and rules as Dependabot and runs every gate before you commit (ADR 0024). `make upgrade-check` lists what is available without changing anything.
- New external systems (GitLab, Jira and so on) go behind a port; see `.claude/skills/source-provider/SKILL.md`.
- Significant decisions get an ADR in `docs/architecture/decisions/`.
- Never commit a real company, client or private repository name. List names you must protect in `.private-names` (gitignored) and `make check-names` will catch them.

## Licence

MIT
