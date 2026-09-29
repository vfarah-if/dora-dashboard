# 6. How each metric is measured

Date: 2026-09-29

## Status

Accepted

## Context

Delivery metrics are easy to compute and easy to compute misleadingly. Every definition below is a choice somebody will question, so the choices are written down once. `docs/metrics.md` is the reader-facing version.

## Decision

- **Averages are medians, with the 75th percentile beside them.** A handful of stale pull requests would otherwise dominate a mean. The one exception is the stacked cycle-time chart, which uses means because only means add up to the bar.
- **Coding time** runs from the earlier of the first commit's authored and committed dates to the PR opening. A first commit dated after the opening (a rebase) counts as zero.
- **Review wait** starts when the PR leaves draft, not when it opens, and counts only reviews by someone other than the author.
- **Bots are excluded** by default, recognised by GitHub's `Bot` type or a `[bot]`, `dependabot` or `renovate` login.
- **A deployment** is a completed run of a configured workflow file on the configured branch. Success and failure count; cancelled and skipped runs do not.
- **Change failure rate** is failed runs over all counted runs. PRs titled `revert` or `hotfix` are counted beside it, not inside it, because titles are a noisier signal.
- **Time to restore** runs from the first failure in a streak to the next success.
- **Bands** use fixed thresholds taken from the DORA performance clusters so a figure always maps to one band.

## Consequences

### Positive

- Every figure on screen can be traced to one rule, and core's tests pin each rule.

### Negative

- Workflow runs measure the pipeline, not production. A failed run caused by a flaky test counts as a change failure.
- A repository that deploys by some other means (tags, a separate repository, manual releases) shows no DORA figures until a provider for that mechanism exists.

## Revision History

- 2026-09-29: Each `WeekRow` now carries `partial`, true for a week that had not ended by the end of the range. Weekly rate charts leave it off, because a current week only two days old read as a collapse in throughput and deploys on the first comparison drawn. Cumulative charts keep it.
