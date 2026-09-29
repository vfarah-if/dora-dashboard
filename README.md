# DORA Dashboard

Point it at a repository and see how work actually flows through pull requests: how quickly work becomes a PR, how long it waits for review, how long it takes to merge, who is doing it, and the four DORA measures. Compare several repositories side by side, aligned to their start and normalised per contributor.

Self-hosted, and your credentials never leave the machine it runs on.

## Quick start

Requires Node 22.13 or later and, for the default sign-in, the [GitHub CLI](https://cli.github.com) signed in with `gh auth login`.

```bash
make all                                  # install, create .env, build, run every gate
cp repos.local.example.json repos.local.json   # list the repositories you want
make crawl-all                            # crawl them into data/dora.sqlite
make dev                                  # API on :8787, open http://localhost:5181
```

Or add repositories from the web app by pasting `owner/name` or a GitHub URL.

## Signing in

GitHub no longer accepts passwords over its API, so there is no username and password box. Choose one of two modes in `.env`:

- `AUTH_MODE=gh-cli` (default) reuses your local `gh` login. Nothing to register.
- `AUTH_MODE=oauth` shows "Sign in with GitHub". Register an OAuth App with the callback `http://localhost:5181/api/auth/github/callback`, then set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and a long random `SESSION_SECRET`.

Tokens are held in memory only and never sent to the browser (ADR 0004).

## What it measures

See [docs/metrics.md](docs/metrics.md) for every definition. In short: coding time, time to first review, open to merge (reviewed and unreviewed apart), cycle time by stage, throughput per author-week, and DORA deployment frequency, lead time, change failure rate and time to restore, each with its band.

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
- New external systems (GitLab, Jira and so on) go behind a port; see `.claude/skills/source-provider/SKILL.md`.
- Significant decisions get an ADR in `docs/architecture/decisions/`.
- Never commit a real company, client or private repository name. List names you must protect in `.private-names` (gitignored) and `make check-names` will catch them.

## Licence

MIT
