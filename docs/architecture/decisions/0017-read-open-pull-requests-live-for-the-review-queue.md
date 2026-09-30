# 17. Read open pull requests live for the review queue

Date: 2026-09-30

## Status

Accepted

## Context

The review queue answers who has to act next on each open pull request and how long it has waited. The crawl can be hours old, and a review requested or an approval given a few minutes ago changes the answer, so a figure read from the crawl would send people to the wrong pull requests. The page also has to group related pull requests, which needs the description text, and it has to stay fair to the people named on it (ADR 0008).

## Decision

**Live read.** `SourceProvider` gains `fetchOpenPullRequests(token, owner, name)`, implemented for GitHub in `github-provider.ts`. `ReviewQueueService` calls it per repository, at most four at a time, and keeps each result in memory for 60 seconds. The request `GET /api/review-queue?refresh=1` bypasses that cache, except for a read under 5 seconds old, so a held-down Refresh cannot hammer the host. Requests that arrive while a read for the same repository is under way share it. Nothing is written to SQLite.

**Cache key.** The cache is keyed on a SHA-256 hash of the token and the repository id. A person who cannot see a repository therefore never receives what someone else's token read from it, and no raw token is held as a key (ADR 0004). Reads past their 60 seconds are dropped as new ones arrive.

**Partial reads.** The GitHub adapter reads at most 10 pages of 50 open pull requests, most recently updated first. When there are more, the port reports `truncated`, and the response carries a warning for that repository ("Showing the 500 most recently updated open pull requests") in `warnings`, separate from `errors`, which are repositories that could not be read at all.

**Bots.** Reviews by bot accounts are ignored for lanes and for the wait.

**Lanes.** Each open pull request sits in the first lane that matches: held (a draft, or labelled `on hold`), with author (failing checks, a standing request for changes, or comments with nobody asked to look again and no approval), approved, awaiting review (someone is asked), otherwise no reviewer. A reviewer asked to look again, or whose review was dismissed, no longer counts for what they said before. Only awaiting review and no reviewer count as waiting.

**Wait bands.** The wait runs from the later of publication and the last review by someone other than the author, to now. Fresh is under 4 hours, ageing is 4 up to and including 24, overdue is over 24, and stale is 120 or more, which is five weekdays. Only hours falling Monday to Friday in UTC count.

**Features.** Open pull requests are grouped when they share a ticket key in the title, branch or linked issues, name each other on a `Related:` line, share a head branch that is not a common trunk name, or form a stack with one based on another's branch. Groups are built by union of these links, and only groups of two or more are shown.

**Privacy.** Pull request bodies are read only to find `Related:` lines. They are not part of the queue entry and never leave the server. Author logins, requested reviewer names and head branch names (which often carry a login) are removed by the server unless the request has `names=1`, so they are not in the response at all by default, as ADR 0008 requires for people figures. Each entry always carries `requestedReviewerCount`, so the page can still say how many reviewers were asked.

The definitions are in `packages/core/src/reviewQueue.ts` and `features.ts`, and are described for readers in `docs/metrics.md`.

## Consequences

### Positive

- The queue reflects the host as it is now, to within a minute, however old the last crawl is.
- The rules are pure functions in core with the current time passed in, so they are tested with hand-computed cases.
- Counting weekdays only means a pull request published on Friday evening is not flagged as overdue on Monday morning.
- Descriptions cannot leak, because the response type has no field for them.

### Negative

- Every refresh spends GitHub API quota, per repository and per page of pull requests, so a long repository list opened by many people, or refreshed often, can approach the rate limit. A repository that fails is reported in the page's errors and does not fail the others.
- The cache lives in one process and is empty after a restart. It is per token, so two people with different tokens each spend API quota for the same repository, and a repository a person cannot see is reported to them as an error even if a colleague could see it.
- Weekdays are taken in UTC, not in the team's local time, so the weekend boundary is off by the team's offset and a team far from UTC will see slightly different waits from its own clocks.
- Public holidays and team leave are not excluded, so a pull request can reach overdue or stale over a holiday.
- Feature grouping is heuristic. A shared ticket key or branch name can join pull requests that are unrelated, and work with no key, link or shared branch is not grouped, so the page presents groups as a prompt to look and not as fact.
