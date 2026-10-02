# 4. Authenticate with GitHub OAuth or the local gh login, never a password

Date: 2026-09-29

## Status

Accepted

## Context

The original request was to enter a username and password and crawl a repository. GitHub removed password authentication from its API in November 2020, so that cannot work. The dashboard still needs a credential that can read private repositories, and it must not become a place credentials leak from.

## Decision

Two modes, chosen by `AUTH_MODE`:

- `oauth`: "Sign in with GitHub" through a registered OAuth App. The callback verifies a signed `state` cookie, exchanges the code server side, and keeps the token in process memory keyed by a random id in a signed, HTTP-only, `SameSite=Lax` cookie.
- `gh-cli` (the default): the API reads `gh auth token` from the local GitHub CLI. Nothing to register and nothing to type, which suits a developer running it on their own machine.

In both modes the token never reaches the browser and is never written to disk. The crawled data in SQLite contains no credential.

## Consequences

### Positive

- No password handling at all, and nothing a stolen database would reveal.
- `gh-cli` works the moment `gh auth login` has been run, so a demo is never blocked on an organisation owner registering an app.

### Negative

- An API restart signs every OAuth user out, because sessions live in memory. Acceptable for a self-hosted tool; a shared deployment would need a persistent `SessionStore`.
- An OAuth App registered in an organisation needs an owner's approval before members can grant it access to that organisation's private repositories.
- Crawled data is shared by everyone who can reach the server, whichever account crawled it. Access control on reports is out of scope.

## Revision History

- 2026-10-02. In `gh-cli` mode a missing CLI login now falls back to the GitHub device flow, using a published client ID and no secret. See ADR 0019.
