# What each figure means

Every figure is computed in `packages/core` from crawled pull requests and deploy workflow runs. The reasoning behind each rule is in ADR 0006; this page is the reader's version. Times are UTC and weeks start on Monday. The current, unfinished week is left off weekly charts so a part week does not look like a slump.

## Flow

| Figure                 | From                                             | To                                            | Notes                                                                                                                          |
| ---------------------- | ------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Coding time            | First commit (earlier of authored and committed) | PR opened                                     | A rebased first commit dated after the PR opened counts as zero.                                                               |
| Time to first review   | PR ready for review                              | First review by someone other than the author | Draft time is excluded. The author commenting on their own PR is not a review.                                                 |
| Time to approval       | PR ready for review                              | First approval by someone else                |                                                                                                                                |
| Open to merge          | PR opened                                        | Merged                                        | Also split into reviewed and unreviewed PRs, because a solo author waits for nobody.                                           |
| Cycle time             | First commit                                     | Merged                                        | Shown as four stages: coding, waiting for review, in review, to merge. The stacked chart uses means because only means add up. |
| Size                   |                                                  |                                               | Additions plus deletions. Includes lockfiles, generated and vendored code, so read it as batch size, not output.               |
| Merged per author-week |                                                  |                                               | PRs merged divided by the sum, over weeks, of people who opened or merged a PR that week.                                      |

Every summary shows the median and the 75th percentile. Bots (`dependabot`, `renovate`, any `[bot]` or GitHub `Bot` account) are excluded unless you include them.

On a repository's page you can also leave chosen authors out. Their pull requests are removed before any figure is worked out, so every tile, chart and table agrees. A pull request with no author counts as `unknown`. The default range still starts at the first pull request by anyone, and reviews an excluded author gave on other pull requests still count. Of the DORA measures only lead time changes, because the other three come from workflow runs (ADR 0012).

## DORA

A **deployment** is a completed run, succeeded or failed, of the workflow files you configured for a repository, on its deploy branch. Cancelled and skipped runs are ignored.

| Measure               | Rule                                                                                     | Elite         | High         | Medium            | Low    |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------- | ------------ | ----------------- | ------ |
| Deployment frequency  | Successful deploys per week over the range                                               | 7 or more     | 1 or more    | 1 a month or more | less   |
| Lead time for changes | First commit to the end of the first successful deploy starting after the merge (median) | under a day   | under a week | under a month     | longer |
| Change failure rate   | Failed deploys over all counted deploys                                                  | 5% or less    | 10% or less  | 15% or less       | more   |
| Time to restore       | First failure in a streak to the next success (median)                                   | under an hour | under a day  | under a week      | longer |

Lead time only counts PRs merged after the first deploy run the crawl has seen (ADR 0007). Without that rule, a repository whose pipeline is younger than its history reports months of lead time that never happened.

PRs titled `revert` or `hotfix` are counted beside the change failure rate rather than inside it.

## Code health

Measured from a shallow clone of each repository's deploy branch, taken at the end of a crawl and analysed with lizard (ADR 0011). It is a snapshot of one commit, shown on the repository page, and is not part of the comparison view. A function is anything lizard reports, in any language it reads. Directories named `node_modules`, `vendor`, `dist` and `build`, and minified `.min.js` files, are excluded, so generated code kept elsewhere will still be counted.

| Figure                | Definition                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Functions             | Number of functions found.                                                                                                                                                                      |
| NLOC                  | Lines of code in those functions, excluding blank lines and comments, summed. Code outside any function is not counted.                                                                         |
| CCN                   | Cyclomatic complexity of a function, the number of independent paths through it. A function with no branches scores 1.                                                                          |
| Mean, median, p75 CCN | Mean, median and 75th percentile (linearly interpolated) of CCN across all functions. Zero when there are no functions.                                                                         |
| Maximum CCN           | The highest CCN of any function.                                                                                                                                                                |
| Share above 10        | Functions with a CCN strictly above 10, divided by all functions. A function scoring exactly 10 is not counted.                                                                                 |
| Share above 20        | Functions with a CCN strictly above 20, divided by all functions.                                                                                                                               |
| Distribution          | Function counts in five CCN buckets: 1 to 5, 6 to 10, 11 to 20, 21 to 50 and over 50. Each function falls in exactly one.                                                                       |
| Languages             | Per language, the function count, summed NLOC and mean CCN, ordered by function count and then by name. Language comes from the file extension, with `.h` counted as C and `.m` as Objective-C. |
| Hotspots              | The ten functions with the highest CCN. Ties are broken by larger NLOC, then by file path, then by function name.                                                                               |

The report also carries the commit that was analysed and when. The figures are always those of the last successful analysis. When a later attempt fails, for example because lizard is not installed, the clone failed, it timed out or the output exceeded 64 MiB, the page keeps the earlier figures and shows the reason beside them. Only a repository that has never been analysed successfully shows the reason alone. Flow and DORA figures are unaffected either way. A crawl skips the clone when the branch has not moved since the last successful analysis, and a full crawl always analyses again. `CODE_ANALYSIS=off` disables the analysis.

## Comparing repositories fairly

- **Align to project start** puts week N of each project on one axis.
- **Per contributor** divides weekly throughput by the people active that week.
- **Period all were active** compares the same calendar weeks, from the latest project start to today.
- **Show people** reveals per-person figures and is off by default (ADR 0008).
