# 21. Delivery measures from Jira

Date: 2026-10-06

## Status

Accepted

## Context

ADR 0020 connected Jira, crawled each linked space with its full status history and joined issues to pull requests, but left the measures for later. Developers need to see how work flows through a space and whether the board tells the truth about it, for example whether cards are moved when work starts, whether work is closed in bulk at the end of a sprint, and whether pull requests carry the issue key that joins them to Jira. These figures must carry names that cannot be confused with DORA lead time, which is measured from commits and deploys (ADR 0006, ADR 0007).

## Decision

Every measure is a pure function in `packages/core/src/spaceReport.ts` (`buildSpaceReport`), is given `now` rather than reading a clock, and is shown on a page per space at `/spaces/:id`. The definitions are in `docs/metrics.md` under "Delivery from Jira". The rules are as follows.

**Range.** The report states its range as `YYYY-MM-DD` dates. It runs from the first millisecond of the from date to the last millisecond of the to date (23:59:59.999 UTC), so nothing recorded in the final second is lost, and the end is capped at now.

**What counts.** Delivery items are issues at Jira hierarchy level 0. Sub-tasks (level -1) and epics (level 1 and above) are not counted, although a sub-task's key links its pull requests to its parent, and open epics are shown as a separate total. Items crawled before the level was recorded fall back to the type name, where "Sub-task", "Subtask" and "Epic" are excluded.

**Started and done.** Started is the first transition into an in-progress category. Done is the last transition into done, for an item whose current category is done. An item that is done now but has no move into done in its history is not counted as done, and `resolvedAt` is not used. An item with no history is treated as being in its current category from creation.

**Cycle and lead time.** Issue cycle time runs from started to done and issue lead time from created to done, both in calendar hours, over delivery items done in the range. Issue lead time is clamped at zero through the same helper as the pull request measures, because an issue created after its move into done, as a migrated issue can be, waited no time.

**Work in progress.** It is counted at the last millisecond of each week, or at the end of the range when that is earlier. A week that runs past the end of the range is flagged as partial, and the web hides partial weeks from charts.

**Time per column.** An item visits a column only if it spent time there. Time is measured from started to done, so the column means add up to the mean issue cycle time. A transition's status is matched to the space's statuses by exact name first and then ignoring case, and is shown under the space's spelling. Time in a status that maps to no board column is reported as "Not on the board". When a space has no board, its statuses serve as the columns in the space's order, with unknown statuses last in alphabetical order.

**Flow efficiency.** Waiting time is time in an in-progress status whose name matches block, hold, wait, ready or queue, together with any time back in to do or done between start and done. All other in-progress time is active. Efficiency is active time over time from started to done.

**Linking pull requests.** Every pull request in a linked repository is considered, including those from bots and those not merged. Only the "pull request without a key" check leaves bots out. That check accepts a key from any project, not only this space's, so a pull request naming another project's issue is not listed. A sub-task key links to its parent. Each repository is paired with its own deploy branch and the window of ADR 0007, through `shippedPrs` in `dora.ts`, which is now exported with its behaviour unchanged.

**Idea to production.** Issue to first pull request and issue to production are clamped at zero, because a ticket raised after the work started waited no time. Issue to production counts an item only when every merged pull request linked to it has shipped, so an item whose merged pull request went to a branch with no deploy never gets an issue to production time.

**Hygiene.** Seven checks list the items or pull requests they found.

- A bulk move is 5 or more distinct delivery items moved to done within 10 minutes of the first move of a batch, where exactly 10 minutes is inside the batch. The same item moved twice counts once. A batch may start at any move, so when the window after one move holds too few items the next move is tried, and once a batch is found the search resumes after it.
- A reopened item has a transition whose from category is done and whose to category is anything not done, including a status whose category is unknown.
- Stale work, unassigned work and ageing are measured as of now, not at the end of the range.

**People.** Assignee display names are stored per space (account id to name) and are returned only when the report is requested with `people=1`. `GET /api/repos/:id/spaces` strips them. Names appear only in hygiene lists behind the Show people toggle, never on a chart or a tile. Email addresses are never read (ADR 0008). An incremental crawl adds names it has not seen and updates any that changed, and a full crawl replaces the stored names with those it read. Stored names that cannot be read back are treated as absent rather than failing the report.

### Alternatives considered

- **Counting sub-tasks.** A story split into six sub-tasks would then count as seven items, and teams that split work more finely would look more productive. Rolling their pull requests up to the parent keeps one unit of delivery.
- **`resolvedAt` as done.** Resolution can be set without a workflow move, and clearing it on reopen is inconsistent between workflows. The transition history is what every other figure uses, so the same source marks done.
- **Including time in To Do in the columns.** It would add queueing before anyone chose the work, so the columns would no longer add up to cycle time, and an old backlog item would dominate the chart.
- **Per-person views.** Ranking or charting people turns a flow measure into a judgement of individuals, which ADR 0008 rules out. Names are limited to the lists a team needs in order to find and fix the cards.

## Consequences

### Positive

- Developers see where work waits, where the board disagrees with the code, and which habits (keys in titles and branches, moving cards when work starts, closing work as it finishes) make the figures true.
- The column means add up to the mean cycle time, so the stacked chart is honest.
- The measures are pure and tested with hand-computed values, and reuse the deploy pairing of ADR 0007, so a change to that window cannot silently diverge.

### Negative

- Waiting names are a heuristic. A status called "Ready for QA" is waiting under the rule even where the team works it actively, and one called "Parked" is not waiting under it, until a per-space override exists.
- A status renamed since the work happened no longer matches the space's statuses, so its time lands in "Not on the board".
- The page needs a Full re-crawl of each linked space (for levels and names) and of each linked repository (for the branch names used in joining), after which earlier figures change.
- Display names are now personal data held in SQLite, so a shared Atlassian app would have to declare that (ADR 0020).
- Work with no code, such as design or support tasks, appears under "done without a pull request", which needs reading as a prompt to check and not as an error.
- Bot and unmerged pull requests count as links, which can make an item look linked when only a dependency update names its key.
