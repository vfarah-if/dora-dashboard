# 3. Clean architecture with a port per external system

Date: 2026-09-29

## Status

Accepted

## Context

GitHub is the first code host, but the obvious next requests are GitLab, Bitbucket, a client's self-hosted instance and an issue tracker such as Jira. If the crawl code called GitHub directly, each of those would mean rewriting the services and their tests.

## Decision

`apps/api/src` is layered, and a layer only imports the layer beneath it:

| Layer          | Folder                | Holds                                                                  |
| -------------- | --------------------- | ---------------------------------------------------------------------- |
| Routes         | `routes/`, `schemas/` | HTTP, request validation, error-to-status mapping                      |
| Services       | `services/`           | Use cases: add a repository, crawl it, report on it                    |
| Interfaces     | `interfaces/`         | Ports: `SourceProvider`, `RepoStore`, `SessionStore`, `CliTokenSource` |
| Infrastructure | `infrastructure/`     | Adapters: GitHub, SQLite, the gh CLI, in-memory sessions               |

`main.ts` is the composition root and the only file that names a concrete adapter. `app.ts` builds the server from whatever adapters it is handed, which is how every route test runs against a fake code host and an in-memory database. Services raise typed errors from `core/errors.ts`; `routes/errors.ts` is the one place those become HTTP statuses.

Each port documents the contract an adapter must honour. `SourceProvider` requires pages ordered by `updatedAt` descending, because the incremental crawl stops at the first page with nothing new.

## Consequences

### Positive

- A new code host is one adapter and one test file; services and routes do not change.
- Route and service tests need no network and no mocking library, only the fakes in `apps/api/test/fakes.ts`.

### Negative

- More files than a single-module server, and a small amount of ceremony for a feature that touches every layer.
- The port is shaped by GitHub. A host that cannot sort by update time, or has no notion of a workflow run, will need the contract widened rather than merely implemented.
