# 9. Private names never enter the repository

Date: 2026-09-29

## Status

Accepted

## Context

The dashboard is published as open source, yet it is used against private repositories belonging to employers and clients. Their names end up in configuration, test fixtures and screenshots unless something stops them.

## Decision

- Repositories to crawl live in `repos.local.json`, which is gitignored; `repos.local.example.json` shows the shape with placeholders.
- Tests and fixtures use invented names such as `acme/widgets`.
- `scripts/check-private-names.mjs` fails `make quality` when a name listed in the gitignored `.private-names` file appears in any tracked or staged file. It prints file and line, never the matched name, so its own output cannot publish the name in a CI log. `--self-test` proves the matcher still bites.
- The crawled cache (`data/`) and screenshots are gitignored.

## Consequences

### Positive

- A contributor can use the tool against private work without a separate fork.

### Negative

- The guard only knows the names someone listed. A name nobody thought to add is not caught.
