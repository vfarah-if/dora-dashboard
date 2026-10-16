# 17. Read open pull requests live for the review queue

Date: 2026-09-30

## Status

Accepted

## Context

The review queue answers who has to act next on each open pull request and how long it has waited. The crawl can be hours old, and a review requested or an approval given a few minutes ago changes the answer, so a figure read from the crawl would send people to the wrong pull requests. The page also has to group related pull requests, which needs the description text, and it has to stay fair to the people named on it (ADR 0008).

## Decision

**Live read.** `SourceProvider` gains `fetchOpenPullRequests(token, owner, name)`, implemented for GitHub in `github-provider.ts`. `ReviewQueueService` calls it per repository and keeps each result in memory. A read under 60 seconds old is served as it is, and one up to 10 minutes old is served while it is read again in the background (see the 2026-10-16 revision). The request `GET /api/review-queue?refresh=1` bypasses that cache, except for a read under 5 seconds old, so a held-down Refresh cannot hammer the host. Requests that arrive while a read for the same repository is under way share it. Nothing is written to SQLite.

**Cache key.** The cache is keyed on a SHA-256 hash of the token and the repository id. A person who cannot see a repository therefore never receives what someone else's token read from it, and no raw token is held as a key (ADR 0004). Reads 10 minutes old or more are dropped as each new read completes.

**Partial reads.** The GitHub adapter reads at most 10 pages of 50 open pull requests, most recently updated first. When there are more, the port reports `truncated`, and the response carries a warning for that repository ("Showing the 500 most recently updated open pull requests") in `warnings`, separate from `errors`, which are repositories that could not be read at all.

**Bots.** Reviews by bot accounts are ignored for lanes and for the wait.

**Lanes.** Each open pull request sits in the first lane that matches: held (a draft, or labelled `on hold`), with author (failing checks, a standing request for changes, or comments with nobody asked to look again and no approval), approved, awaiting review (someone is asked), otherwise no reviewer. A reviewer asked to look again, or whose review was dismissed, no longer counts for what they said before. Only awaiting review and no reviewer count as waiting.

**Wait bands.** The wait runs from the later of publication and the last review by someone other than the author, to now. Fresh is under 4 hours, ageing is 4 up to and including 24, overdue is over 24, and stale is 120 or more, which is five weekdays. Only hours falling Monday to Friday in UTC count.

**Features.** Open pull requests are grouped when they share a ticket key in the title, branch or linked issues, name each other on a `Related:` line, share a head branch that is not a common trunk name, or form a stack with one based on another's branch. Groups are built by union of these links, and only groups of two or more are shown.

**Privacy.** Pull request bodies are read only to find `Related:` lines. They are not part of the queue entry and never leave the server. Author logins, requested reviewer names and head branch names (which often carry a login) are removed by the server unless the request has `names=1`, so they are not in the response at all by default, as ADR 0008 requires for people figures. Each entry always carries `requestedReviewerCount`, so the page can still say how many reviewers were asked.

The definitions are in `packages/core/src/reviewQueue.ts` and `features.ts`, and are described for readers in `docs/metrics.md`.

## Consequences

### Positive

- The queue reflects the host as it is now, to within a minute while the page is open, however old the last crawl is, and the page is never kept waiting for every repository to be read again.
- The rules are pure functions in core with the current time passed in, so they are tested with hand-computed cases.
- Counting weekdays only means a pull request published on Friday evening is not flagged as overdue on Monday morning.
- Descriptions cannot leak, because the response type has no field for them.

### Negative

- Every refresh spends GitHub API quota, per repository and per page of pull requests, so a long repository list opened by many people, or refreshed often, can approach the rate limit. A repository that fails is reported in the page's errors and does not fail the others.
- A token that loses access can still be served what it read earlier for up to ten minutes, unless a background read notices first (see the 2026-10-16 revision).
- The cache lives in one process and is empty after a restart. It is per token, so two people with different tokens each spend API quota for the same repository, and a repository a person cannot see is reported to them as an error even if a colleague could see it.
- Weekdays are taken in UTC, not in the team's local time, so the weekend boundary is off by the team's offset and a team far from UTC will see slightly different waits from its own clocks.
- Public holidays and team leave are not excluded, so a pull request can reach overdue or stale over a holiday.
- Feature grouping is heuristic. A shared ticket key or branch name can join pull requests that are unrelated, and work with no key, link or shared branch is not grouped, so the page presents groups as a prompt to look and not as fact.

## Revision History

- 2026-10-07: Linked issues are now qualified by repository and are used for grouping. The pull request query asks GitHub for each closing issue's own repository and records it as `owner/name#12`, falling back to the pull request's own repository when GitHub gives none. Core keeps these qualified references as ticket keys, so two pull requests that close the same issue group together, and two repositories' issue 12 stay apart because grouping spans every repository in the queue. Previously the references were recorded as `#12` and dropped silently, because only Jira style keys were matched. An unqualified `#12` is still ignored.
- 2026-10-16: The cache now serves a read while it is read again (stale-while-revalidate), and the time a token may be served what it read earlier rises from one minute to ten. A web page that polls every 60 seconds found every read just expired and waited for all of them each time, so the page was slow in proportion to the number of repositories.
  - **Windows.** `REVIEW_QUEUE_TTL_MS` is 60 seconds and `REVIEW_QUEUE_STALE_MS` is 10 minutes. Under 60 seconds a read is served as it is. From 60 seconds up to 10 minutes it is served at once and one background read starts for that key. At 10 minutes, or with no entry, the request waits, and concurrent requests share the read in flight. `refresh` is never served stale: past the 5 second floor it always waits for a new read.
  - **Stamp and bound.** A read is stamped when it completes, not when it starts. `prune()` runs as each read completes and drops entries 10 minutes old or more, so memory is bounded by one entry per token and repository read in the last ten minutes. The cache is still in memory only and keyed on a SHA-256 hash of the token and repository id.
  - **Limiter.** Every provider read, awaited or background, goes through one limiter per token (keyed on a SHA-256 hash of the token) that allows at most 4 in flight, first in first out. This replaces the earlier rule of four at a time within one request, which a background read could bypass. The limiter's state for a token is deleted when it has nothing running or waiting, and different tokens do not share a cap. `readAll` starts every load and relies on the limiter.
  - **Lost access.** When a background read fails because access has gone (an unauthorised, not found, forbidden or access refused error, or an upstream 403 that is not a rate limit), the stale entry is dropped and a warning is logged, so the next request waits and surfaces the real result.
  - **Other failures.** Any other background failure is logged at warn through the `Logger` port, with the repository name and the message and never the token. It is remembered on the entry, and while that entry is served the response carries a warning for the repository ("Showing pull requests read earlier, because the latest read failed: ..."), cleared by the next successful read. The warning carries the error message only for the app's own errors, whose text is already sanitised (GitHub's free text is reduced to known phrases by the adapter), and a fixed sentence ("The repository could not be read") otherwise, with the raw error logged separately. A rate limit is recognised by a typed marker on the upstream error (`rateLimited`), not by its wording.
  - **Honest time.** The response's top-level `fetchedAt` is the oldest repository read (`packages/core/src/reviewQueue.ts`), so the page's "updated" time stays truthful when stale reads are served.
  - **Negative accepted.** A token that loses access without a background read noticing can be served what it read for up to ten minutes, where it was one minute before. The response still contains only what that token itself read, and people's names remain off unless asked for (ADR 0008).
- 2026-10-16: A refresh can name the repositories to read again. `GET /api/review-queue?refreshIds=1,2` reads those past the cache, under the same 5 second floor, and serves every other repository as an ordinary request would, fresh, stale while read again, or awaited. `refresh=1` still reads every repository and wins when both are sent; `refreshIds` takes at most 50 ids, as `ids` does, and an id that is not being read is ignored. The page's Refresh sends the ticked repositories, or `refresh=1` when none is ticked, so the wait for a refresh grows with the repositories being looked at and not with every repository added. Each repository's summary now carries its own `fetchedAt`, and the page's "Updated" time is the oldest read among the ticked repositories, so a refresh of those is not reported as older than it is. While a refresh or a change of names loads, the page keeps the figures on screen, dimmed and marked busy, with a spinner on the button; the minute's poll does not dim them.
