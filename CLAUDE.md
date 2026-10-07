# CLAUDE.md

Guidance for Claude Code in this repository. Keep this file short: detail belongs in a skill, a decision belongs in an ADR, and history belongs in git.

## What this is

A self-hosted dashboard that crawls a code host and charts how work flows through pull requests, plus the four DORA measures, for one repository or several side by side. Open source; used against private repositories.

## Layout

| Path                          | What                                                                   | Read first                        |
| ----------------------------- | ---------------------------------------------------------------------- | --------------------------------- |
| `packages/core`               | Domain types and every metric as a pure function. No I/O.              | `docs/metrics.md`, ADR 0006       |
| `apps/api`                    | Fastify. Crawls, caches in SQLite, serves reports. Clean architecture. | ADR 0003, `source-provider` skill |
| `apps/web`                    | React 19, Vite, Recharts. Imports core's types only.                   | `frontend-standards` skill        |
| `docs/architecture/decisions` | ADRs, numbered, never renumbered.                                      | `adr-format` skill                |

## Commands

`make help` lists everything. The ones you need:

```bash
make all                  # install, .env, build, every gate
make dev                  # API :8787 and web :5181
make test                 # all suites (turbo cached)
make test-coverage-force  # uncached; use before quoting a figure
make quality              # what CI runs: format, lint, private names, typecheck, coverage floors
make upgrade              # choose dependency updates under Dependabot's rules, then every gate (ADR 0024)
make crawl repo=owner/name workflow=deploy.yml branch=main
```

One test: `cd apps/api && npx vitest run test/routes.test.ts -t "compares"`.

## Rules

1. **Never publish a private name.** Real repository, company or client names go in `repos.local.json` or `.private-names`, both gitignored, never in code, tests, docs or commits. Fixtures use `acme/widgets`. `make check-names` enforces it (ADR 0009).
2. **Git is the human's.** Do not stage, commit or push unless asked in so many words. Conventional commits, lower-case subject.
3. **Layers only point down.** Routes call services, services call interfaces, infrastructure implements interfaces. Only the composition roots, `main.ts` and `cli.ts`, name a concrete adapter. A new code host or tracker is a new adapter behind a port, not an `if` in a service.
4. **Metrics live in core and are pure.** No `Date.now()` inside a metric; pass the range in. Every new metric gets a test with hand-computed expectations and a line in `docs/metrics.md`.
5. **Tests prove behaviour.** Use the fakes in `apps/api/test/fakes.ts`; no network in any test. Coverage floor: 90% lines, branches, functions and statements in every workspace (ADR 0018).
6. **UK English, no em or en dashes**, no consultancy speak. User-facing copy lives in `apps/web/src/copy.ts`.
7. **Record decisions.** A new dependency, a changed metric definition or a new external system means an ADR.
8. **A lower grade after an analyser change is not a reason to move the bands.** Compare two stored snapshots of the same commit with core's `codeHealth` first; a more complete measurement lowering a grade is expected (ADR 0026).

## Agents

| Agent                | Use for                                  |
| -------------------- | ---------------------------------------- |
| `api-developer`      | Routes, services, stores, the crawl      |
| `provider-developer` | A new code host or issue tracker adapter |
| `frontend-developer` | Pages, charts, components                |
| `test-writer`        | Missing or weak tests                    |
| `code-reviewer`      | Review after a change, before a commit   |
| `documentation`      | ADRs, README, metrics docs, this file    |

Typical order: plan, developer agent, `test-writer`, `code-reviewer`, `documentation`.
