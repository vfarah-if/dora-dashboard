# 28. Read GitHub Issues through their own port and measure them in core

Date: 2026-10-07

## Status

Accepted

## Context

Repositories that track their work in GitHub Issues had no delivery view, although the Jira pages (ADR 0020, ADR 0021) show how work flows for teams that use Jira. The Jira machinery is shaped by Atlassian's model of sites, spaces, boards and per-login OAuth grants held in memory. A GitHub issue belongs to the repository itself, and the crawl already holds a GitHub token with `repo` scope, so reading issues needs no new credential, consent step or linking screen.

## Decision

**A separate port.** `IssueProvider` (`apps/api/src/interfaces/issue-provider.ts`) has one adapter, `GitHubIssueProvider`, which reads GraphQL pages of 50 issues, most recently updated first, with the token the crawl holds. `WorkItemProvider` is not reused because every part of it assumes a site, a space and a user's grant, none of which exists here. `SourceProvider` is not widened, as ADR 0017 widened it for open pull requests, because that port describes pull requests and deploy runs, and a code host that has pull requests may have no issue tracker or a different one. A second port keeps ADR 0003's rule that a new system is a new adapter, and `main.ts` remains the only place that names it.

**Read during the repository crawl.** `CrawlService` calls `IssueCrawlService` after pull requests and deploy runs. The read is incremental from a stored cursor, which is the newest update time seen less a five minute overlap (`crawl-cursor.ts`) so that late-indexed and same-millisecond updates are read again. A full crawl clears the cursor, re-reads everything and then removes stored issues the host no longer holds. A repository with issues switched off has its stored issues cleared and the cursor reset. The read is isolated. A failure is stored as the repository's issue error and logged, the cursor stays where the last complete read left it, and the DORA crawl still finishes. Issues are stored in SQLite (ADR 0005) as one JSON document per issue, with the label override, the cursor and the error held on the repository row.

**Where the page appears.** The GitHub Issues page and its link appear only when some repository has stored issues. The report is built from stored data at request time, so it works whether or not a provider is wired.

**Close reasons.** A closed issue with no recorded reason counts as completed, because closing without a reason was the only way to finish an issue before reasons existed. Duplicate and not planned are counted together as not planned and are left out of every time and of the linked share. The adapter asks for `stateReason(enableDuplicate: true)` because GitHub otherwise reports a duplicate as not planned. A close event cannot say duplicate, so duplicates are told apart only on the issue's final reason.

**Classification at report time.** Kind and priority are worked out when a report is built, never at crawl time, so changing a repository's label override changes the report without a crawl. Evidence is read in order: the native issue type, then the labels, then the prefix of the title (each leading `[tag]`, then the text before the first colon). The first source that names a kind decides it, and within that source the precedence is epic, security, incident, bug, feature, maintenance. Priority is decided separately, in the same order of sources, and the most urgent of P0 to P4 wins. Anything nothing names is kind `other` with no priority. A repository's override replaces only the keys it names and every other key keeps its default. An empty list means the default, so an override can replace a key's names but cannot switch a key off. Names are compared whole and without case, after a leading `type:`, `kind/`, `priority:` or `prio:` style prefix is removed. No pattern supplied by a user is ever run, so an override cannot cause a slow match.

**Linking pull requests.** A pull request belongs to an issue when any of three things hold. The issue names it as a closing reference in the same repository, or the pull request title carries `#n`, or a segment of its branch name starts with the number (`526-tts-gating`, `issue-389-crash`). A number in a title or branch counts only when it is a stored issue of that repository opened at or before the pull request and not already closed when the pull request was opened, and a branch number followed at once by a hyphen or underscore and another digit, as in `release/2026-10-07`, is not read. Because issue and pull request numbers share one sequence on GitHub, those rules remove the numbers of pull requests and most dates and versions, though a number in a branch can still match an unrelated issue that happens to be open. Pull requests by bots are ignored. On a real repository, closing references alone linked 23 of the 83 most recent merged pull requests opened by people (28%), and adding titles and branches lifted that to 61 (73%), which is why the extra rules are worth their noise.

**What counts.** Epics are left out of every figure except the count of open epics, which is shown apart. Idea to first pull request and idea to production reuse the helpers shared with the Jira report in `delivery.ts` and the DORA pairing of ADR 0007, and carry names distinct from DORA lead time (ADR 0020, ADR 0021). Full definitions are in `docs/metrics.md` under "Delivery from GitHub Issues".

**The part week.** The week the range ends in is kept and drawn lighter, as on the repository page, rather than dropped as on the Jira page, because open issues change by the day and a reader looking at the current week wants to see it. Each weekly row says whether it is partial.

**People.** Assignee logins appear only in hygiene lists behind the people toggle (`people=1`), and every issue says whether anyone is assigned without naming them (ADR 0008). Issue authors are stored but never reported.

**Label override.** `PUT /api/repos/:id/issue-labels` saves the override, or `null` for the defaults. It requires the same origin and starts no crawl.

## Consequences

### Positive

- A repository gets a delivery view with no new credential, no linking screen and no per-person grant.
- A failing issue read cannot stop the DORA crawl, and the cursor only moves when a read completes.
- Changing a label override takes effect at once, because classification happens when the report is built.
- The Jira and GitHub reports share their time helpers, so the two sets of figures mean the same thing by "to first pull request" and "to production".

### Negative

- At most 30 labels, 10 assignees, 10 closing references and the last 20 closes or reopens are read for each issue. When the host held more closes or reopens than were read, the open spans fall back to the creation and close dates, so open at the end of a week can be slightly wrong for an issue that was reopened many times.
- The `pr_without_issue` check is noisy where branches carry no numbers and nobody uses closing keywords, so it is listed last among the checks.
- The branch rule can link a pull request to an unrelated issue when that issue's number happens to appear in the branch name.
- Sub-issues and GitHub Projects status are not used, so a story split into sub-issues is counted as separate issues and a project board's columns are not reflected.
- The first crawl after upgrading reads every issue of every repository once, which takes a few minutes on a large repository.
- A fine-grained token needs read access to Issues, and without it the read fails and the repository shows an issue error.
- Issues are held in two places, as GitHub's own and as this cache, so a change made on GitHub appears only after the next crawl.
