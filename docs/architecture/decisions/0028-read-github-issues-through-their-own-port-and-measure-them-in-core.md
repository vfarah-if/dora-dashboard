# 28. Read GitHub Issues through their own port and measure them in core

Date: 2026-10-07

## Status

Accepted

## Context

Repositories that track their work in GitHub Issues had no delivery view, although the Jira pages (ADR 0020, ADR 0021) show how work flows for teams that use Jira. The Jira machinery is shaped by Atlassian's model of sites, spaces, boards and per-login grants held in memory. A GitHub issue belongs to the repository itself, and the crawl already holds a GitHub token, so reading issues needs no new credential, consent step or linking screen.

## Decision

**A separate port.** `IssueProvider` (`apps/api/src/interfaces/issue-provider.ts`) has one adapter, `GitHubIssueProvider`, which reads GraphQL pages of 50 issues, most recently updated first, with the token the crawl holds. `WorkItemProvider` is not reused because every part of it assumes a site, a space and a user's grant. `SourceProvider` is not widened, as ADR 0017 widened it for open pull requests, because a code host that has pull requests may have no issue tracker, or a different one. A second port keeps ADR 0003's rule that a new system is a new adapter, and only the composition roots, `main.ts` and `cli.ts`, name the concrete adapter.

**Read during the repository crawl.** `CrawlService` calls `IssueCrawlService` after pull requests and deploy runs, and the read is incremental from a stored cursor (`crawl-cursor.ts`). The cursor moves only when a read completes, so a failed full read leaves the next crawl where the last complete read left it. Only a read that began at the start removes issues the host no longer holds, so an issue deleted or transferred on GitHub stays until a full re-crawl. A failed read is stored as the repository's issue error and the rest of the crawl finishes, except that a rejected credential (HTTP 401) fails the whole crawl. Issues are stored in SQLite (ADR 0005) as one JSON document per issue, with the label override, the cursor and the error held on the repository row. `docs/metrics.md` under "Reading issues" gives the full rules and the connection caps.

**Where the page appears.** The `/issues` page is always routed and shows an empty state when nothing qualifies. Its links appear when some repository has stored issues or an issue error, and the page lists those repositories with any error. Issues switched off on GitHub are not enough on their own, since a repository tracked in Jira usually has them off; that repository's own issue page says so. The report is built from stored data at request time, so it works whether or not a provider is wired.

**Close reasons.** A closed issue with no recorded reason counts as completed, because closing without a reason was the only way to finish an issue before reasons existed. Duplicate and not planned are counted together as not planned and are left out of every time and of the linked share. The adapter asks for `stateReason(enableDuplicate: true)` because GitHub otherwise reports a duplicate as not planned.

**Classification at report time.** Kind and priority are worked out when a report is built, never at crawl time, so changing a repository's label override changes the report without a crawl. Each is decided by source in order (native type, labels, title prefix), and the first source that names one decides it. A label override replaces a key's names, and a key left out, empty or blank keeps its defaults, so an override can never switch a kind or priority off. No pattern supplied by a user is ever run, so an override cannot cause a slow match. The classification and linking rules are in `docs/metrics.md` and are not repeated here.

**Linking pull requests.** A pull request belongs to an issue by a closing reference, by `#n` in its title, or by a number in its branch name. On a real repository, closing references alone linked 23 of the 83 most recent merged pull requests opened by people (28%), and adding titles and branches lifted that to 61 (73%), which is why the extra rules are worth their noise.

**What counts.** Epics are never counted in a flow, a time or an issue check, but a pull request linked only to an epic counts as linked to an issue. The figures are named "issue to first pull request" and "issue to production" so that they are distinct from DORA lead time, and issue to production applies the deploy branch and pairing rules of ADR 0007. The week the range ends in is kept and drawn lighter, as on the repository page, because open issues change by the day.

**People.** Issue authors are not read or stored. Assignee logins appear only behind the people toggle (`people=1`), in the ageing list and the hygiene lists, and every issue says whether anyone is assigned without naming them (ADR 0008).

**Label override.** `PUT /api/repos/:id/issue-labels` saves the override, or `null` for the defaults, and requires the same origin. It starts no crawl. `GET /api/issue-labels/defaults` gives the web the default names and the limits, so it imports core's types only.

## Consequences

### Positive

- A repository gets a delivery view with no new credential, no linking screen and no per-person grant.
- A failing issue read cannot stop the DORA crawl, and the cursor only moves when a read completes.
- Changing a label override takes effect at once, because classification happens when the report is built.
- The Jira and GitHub reports share their time helpers, so the two sets of figures mean the same thing by "to first pull request" and "to production".

### Negative

- Each issue is read with at most 10 assignees, 30 labels, 10 closing references and the last 20 closes or reopens, so an issue reopened many times can be slightly wrong for open at the end of a week.
- The `pr_without_issue` check is noisy where branches carry no numbers and nobody uses closing keywords, and the branch rule can link a pull request to an unrelated open issue whose number appears in the branch name.
- Sub-issues and GitHub Projects status are not used, so a story split into sub-issues is counted as separate issues.
- The first crawl after upgrading reads every issue of every repository once, which takes a few minutes on a large repository.
- A token needs read access to Issues, and without it the read fails and the repository shows an issue error.
- A deleted or transferred issue stays in the cache until a full re-crawl, and a change made on GitHub appears only after the next crawl.
