# 5. SQLite through node:sqlite as the crawl cache

Date: 2026-09-29

## Status

Accepted

## Context

A large repository takes a minute or more to crawl, and GitHub rate-limits the API. Reports must be fast and must not re-crawl on every page load. The tool should run with nothing installed beyond Node.

## Decision

Crawled data is cached in SQLite through Node's built-in `node:sqlite` module, at `data/dora.sqlite` by default. A repository row holds its configuration and crawl state; pull requests and deploy runs are stored as one JSON document per row, keyed by repository and number or run id. Reports are computed on request from those rows by `packages/core`.

## Consequences

### Positive

- No native module to compile (the obvious alternative, `better-sqlite3`, needs a toolchain matching the Node version) and no database server.
- Storing whole documents means a new field on `PullRequest` needs no migration; a re-crawl fills it in.

### Negative

- Requires Node 22.13 or later.
- Reports load every row for a repository into memory. Thousands of pull requests are fine; hundreds of thousands would need filtering pushed into SQL.
- JSON documents cannot be indexed on a field, so any query other than "all rows for this repository" needs a schema change.
