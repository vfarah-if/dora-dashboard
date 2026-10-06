# 21. Delivery measures from Jira

Date: 2026-10-06

## Status

Accepted

## Context

ADR 0020 connected Jira, crawled each linked space with its full status history and joined issues to pull requests, but left the measures for later. Developers need to see how work flows through a space and whether the board tells the truth about it, for example whether cards are moved when work starts, whether work is closed in bulk, and whether pull requests carry the issue key that joins them to Jira. These figures must carry names that cannot be confused with DORA lead time, which is measured from commits and deploys (ADR 0006, ADR 0007).

## Decision

Every measure is a pure function in `packages/core/src/spaceReport.ts` (`buildSpaceReport`), is given `now` rather than reading a clock, and is shown at `/spaces/:id`, which warns when the latest crawl failed. Full definitions, thresholds and examples are in `docs/metrics.md` under "Delivery from Jira", and this record keeps the rules and their reasons.

- **Range.** The report states `from` and `to` as `YYYY-MM-DD` dates, runs to 23:59:59.999 UTC on the to date so nothing in the final second is lost, and caps the end at now. A `from` after today is refused with a 400 ("from must not be after today"), using the service's clock, because the range could only be inverted. Repository reports follow the same rule.
- **What counts.** Delivery items are issues at hierarchy level 0. Sub-tasks and epics are not counted, but a sub-task's key links its pull requests to its parent, so a story split into sub-tasks stays one unit of delivery.
- **Started and done.** Started is the first move into an in-progress category. Done is the start of the final stretch in done, so a later move between two done statuses, such as Done to Released, neither finishes nor reopens an item and cannot inflate cycle time or count as a bulk move. `resolvedAt` is not used. Items with unknown or missing history take the current category rather than dropping out of every done figure.
- **Cycle and lead time.** Issue cycle time runs from started to done and issue lead time from created to done, in calendar hours over items done in the range, and both are clamped at zero.
- **Work in progress.** It is counted at the end of each week, and a week that runs past the end of the range is flagged as partial and hidden from charts.
- **Time per column.** Time is measured from started to done, so the column means add up to the mean issue cycle time, and time in To Do is excluded. A status matches the space's statuses by exact name and then ignoring case. Time in a status on no board column is reported under a column whose name is null (shown as "Not on the board"), so it cannot merge with a real column of that name.
- **Board access.** The report carries `space.board` as null (not yet read), `read`, `none` or `forbidden` (ADR 0020). When the board is not `read`, the space's statuses serve as the columns in the space's order, and the page says why, so a missing scope is not mistaken for a space without a board.
- **Flow efficiency.** Waiting time is time in an in-progress status whose name holds block, hold, wait, ready or queue as a whole word, plus time back in to do, in done or in an unknown category. It is a rule about names, and a per-space override is left for later.
- **Linking pull requests.** An issue key follows Jira's form (for example `MY_PROJ-7`) and is found in a title or branch even beside underscores, so `feature_WID-12` yields `WID-12`. Every pull request in a linked repository counts as a link, bots and unmerged included. Each repository is paired with its own deploy branch and the window of ADR 0007 through `shippedPrs` in `dora.ts`, the pairing DORA lead time uses.
- **Idea to production.** Issue to first pull request and issue to production are clamped at zero. Issue to production counts an item only when every merged pull request linked to it has shipped.
- **Hygiene.** Seven checks list the items or pull requests they found, such as a bulk move of five or more items into done within 10 minutes, a reopened item, stale work and unassigned work. Stale work, unassigned work and ageing are measured as of now.
- **People.** Assignee display names are stored per space and returned only with `people=1`, and `GET /api/repos/:id/spaces` strips them. They appear only in hygiene lists behind the Show people toggle, never on a chart or tile, and every item says whether anyone is assigned without naming them. Email addresses are never read (ADR 0008). Names that cannot be read back from SQLite are logged with the space id and count as never recorded until the next full crawl.

### Alternatives considered

- **Counting sub-tasks.** A story split into six sub-tasks would count as seven items, and teams that split work more finely would look more productive.
- **`resolvedAt` as done.** Resolution can be set without a workflow move and is cleared inconsistently on reopen, whereas the transition history is what every other figure uses.
- **Including time in To Do in the columns.** The columns would no longer add up to cycle time, and an old backlog item would dominate the chart.
- **Per-person views.** Ranking people turns a flow measure into a judgement of individuals, which ADR 0008 rules out.

## Consequences

### Positive

- Developers see where work waits, where the board disagrees with the code, and which habits make the figures true.
- The column means add up to the mean cycle time, so the stacked chart is honest.
- The measures are pure and tested with hand-computed values, and reuse the deploy pairing of ADR 0007, so a change to that window cannot silently diverge.

### Negative

- Waiting names are a heuristic. A status called "Ready for QA" is waiting even where the team works it actively, and "Parked" is not, until a per-space override exists.
- A status renamed since the work happened lands in "Not on the board", and a refused board makes every column a status.
- The page needs a Full re-crawl of each linked space (for levels and names) and of each linked repository (for branch names), after which earlier figures change.
- Display names are personal data held in SQLite, so a shared Atlassian app would have to declare that (ADR 0020).
- Work with no code, such as design or support tasks, appears under "done without a pull request", which is a prompt to check and not an error.
- Bot and unmerged pull requests count as links, so an item can look linked when only a dependency update names its key.
