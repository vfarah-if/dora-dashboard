# 12. Authors can be left out of a repository report

Date: 2026-09-29

## Status

Accepted

## Context

A repository's figures can be dominated by one account that is not a bot by GitHub's reckoning, such as a release script run under a person's login or a contractor whose work should be read separately. The only filter was a single author picker on the pull request table, which changed the table but left every tile and chart above it counting everyone, so the page disagreed with itself.

## Decision

`buildReport` takes `excludeAuthors`, a list of logins whose pull requests are removed before any figure is worked out, at the same point as bots. A pull request with no author is excluded as `unknown`, matching the authors table. The project start is taken before the exclusion, so leaving someone out never moves the default range or the week alignment. The report also returns `authorChoices`, everyone who opened a pull request in the range with a flag for whether they were excluded, so the menu can still offer the people it has hidden.

The API accepts `excludeAuthors=a,b` on `/api/repos/:id/report` only. The web app holds the list in the address as `exclude=a,b` and offers it as a menu of ticked authors with "All authors" and "No authors" shortcuts, replacing the table's single picker. The comparison page does not offer it, in keeping with ADR 0008.

Reviews given by an excluded author on other people's pull requests still count, because they are part of how the remaining pull requests were handled.

## Consequences

### Positive

- Every figure on the page, and the PDF export, describe the same set of pull requests. The export names who was left out.
- A filtered view is a link that can be shared.

### Negative

- Deployment frequency, change failure rate and time to restore come from workflow runs, so excluding an author changes lead time but not the other three DORA measures. The menu says so, but a reader skimming the tiles may expect all four to move.
- Logins appear in the address and in server request logs.
