# What each figure means

Every figure is computed in `packages/core` from crawled pull requests and deploy workflow runs. The reasoning behind each rule is in ADR 0006; this page is the reader's version. Times are UTC and weeks start on Monday. A repository's weekly charts keep the week the range ends part way through, normally the current one, and mark it in their tooltips and tables, as so far when the range runs to today or with the day the range stops at otherwise. Its counts are drawn lighter so a part week does not look like a slump. The comparison and Jira space charts leave that week off, whereas the GitHub Issues page keeps it and draws it lighter, as a repository's does (ADR 0028). Repository and space reports take a range as `from` and `to` dates (`YYYY-MM-DD`), and a `from` after today is refused with a 400 ("from must not be after today"), as is a `from` after `to`. Every report route (repository, Jira space and issue reports) also refuses an impossible calendar date such as 2026-02-30, and any date before 2000-01-01, with a 400.

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

| Measure               | Rule                                                                                     | Elite         | High         | Medium        | Low    |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------- | ------------ | ------------- | ------ |
| Deployment frequency  | Successful deploys per week over the range                                               | 7 or more     | 1 or more    | 0.25 or more  | less   |
| Lead time for changes | First commit to the end of the first successful deploy starting after the merge (median) | under a day   | under a week | under a month | longer |
| Change failure rate   | Failed deploys over all counted deploys                                                  | 5% or less    | 10% or less  | 15% or less   | more   |
| Time to restore       | First failure in a streak to the next success (median)                                   | under an hour | under a day  | under a week  | longer |

Lead time only counts PRs merged after the first deploy run the crawl has seen (ADR 0007). Without that rule, a repository whose pipeline is younger than its history reports months of lead time that never happened.

PRs titled `revert` or `hotfix` are counted beside the change failure rate rather than inside it. A title matches when it starts with either word, in any letter case, and the word stands alone, so `Revert "add login"` matches and `Reverting` does not.

### Grading profile

Bands are graded against a named profile, and every report says which one it used. The only profile today has the id `dora-2023` and the name "DORA 2023". It takes its thresholds from the [2023 Accelerate State of DevOps Report](https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf), with three simplifications so that a published cluster becomes a single threshold.

- "On demand" deployment becomes 7 or more successful deploys a week.
- A range becomes its edge, so a medium deployment frequency of between once a week and once a month becomes 0.25 a week or more, which means 1 or more every four weeks.
- A cluster's failure rate becomes "or less", so the high band is 10% or less.

The band table above shows these values. Durations are compared strictly, so a median lead time of exactly 24 hours is high and not elite, whereas frequency and failure rate include their limit.

The report and compare endpoints accept a `profile` query parameter naming a profile id, and an unknown id is refused with a 400 response. A comparison grades every repository against the one profile, so that the bands can be read side by side (ADR 0008). The interface has no profile selector until a second, cited profile exists. The reasoning is in ADR 0016.

### Rework rate

Rework rate is the share of successful deploys that shipped at least one revert or hotfix PR. It is shown beside the change failure rate and has no band, because DORA publishes none for it.

- A PR is a revert or hotfix when its title matches the rule above.
- A PR ships with the first successful deploy run created at or after its merge. This is the pairing that lead time uses, so it only considers PRs merged into the deploy branch after the first deploy run the crawl has seen (ADR 0007).
- The rate is the number of successful deploys that shipped one or more such PRs, divided by all successful deploys in the range. A deploy counts once however many revert or hotfix PRs it shipped.
- A revert or hotfix PR that has not yet been shipped by a successful deploy is not counted.
- With no successful deploys the figure is null and nothing is shown.

It differs from the revert PR count beside the change failure rate, which counts every merged PR with such a title whether or not it has shipped.

It is a proxy for DORA's rework rate, which counts unplanned deployments made to fix a user-facing problem. The deploy counted is the one that shipped the fix, not the one that caused the problem. Only PRs merged inside the range are paired, while the denominator is every successful deploy in the range, so a deploy early in the range that shipped a fix merged just before it is not counted.

### AI-assisted work

Pull requests are split into assisted and unassisted cohorts, so that a team can see whether faster delivery is arriving with more rework instead of assuming it. A pull request is assisted when the first of these holds, taken in this order.

1. It carries the default label `ai-assisted`, compared without regard to letter case. A bare `ai` label is not counted, because repositories that build AI features use it as a product area.
2. Any of its commits has a `Co-Authored-By` trailer whose whole name is one an assistant signs with, compared without regard to letter case. The defaults cover Claude (alone or followed by a model name such as Opus or Sonnet, or by Code), Copilot and GitHub Copilot, Cursor and Cursor Agent, Codex and OpenAI Codex, Devin and Devin AI, and Gemini and Gemini Code Assist. A person who merely shares a first name, such as Claude Martin, is not matched.
3. It was opened by a bot account whose login matches one of those patterns, such as `copilot-swe-agent[bot]`.

Otherwise it is unassisted. A pull request whose labels and co-authors were both never recorded is **unknown**, which is the case for pull requests crawled before this feature existed, and it stays unknown until a full crawl fetches them again. Unknown pull requests are counted and shown but belong to neither cohort.

Only the name part of a trailer is stored. The email address and the commit message are discarded when the crawl reads them. The crawl reads the messages of the last 100 commits of each pull request, so a pull request with more commits may miss earlier trailers.

For each cohort the report gives the number of pull requests, the median and 75th percentile of cycle time, the median size, the share that was reviewed by someone other than the author, and the share whose title marks a revert or hotfix. Cycle time here runs from the first commit to the merge and not to the deploy, so it is not the lead time used in the DORA table.

Deploy measures are not split by cohort, because a single deploy ships a mixture of both kinds of work. Labels rely on team discipline, and AI use that is not marked by a label, a trailer or a bot author counts as unassisted, so the assisted cohort is a floor and not a total. The default patterns are a convention, so an assistant that signs with another name is missed until the patterns are extended. The decision is recorded in ADR 0016.

### Explaining a band

Each DORA tile on a repository's page can be opened to explain its band. Every figure in the explanation is measured over the same range and filters as the tile, and none of them names a person. The rules and the practices each driver links to are in ADR 0022.

**The gap to the next band** is in the measure's own unit and uses the same comparison as the grade. For deployment frequency it is the deploys a week still needed, and reaching the next threshold is enough. For change failure rate it is the fall in the rate still needed, and reaching the threshold is enough. For lead time and time to restore it is the hours above the next threshold, and the figure must fall below that threshold, so a gap of zero means the figure sits exactly on it. An elite figure has no gap, and the explanation says how far inside the elite threshold it is. The gap is written to the same precision as the value beside it so one can be read off the other: a duration and its gap share a unit and drop a trailing ".0" (24 h, 1.3 days), deploys a week take one decimal place, and a change failure rate takes one decimal place only when the gap needs it (24.4%, 9.4 percentage points). A gap that would show as zero at that precision takes more places, or for a duration its own unit, until it does not.

The findings below are shown at every band, so an elite figure says why it holds. Practices to try are offered only below elite.

**Lead time** is split into five parts, measured for each shipped pull request and averaged.

| Part               | From                            | To                                          |
| ------------------ | ------------------------------- | ------------------------------------------- |
| Coding             | First commit                    | PR ready for review                         |
| Waiting for review | PR ready for review             | First review by someone else, or the merge  |
| In review          | First review                    | First approval                              |
| To merge           | First approval, or first review | Merged                                      |
| To deploy          | Merged                          | End of the first successful deploy after it |

The parts are means, so they add up to the mean lead time, while the tile shows the median, and the two can differ a good deal when a few pull requests take much longer than the rest. Draft time, from opening a pull request to marking it ready for review, counts as coding, so waiting for review starts where time to first review does and a long draft is not read as a slow review. The cycle time stage chart above counts draft time as waiting for review. A pull request merged without a review by someone else counts all of its time from ready for review to merge as waiting for review. The largest part is named first, and on a tie the earlier part wins. The 75th percentile of lead time and the median size of the shipped pull requests are shown beside the parts.

**Deployment frequency** first states the tile's own figures, the successful deploys and every week the range touches, partial weeks included, so a reader can divide one by the other and reach the tile. It then gives the complete weeks and how many of those had no successful deploy. A week is complete only when it lies wholly inside the range, so a range that starts mid-week leaves its first week partial just as one that ends mid-week leaves its last, and a partial week is never counted as a week without a deploy. When the median number of pull requests each successful deploy shipped, counting only deploys that shipped at least one, is above one, it also gives that median as the batch size of a deploy. A pull request ships with the first successful deploy created at or after its merge, the same pairing lead time uses.

**Change failure rate** gives the failed and total deploy runs, the workflow with the most failed runs with its failed and total runs, and the share of successful deploys that shipped a revert or hotfix (the rework rate above).

**Time to restore** gives the number of failure streaks that recovered, the median number of failed runs in a streak, and the longest restore. A streak is one or more failed deploy runs in a row followed by a success. A streak still failing at the end of the range is reported first, with when it began and how many runs have failed, because the median only counts streaks that recovered. When no streak has recovered at all, the tile is not measured and its reason gives the same date and count.

The 2023 Accelerate State of DevOps Report renamed the restore measure **failed deployment recovery time**, to separate failures caused by a deployment from other outages. This dashboard measures from the first failed deploy run to the next successful one, which already fits the narrower definition, so only the label differs.

## Review queue

The review queue reads open pull requests live from the code host (cached for about a minute) rather than from the last crawl, so it shows the state of the repositories now. Nothing on it is stored. The decision is recorded in ADR 0017.

| Figure      | Rule                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review wait | From the later of the moment the pull request left draft and the last review by someone other than the author, to now. Only hours falling Monday to Friday in UTC count, so a pull request published on Friday at 16:00 has waited 18 hours by Monday at 10:00. |
| Idle        | Whole wall clock days since the pull request was last updated. The idle tile counts 14 days or more, in any lane.                                                                                                                                               |
| Fast lane   | A waiting pull request under 400 changed lines and under 10 files.                                                                                                                                                                                              |

### Lanes

Every open pull request sits in one lane, the first that matches.

| Lane            | When                                                                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Held            | A draft, or labelled `on hold`.                                                                                                                                                                                                     |
| With author     | Checks are failing, a reviewer's latest review is a request for changes, or someone commented, nobody has been asked to look again and nobody has approved. A reviewer asked to re-review, and a dismissed review, no longer count. |
| Approved        | At least one reviewer's latest review is an approval, and nothing above applies.                                                                                                                                                    |
| Awaiting review | At least one person or team has been asked to review.                                                                                                                                                                               |
| No reviewer     | Nobody has been asked and nobody else has reviewed.                                                                                                                                                                                 |

Reviews by bot accounts (the host's `Bot` type, or a login ending in `[bot]`) are ignored for lanes and for the wait, so an automated approval neither moves a pull request out of no reviewer nor restarts its wait. Asking for a review again does not restart the wait either: it runs from publication or the last human review, whichever is later.

Only pull requests awaiting review or with no reviewer are counted as waiting in the tiles, the bands of each repository and the needs attention list.

### Bands

| Band    | Review wait (weekday hours) |
| ------- | --------------------------- |
| Fresh   | under 4                     |
| Ageing  | 4 up to and including 24    |
| Overdue | over 24                     |
| Stale   | 120 or more (5 weekdays)    |

Needs attention lists stale pull requests with no reviewer first, then stale pull requests awaiting review, then overdue pull requests with no reviewer, each with the longest wait first.

### Features

Open pull requests are grouped as one piece of work when they share a ticket key (such as `ABC-123` or `MY_PROJ-7`, matched as described under Delivery from Jira) in the title, branch or linked issues (a linked GitHub issue is matched as `owner/name#12`, so two repositories' issue 12 are different), name each other on a `Related:` line in the description, share a head branch other than a common trunk name such as `main` or `develop`, or form a stack, where one is based on another's branch. Only groups of two or more are shown. These are heuristics, so a group is a prompt to look, not a fact.

## Code health

Measured from a shallow clone of each repository's deploy branch, taken at the end of a crawl and analysed in process for JavaScript and TypeScript and with lizard for every other language (ADR 0011, ADR 0025), together with the file lists of crawled pull requests. It is a snapshot of one commit, shown on the repository page, and is not part of the comparison view. Nothing in the repository is ever executed (ADR 0013), so every figure below comes from reading files, and the thresholds are this project's own convention rather than an industry standard.

JavaScript and TypeScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) are read from a syntax tree built by `@babel/parser`, so they need no external tool. Declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are skipped. Every other language is read by lizard, which is needed only when the repository holds such files. Directories named `node_modules`, `vendor`, `dist` and `build`, and minified `.min.js`, `.min.mjs` and `.min.cjs` files, are excluded, so generated code kept elsewhere will still be counted. The file listing stops at 200,000 entries or 30 directory levels, and files beyond that are neither measured nor flagged, although the API logs a warning.

A function is a declaration, a function expression, an arrow function, an object method, a class method (including private methods, getters, setters and constructors) or a class property holding a function. Overload signatures, `declare function`, abstract methods and code outside any function are not functions. Lizard's own definition applies to the languages it reads.

For JavaScript and TypeScript the measures are defined as follows (ADR 0025).

- **CCN** is 1 plus one for each `if` (so each `else if`), `for`, `for...in`, `for...of`, `while`, `do...while`, `case` with a test, `catch`, ternary, `&&`, `||`, `??`, `&&=`, `||=` and `??=` whose nearest enclosing function is this one. `else`, `default:`, optional chaining, default parameter values and TypeScript conditional types do not count. A decorator's branches, including a parameter decorator's, count to the code around the decorated method or parameter.
- **Nested functions** are measured on their own, so a callback's branches and lines count to the callback and never to the function around it.
- **NLOC** counts each physical line once, to the innermost function holding its first code token, and every function also counts its own start line, so `useEffect(() => {` counts for both the component and the callback. A token spanning lines, such as a template literal, counts every line it spans. Comments, blank lines and whitespace-only JSX text never count.
- **Parameters** count once each, except that an object or array pattern counts each entry destructured at its top level, so `({ label, value, onChange })` is 3. A TypeScript `this` parameter is not counted, and the parameters of anonymous arrow functions are counted, which lizard mostly reports as 0.
- **Names** come from the function itself or from what it is assigned to, looking through parentheses, `as`, `satisfies` and `!`. The name is also taken through a call when the callee is a plain function name (`memo`, `forwardRef`, `useCallback`) or a member of a capitalised name (`React.memo`), so `const Card = memo(() => ...)` is `Card`. An unnamed default export is `default`. A function passed to any other call, including a constructor such as `new Promise(...)`, is `<callee> callback`, so `const total = items.reduce((s, i) => s + i, 0)` gives `reduce callback`. A plain function name is taken to return its argument, so `const id = setTimeout(() => ..., 1000)` also names its callback `id`. One in a JSX attribute takes the attribute's name, and anything else is `(anonymous)`.
- **Reading a file.** Flow annotations are read in any `.js`, `.jsx`, `.mjs` or `.cjs` file, and an `@flow` pragma only decides syntax that standard JavaScript reads differently, such as `f<T>(x)`. A file is parsed with legacy decorators first. If errors remain and the file holds an `@`, it is parsed with standard decorators, and if errors remain it is parsed as a script, which reads sloppy-mode code using `with`, octal literals or duplicate parameters. The reading with the fewest errors is kept, so a file with errors can be parsed up to three times, which takes about a second for a 2 MiB file.
- **Where it differs from lizard.** Lizard counts `a ?? b` and `a ??= b` twice and `a??b` and `a??=b` once, depending on spacing, and `||=` and `&&=` once however they are spaced. Here each of these counts once. Together with the `this` parameter and anonymous arrow function parameters described above, these are the three counts that differ from lizard on purpose.

### Source and test code

A file is a **test file** when any of these hold, with directory names matched in any letter case.

- Its name contains `.test.` or `.spec.`.
- Its name is `test_*.py`, `*_test.py`, `conftest.py`, `*_test.go` or `*_spec.rb`.
- Its name ends in `Test.java`, `Tests.java`, `Tests.cs`, `Spec.scala` or `Spec.kt`.
- Any directory in its path is named `test`, `tests`, `__tests__`, `__mocks__` or `spec`.

Every other function is **source**. All figures in this section are over source functions only, apart from the test figures, which are counted separately.

| Figure                       | Definition                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Functions                    | Number of source functions found.                                                                                                                                                                                                                                                                                                                                                                      |
| NLOC                         | Lines of code in source functions, excluding blank lines and comments, summed. Code outside any function is not counted.                                                                                                                                                                                                                                                                               |
| Test functions, test NLOC    | The same two counts over test functions.                                                                                                                                                                                                                                                                                                                                                               |
| CCN                          | Cyclomatic complexity of a function, the number of independent paths through it. A function with no branches scores 1.                                                                                                                                                                                                                                                                                 |
| Mean, median, p75 CCN        | Mean, median and 75th percentile (linearly interpolated) of CCN across source functions. Zero when there are none.                                                                                                                                                                                                                                                                                     |
| Maximum CCN                  | The highest CCN of any source function.                                                                                                                                                                                                                                                                                                                                                                |
| Functions above 10, above 20 | The count of source functions with a CCN strictly above 10 and strictly above 20, with each count also given as a share of all source functions. A function scoring exactly 10 is not counted above 10.                                                                                                                                                                                                |
| Longest function             | The source function with the most NLOC. Ties are broken by higher CCN, then by file path, then by function name.                                                                                                                                                                                                                                                                                       |
| Most complex                 | The single source function with the highest CCN, using the tie-break below.                                                                                                                                                                                                                                                                                                                            |
| Distribution                 | Source function counts in five CCN buckets: 1 to 5, 6 to 10, 11 to 20, 21 to 50 and over 50. Each function falls in exactly one.                                                                                                                                                                                                                                                                       |
| Languages                    | Per language, the function count, summed NLOC and mean CCN, ordered by function count and then by name. Language comes from the file extension, with `.h` counted as C and `.m` as Objective-C.                                                                                                                                                                                                        |
| Hotspots                     | The ten source functions with the highest CCN, each with its shape, line share and whether it is on the path to the next band. Ties are broken by larger NLOC, then by file path, then by function name.                                                                                                                                                                                               |
| Next band                    | A short list of source functions to simplify for maintainability to reach the band above its current one, largest NLOC first, with their summed NLOC. Absent when maintainability is elite or there is no source. See below.                                                                                                                                                                           |
| Hotspot shape                | The kind of change that helps a hotspot. None when CCN is 10 or less and NLOC is 60 or less. Otherwise `component` (a capitalised function in a `.tsx` or `.jsx` file), `dense` (0.5 or more CCN per line), `long` (40 lines or more) or `branching`, taken in that order. Parameters are not considered.                                                                                              |
| Line share                   | A hotspot's NLOC over all source NLOC, from 0 to 1.                                                                                                                                                                                                                                                                                                                                                    |
| Partly measured              | Source files, sorted, that were read only in part. A JavaScript or TypeScript file is listed when it is larger than 2 MiB or could not be read, when the parser recovered from errors or gave up, when it is nested too deeply for the parser, or when it holds a node or token type the analyser does not know, so some or all of its functions may be missing. Empty for snapshots before version 4. |
| Unmeasured files             | The number of files in languages lizard 1.24 reads that went unmeasured because the API could not find lizard, test files included. JavaScript and TypeScript are measured regardless. Zero when lizard ran and for snapshots before version 5.                                                                                                                                                        |

### Where to start

The advice uses the same limits as the maintainability table and does not change any band. To reach the next band, the checks are taken in this order and offenders are picked until the share is below the next band's limit, largest NLOC first for the two checks over lines and those failing the most checks first for the two over functions: lines above CCN 20, lines above CCN 10, long functions, then many parameters. Functions picked for the CCN 20 check also count towards the CCN 10 check. A picked function is assumed to end up within every limit and total source NLOC is assumed to stay the same, so the list is a minimum and more may be needed. The shapes and their limits (0.5 CCN per line, 40 lines) are this project's convention.

The partly measured notice lists files that could not be read in full, and it names the file and not the functions that are missing (ADR 0015, ADR 0025). The unmeasured files notice shows how to install lizard.

### The grade

The grade has three parts and an overall band, using the same four labels as DORA (elite, high, medium and low). Each part gives a band and a reason naming the check that held it back, or "all" when nothing did. The **overall** band is the lowest of the three parts, and when parts tie the first of maintainability, testing and hygiene is named. There is no grade when the snapshot has no source function or when the repository's configuration files could not be read, and snapshots taken before ADR 0013 have none until the repository is analysed again.

The report also carries a `checks` list with one entry per check, holding the figure, the band that check alone allows, whether it is fully met, the counts behind a share, the tool names for hygiene and whether it is the check that limits its part. It is the single source for each check's band, so a front end needs no thresholds of its own. With no tooling facts it lists only the maintainability checks and the two testing checks that can be measured, and with no source function it is empty.

The bands are cliff edges by nature. In a small repository one function can move a share across a limit, so read each band beside its figure.

#### Maintainability

Four figures over source functions, each banded on its own. The part takes the worst band, and when checks tie the first listed is named. Each limit is exclusive, so a figure equal to a limit falls in the lower band.

| Figure             | Definition                                                       | Elite    | High      | Medium    | Low         |
| ------------------ | ---------------------------------------------------------------- | -------- | --------- | --------- | ----------- |
| Lines above CCN 10 | NLOC in functions with a CCN above 10, over all source NLOC      | under 5% | under 10% | under 20% | 20% or more |
| Lines above CCN 20 | NLOC in functions with a CCN above 20, over all source NLOC      | under 1% | under 3%  | under 8%  | 8% or more  |
| Long functions     | Source functions with more than 60 NLOC, over all functions      | under 1% | under 3%  | under 6%  | 6% or more  |
| Many parameters    | Source functions with more than 5 parameters, over all functions | under 1% | under 3%  | under 6%  | 6% or more  |

#### Testing

| Figure         | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test ratio     | Test NLOC divided by source NLOC. Zero when there is no test code or no source.                                                                                                                                                                                                                                                                                                                                                                      |
| PRs with tests | Of the pull requests merged in the chosen range that change at least one source code file, the share that also change a test file. Bots are left out, as is a pull request with no file data. The crawl records up to about 3000 changed files of each pull request, the most GitHub's REST API lists, so a pull request with more files counts only when those already include a source file and a test file, and is left out otherwise (ADR 0027). |
| CI runs tests  | A workflow, or a `make` target, package script or `turbo` task it calls, runs `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `npm test` or `npm run test`, `pnpm test`, `yarn test`, `mvn` with `test`, `gradle` or `gradlew` with `test`, or `dotnet test`.                                                                                                                                                                                   |
| Coverage floor | The lowest line coverage threshold found, as a percentage, or none. See below.                                                                                                                                                                                                                                                                                                                                                                       |

For PRs with tests, a source code file is one whose extension is on the fixed list in core's `isCodeFile` (`packages/core/src/codeTooling.ts`), whether or not an analyser is installed for it, that is not a test file, and that is not a tool's configuration (`isToolConfig`): a name starting with a dot, such as `.ncurc.mjs`, or containing `.config.`, such as `vite.config.ts`. The range is the same `from` and `to` dates the report uses, and `to` includes the whole day. When no pull request qualifies the figure is absent and the requirement is ignored, and a full crawl is needed to fetch file lists for pull requests crawled earlier, or to complete those recorded when only their first 100 files were read.

The part takes the highest band whose requirements all hold, and the reason is the first requirement of the next band up that does not.

| Band   | Test ratio                        | PRs with tests | Also required                             |
| ------ | --------------------------------- | -------------- | ----------------------------------------- |
| Elite  | 0.5 or more                       | 60% or more    | CI runs tests and a coverage floor is set |
| High   | 0.3 or more                       | 40% or more    | CI runs tests                             |
| Medium | 0.1 or more                       | 20% or more    | Nothing further                           |
| Low    | Anything less, including no tests |                |                                           |

The coverage floor is a configured gate, not a measured percentage. A floor of 0 counts as none, and a floor below 60 (`MIN_COVERAGE_FLOOR`) is reported but does not satisfy the elite requirement, so the testing part stops at high. It is read from a `thresholds` or `coverageThreshold` block in vitest, vite or jest configuration or `package.json` (taking `lines`, or `statements` when only that is set), ignoring comments and looking only inside that block, and from `fail_under` in `.coveragerc`, `pyproject.toml`, `setup.cfg`, `tox.ini` or `pytest.ini`, again ignoring comments. A `--cov-fail-under` flag counts only when a CI run reaches the command that carries it. When several floors are found the lowest is reported.

#### Hygiene

Four yes or no checks. Four passes is elite, three is high, one or two is medium and none is low. The reason lists every check that failed.

| Check                | Passes when                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linter configured    | A linter has a configuration file, in the table below.                                                                                               |
| Formatter configured | A formatter has a configuration file, or a Go or Rust repository has its built-in one. `.editorconfig` alone does not count, and the reason says so. |
| CI runs a linter     | A workflow, or a `make` target, package script or `turbo` task it calls, runs a linter.                                                              |
| CI checks formatting | The same, running a formatter in check mode so that unformatted code fails the build.                                                                |

Tool detection reads every workflow file in `.github/workflows`, and at most 200 other candidate configuration files of up to 256 KiB each, shallowest first, skipping candidates inside test directories. It follows a workflow through `make` targets, package scripts (including `npm run`, `pnpm -r`, `pnpm --filter` and `yarn`) and `turbo`, `turbo run` and `npx turbo`. Comment lines, `name:` labels, `echo` and `printf` lines, install commands such as `npm ci` or `pip install`, and any step marked `continue-on-error: true` are ignored, because none of them can fail a build on a tool.

Limits of the method, stated plainly.

- Detection is a text heuristic over workflow and configuration files. It does not parse YAML, evaluate expressions or run anything, so a step that an `if` condition disables, or a job that never runs on the deploy branch, still counts.
- A configuration file does not prove that CI runs coverage. A threshold in a vitest or `fail_under` setting counts as a floor even if no workflow ever collects coverage, whereas `--cov-fail-under` counts only when CI reaches it.
- Directories named `.git`, `node_modules`, `vendor`, `dist` and `build` are skipped by name at any depth, so a source folder that happens to have one of those names is not read for configuration.
- Symbolic links are never followed, and a file is refused when any directory above it is a link, even one that stays inside the clone.
- Inputs are bounded so hostile files cannot exhaust the host. Lines are cut at 2,000 characters, the commands gathered from CI are capped at 1,000,000 characters in total, Makefile lines at 4,096 characters, variables at 1,024 characters and the total text produced by variable expansion at 262,144 characters, and the file walk stops after 200,000 entries or 30 directory levels. When a limit is hit the detection sees less, and the grade errs towards reporting a tool as missing.

| Tool          | Configured when                                                                                 | Counts as run in CI when the commands contain                       |
| ------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| eslint        | `eslint.config.*`, `.eslintrc*` or an `eslintConfig` key in `package.json`                      | `eslint`                                                            |
| biome         | `biome.json` or `biome.jsonc` (both a linter and a formatter)                                   | `biome ci`, `check` or `lint` (format check: `biome ci` or `check`) |
| ruff          | `ruff.toml`, `.ruff.toml` or a `[tool.ruff]` table in `pyproject.toml`                          | `ruff check` or `ruff .`                                            |
| flake8        | `.flake8`, or `[flake8]` in `setup.cfg` or `tox.ini`                                            | `flake8`                                                            |
| pylint        | `pylintrc`, `.pylintrc` or `[tool.pylint` in `pyproject.toml`                                   | `pylint`                                                            |
| golangci-lint | `.golangci.*`                                                                                   | `golangci-lint`                                                     |
| rubocop       | `.rubocop.yml`                                                                                  | `rubocop`                                                           |
| clippy        | `clippy.toml` or `.clippy.toml`, or CI running `cargo clippy`                                   | `cargo clippy`                                                      |
| detekt        | `detekt.yml` or `detekt.yaml`, or `detekt` in a Gradle build file                               | `detekt`                                                            |
| ktlint        | `ktlint` in a Gradle build file                                                                 | `ktlint`                                                            |
| prettier      | `.prettierrc*`, `prettier.config.*` or a `prettier` key in `package.json`                       | `prettier` with `--check` or `-c` (format check)                    |
| black         | `[tool.black]` in `pyproject.toml`                                                              | `black` with `--check` (format check)                               |
| ruff format   | a `[format]` or `[tool.ruff.format]` table in a ruff configuration, or CI running `ruff format` | `ruff format` with `--check` (format check)                         |
| gofmt         | a `go.mod` file                                                                                 | `gofmt -l` (format check)                                           |
| rustfmt       | `rustfmt.toml`, `.rustfmt.toml` or `Cargo.toml`                                                 | `cargo fmt` or `rustfmt` with `--check` (format check)              |
| editorconfig  | `.editorconfig`, a weak formatter that never satisfies the check                                | not applicable                                                      |

### When there is no report

The report also carries the commit that was analysed and when. The figures are always those of the last successful analysis. When a later attempt fails, for example because the clone failed, it timed out or the output exceeded 64 MiB, the page keeps the earlier figures and shows the reason beside them. Only a repository that has never been analysed successfully shows the reason alone. Each failure carries a reason code (`analyser-missing`, `analysis-off` or `failed`).

A lizard that cannot be found does not fail the analysis. JavaScript and TypeScript are still measured, and the page shows how to install lizard on each platform, beside a count of the files left unmeasured. A lizard that is found but does not run, or that times out, fails the analysis, so the page keeps the last good figures and shows the reason. Once lizard is found, the next crawl analyses a snapshot that left files unmeasured again at the same commit, so installing lizard (and restarting the API if it was already running) and crawling again adds those files. While lizard is still missing the stored snapshot stands. The `analyser-missing` code is no longer produced by the combined analyser and now mainly comes from snapshots stored before ADR 0025. Flow and DORA figures are unaffected either way. A crawl skips the clone when the branch has not moved since the last successful analysis, unless the snapshot is from an older version (the current version is 6), and a full crawl always analyses again. `CODE_ANALYSIS=off` disables the analysis, and no coverage is read either.

### Areas

The detailed code analysis page (`/repos/:id/code`, served by `GET /api/repos/:id/code-detail?area=`) breaks the last good snapshot down by area (ADR 0029). It does not follow the date range. From version 6 a snapshot stores every code file in the listing (`files`, tests included, sorted and capped at 200,000), the manifest paths and the workspace patterns the root declares (`layout`), and each function's `endLine`. The areas are worked out from these when a report is built, so a change to the rules needs no crawl.

A candidate area is the directory of a manifest (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `setup.py`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `project.json`, `composer.json`, `mix.exs`, `pubspec.yaml`, `Package.swift`, `deno.json`, `*.csproj`, `*.fsproj` or `*.gemspec`). The repository root, a test or fixture directory itself or any directory inside one (`fixtures`, `__fixtures__`, `testdata`, `test-data`, `__snapshots__` or a test path as defined above) and directories with no code file below them are not candidates. The rules then run in order.

1. **Declared workspaces.** The root `workspaces` field of `package.json` (an array, or an object with `packages`) and the `packages` field of `lerna.json`, both read as JSON, and the `packages:` list of `pnpm-workspace.yaml` (block or flow style), read by a bounded line reader, give patterns. Candidates that match a positive pattern and no `!` pattern, reduced to their outermost directories as for rule 2, are areas of kind `workspace`. A pattern is matched one path segment at a time and supports `*`, `?`, `**` and a leading `!`. Brace patterns such as `{a,b}` are not supported. When no candidate matches, the next rule applies.
2. **Several manifests.** The outermost candidates, so that a manifest inside a package is not an area of its own. Two or more are areas of kind `workspace`. One alone is not enough.
3. **Folder mode.** Using source files only (code files that are not tests and not in fixture directories), start at `src/` when any source file is under it and at the root otherwise. Descend into the child directory holding the most source files while it holds at least 80% of the source below the current directory, for at most 10 levels, and stop before a child none of whose subdirectories holds a source file. Each child directory of the final directory is an area of kind `folder`.
4. **Leftovers.** Every file in no area is grouped under its top-level folder as an area of kind `folder`, and files at the root form the area `.` of kind `root`. Each file therefore belongs to exactly one area, the one with the longest matching `path/` prefix.
5. **No file list.** The mode `unknown` means the snapshot has no file list, because it predates version 6 or its listing failed. The paths of its functions and partly measured files stand in for the list and the folder rules run. A full re-crawl or a new commit finds the workspaces.

| Figure                            | Definition                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source files                      | Code files in the area that are not test files, from the stored listing. A fixture file counts here, as its functions count in the figures, although a fixture directory is never chosen as an area. |
| Functions, NLOC, mean CCN         | The figures of the source and test code section, over the area's source functions.                                                                                                                   |
| Above the warning and high limits | Source functions in the area with a CCN above 10 and above 20.                                                                                                                                       |
| Source NLOC above the warning     | The source NLOC that sits in the area's functions with a CCN above 10, which is what the area chart shows.                                                                                           |
| Test functions, test NLOC         | The test figures for functions whose file is in the area. Tests that live outside the area are not counted for it.                                                                                   |
| Maintainability band              | The band from the four maintainability checks, over the area's functions alone, and absent when the area or scope has no source function. It is not a grade (see below).                             |
| Coverage                          | The measured line coverage of the area's files that a coverage report matched, or absent when none matched or they instrument no line (see Measured coverage).                                       |

Areas are listed largest first by source NLOC, then by path, at most 300, with the total. Choosing an area scopes the figures, the distribution, where to start, the function table and the coverage to it, and an area that is not in the list falls back to the whole repository with a notice. The function table lists at most 500 source functions, most complex first.

An area has a maintainability band and no overall grade. Tests often live outside the area they test, and tooling such as CI, linting and formatting is configured for the whole repository, so testing and hygiene are scored for the whole repository only. The overall grade on the page is the repository's.

### Measured coverage

Coverage is read from a GitHub Actions artefact for display only (ADR 0030). It never changes a grade, band or check.

**Which artefact.** The search reads the newest 300 artefacts of the repository, of any name and branch, and keeps one when its name contains `coverage` in any letter case, it has not expired, its run was on the deploy branch and its run did not come from a fork. When nothing from the deploy branch is among the 300, a failure that says so is stored and logged, and when a complete search finds nothing an earlier failure is cleared. The newest run that built the analysed commit is used, or the newest run when none did, with up to five of its matching artefacts, and the page says how many of the run's artefacts were read when it had more. Coverage is read on every crawl while code analysis is on, whether or not the clone is skipped, so coverage published after a crawl is found by the next one. With `CODE_ANALYSIS=off` none is read.

**Which files.** Files are picked by base name. lcov comes from `lcov.info` or any `*.lcov`, Istanbul from `coverage-final.json` and `coverage-summary.json`, and XML only when named `coverage.xml` or containing `cobertura` and ending `.xml`. An XML candidate is read as Cobertura only when its first 4,096 characters carry `line-rate=` and not `clover=`. JaCoCo, Clover and Go profiles are not read. Only lcov, Istanbul final and Cobertura say which lines ran, and a summary has totals per file and no line detail. When one directory holds several formats the best is kept, in the order lcov, Istanbul final, Cobertura, Istanbul summary.

**Limits and refusals.** An artefact over 50 MiB is not downloaded and a download stops at that size, with a 120 second timeout. An archive is scanned for at most 5,000 entries. One file may unzip to 64 MiB, an XML file to 32 MiB and all files together to 192 MiB. Each file is parsed in one synchronous step within these caps, and the event loop is yielded to between files and between archive chunks, not within one file. Cobertura with an external DOCTYPE (as Istanbul, Vitest, Jest, nyc and Java Cobertura write) is read. A DOCTYPE with an internal subset, or any ENTITY, is refused, entities are never expanded, no DTD is fetched and XML is validated before parsing, so a truncated report is refused. The download follows GitHub's redirect by hand, sends the token only to the API host, requires https and refuses a redirect to localhost or to a loopback, private, shared, link-local, site-local or unspecified IP literal, including one carried inside a NAT64, 6to4 or IPv4-mapped IPv6 address.

**Files that cannot be read.** A coverage file that cannot be parsed is left out and counted, and the rest of the artefact is kept, and the page says how many files could not be read. A failure is stored only when nothing was readable, with a message that tells an unreadable file, a file that lists no files and no recognised file apart. A file that lists no files is not counted as unreadable.

**Line ranges and impossible counts.** A file keeps its covered and uncovered line ranges together, or neither. When either list would need more than 1,000 runs of lines, the file keeps only its exact totals and no ranges, so its per-function coverage is unknown and never wrong. A count that is impossible (not whole, negative, or more covered than total) is dropped, and a file whose line count is impossible is dropped. Ranges that disagree with their file's line count are dropped and the totals kept.

**Merging.** When several reports cover one file, such as the unit and integration artefacts of a matrix, lines with ranges on both sides are joined, so a line ran when it ran in either. Otherwise the side with ranges wins, then the side with more lines covered. Branch and function counts keep the higher of the two, because reports do not say which branch or function each count is. Inside one report, the records of one file are joined as well. In lcov a function is known by its name in `FN` and `FNDA` and a branch by its line, block and branch in `BRDA`, and the totals never fall below the highest `FNF`, `FNH`, `BRF` or `BRH` that any record states, since one file can hold two functions of the same name. In Istanbul each line takes its most-run statement, and functions and branches are known by their position (a branch also by its type and extent, as two branches can start at the same place). In Cobertura a line takes its highest hit count, and a method is counted once by its name, signature and first line.

**Alignment.** A report's paths are mapped onto the repository's files, with test files dropped. The repository's files are indexed by every run of trailing segments, so a report path finds the files that share the most trailing segments with it by lookup. Cobertura `<source>` roots are joined first, and separators, `file://`, `./`, `..` and drive letters are normalised. Each path votes for the transform that strips or adds a prefix so that it lands on those files, and the transform with most votes is applied, with ties going to the artefact's directory and then to the fewest segments added.

- A path whose only evidence is a name shared by more than 50 files votes last. It is placed only when a single transform leads with at least two such paths behind it, or the directory hint alone picks among the leaders. Otherwise it is left unmatched and counted.
- A path still unmatched falls back to a suffix match that must be unique. It tries a tail of the report path only when the tail has at least two segments, and never when the report's own layout already places the path under the root it strips, such as `node_modules/foo/index.ts`.
- Unmatched paths are counted once for each artefact, report directory and path, because the same relative path in two reports can be two files, and a path that another report's layout places on a matched file is not counted. The page says how many source files the report named, how many matched and how many did not, and it never shows the paths.

| Figure                       | Definition                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lines, branches, functions   | Covered over total, summed over the matched files in scope. A figure is absent when no matched file in scope carries it, and a share of 0 of 0 is absent and never 0%, for an area, a scope and a function alike.                                                                                                         |
| Matched files in scope       | How many matched files sit in the selected area or repository. When there are none the page says the report does not cover that area, and the lists below are empty because nothing was measured and not because everything is covered.                                                                                   |
| Area coverage                | The line figure over the matched files of one area.                                                                                                                                                                                                                                                                       |
| Function coverage            | The share of a function's instrumented lines that ran, counting lines from `startLine` to `endLine`. Absent when the snapshot has no `endLine` (before version 6), when the file has no line ranges (the report has no line detail, or the file was over the range limit), or when the function has no instrumented line. |
| Least covered files          | Matched files in scope with at least one uncovered line, most uncovered lines first, then by path, at most 50. Each lists its uncovered line ranges, at most 20 per file, with the total. Line detail is a property of the whole report, so a file without ranges shows its counts only.                                  |
| Not in the report            | Source files in scope with functions that no report mentions, largest NLOC first, at most 200. A file is listed only when a matched file shares its area and language, so a Python file is not blamed for being missing from a JavaScript report.                                                                         |
| Other kinds not in report    | The count of source files in scope with functions that no report mentions and that are not listed above, because no matched file shares their area and language.                                                                                                                                                          |
| Untested complex functions   | Source functions in scope with a CCN above 10, at least one instrumented line and no covered line, most complex first, at most 100. Needs `endLine` and line ranges.                                                                                                                                                      |
| Different commit             | A notice shown when the commit the coverage was measured on is not the commit analysed. The uncovered ranges, the untested complex functions and the function coverage column are each labelled in the same way.                                                                                                          |
| The newest report created on | The creation time of the newest artefact read, shown on the page so that a reader can tell how old the coverage is when CI has stopped publishing and an older snapshot stays shown.                                                                                                                                      |
| Files that could not be read | How many coverage files in the artefacts could not be parsed and were left out. A file that lists no files is not counted here.                                                                                                                                                                                           |

A failed read keeps the last good figures and shows the reason beside them. A repository with none yet shows what to publish.

## Delivery from Jira

A Jira space linked to repositories has its own page at `/spaces/:id`. These figures come from the issue history in Jira, joined to pull requests by issue key, and they are distinct from DORA lead time. DORA lead time runs from a commit to a deploy and never reads Jira. The figures here are named issue cycle time, issue lead time, issue to first PR and issue to production so that the two are not confused (ADR 0020, ADR 0021). The page also uses UTC and weeks that start on Monday, and its range is reported as dates, with the same rules about `from` and `to` as a repository report. It runs from the first millisecond of the from date to the last millisecond of the to date, 23:59:59.999, with the end capped at now. The page warns when the latest crawl of the space failed, because the figures may then be out of date.

Only delivery items count. These are issues at Jira hierarchy level 0, such as stories, bugs, tasks and features. Sub-tasks and epics are not counted, although a sub-task's key links its pull requests to its parent, and open epics are shown as a separate total. Items crawled before levels were recorded are told apart by their type name.

An issue key is a capital letter followed by capitals, digits or underscores, then a hyphen and a number, such as `WID-12` or `MY_PROJ-7`, as Jira allows. It must not follow a letter or digit and its number must not run on into another digit, so a branch called `feature_WID-12` or `WID-12_add_widget` names `WID-12`. Lookalikes such as `UTF-8` and `SHA-256` are ignored.

| Figure              | From                                  | To                                                                                  | Notes                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue cycle time    | First move into an in-progress status | Start of the final stretch in done                                                  | Over items done in the range. An item done without ever being in progress has no cycle time and is listed under hygiene.                                                                                                                                                                      |
| Issue lead time     | Issue created                         | Start of the final stretch in done                                                  | Over items done in the range. It includes time waiting in the backlog. Never below zero, so an issue created after its move into done, as a migrated issue can be, counts as zero.                                                                                                            |
| Issue to first PR   | Issue created                         | Earliest pull request opened that names the issue or a sub-task                     | Over items done in the range. Never below zero, because a ticket raised after the work started waited no time.                                                                                                                                                                                |
| Issue to production | Issue created                         | Deploy that shipped the last merged pull request that names the issue or a sub-task | Over items done in the range. Counts an item only when every merged pull request linked to it has shipped, so an item whose merged pull request went to a branch with no deploy never gets this figure. Never below zero. Each repository uses its own deploy branch and the ADR 0007 window. |

Each figure shows the median and the 75th percentile. An item is done when its current category is done, and `resolvedAt` is not used. Its final stretch in done starts with its last move into a done status from one that is not done, so a later move between two done statuses, such as Done to Released, changes none of the figures. When the last move reached a status the space no longer lists, the category the item carries now is taken as that status's category. An item that is done now although its history holds no move into done, as when a status is recategorised after the move, counts as done from its last move rather than being left out of every done figure. A history starts with an entry at the item's creation for the status it was created in, so an issue created straight into done has a move into done at creation. An item with no history at all is treated as being in its current category from creation, so one that is done counts as done from its creation.

### Throughput

Delivery items done per week, by the week in which their final stretch in done began, split by issue type. Types other than Story, Bug, Task and Feature are folded into one "Other" series, and weeks running past the end of the range are left off the chart.

### Work in progress and ageing

Work in progress is the number of delivery items in an in-progress status at the last millisecond of each week, or at the end of the range when that is earlier, rebuilt from the status history. A last move to a status the space no longer lists takes the category the item carries now, so such an item is counted as the ageing list counts it. A week that runs past the end of the range is partial and is left off the charts. Ageing work lists the items in progress now, oldest first, with the time since each started. Ageing is measured as of now, not at the end of the range.

### Time per column

For each item done in the range, the time from started to done is divided among the board columns it spent time in. An item visits a column only if it spent time there. The chart shows the mean hours per done item, so the columns add up to the mean issue cycle time, and the table adds the median and the number of items. A status is matched to the space's statuses by exact name and then ignoring case, and is shown under the space's spelling. Time in a status that matches no column, for example one renamed since the work happened, is reported as a column with no name (`column: null`) and shown as "Not on the board", so that no time disappears and a board column that happens to carry those words is kept apart from it. The report also says how the board was read (`space.board`: null until the board has been read, then `read`, `none` for a space with no board, or `forbidden` when Jira refused the board, for example because the app lacks a board scope), so a missing board can be told from one that could not be seen. When a space has no board or its board could not be read, its statuses are the columns, in the space's order, with unknown statuses last in alphabetical order. Time in To Do before the work started is not included.

### Flow efficiency

Active time divided by the time from started to done, summed over the items done in the range. Waiting time is time in an in-progress status whose name holds, as a whole word in any case, a form of block (such as blocked or blocker), hold (such as on hold or held), wait (such as waiting or awaiting), ready, or queue (such as queued), together with any time between start and done spent back in to do, in done, or in a status of unknown category. Anything other than a letter separates words, so "Blocked", "On hold", "ON_HOLD", "Waiting for QA", "Ready for QA" and "Queued" are waiting, while "Already in progress", "Blockchain" and "Unblocked" are active. All other time in progress is active. This is a rule about names, so a status that does not follow the naming reads as active, and a per-space override will come later (ADR 0021).

### Linked share

The share of delivery items done in the range that have at least one linked pull request, shown beside issue to production so that a reader can see how many items the figure covers. Every pull request in a linked repository counts as a link, including those from bots and those not merged.

### Hygiene checks

Each check lists the issue keys or pull requests it found, and where a share makes sense it shows how many were checked. They are prompts to look at the board, not verdicts. Stale work, unassigned work and ageing are measured as of now. Names appear only in these lists, and only behind Show people (ADR 0008). Each listed item also says whether anyone is assigned, which names nobody, so work assigned to someone whose name the space did not record, as in a space crawled before names were recorded, is grouped as assigned with no name recorded rather than as unassigned. An incremental crawl adds names it has not seen and updates any that changed, while a full crawl replaces the stored names with those it read.

| Check                    | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Why it matters                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Pull request without key | A pull request merged in the range, in a linked repository, opened by a person and not a bot, whose title and branch name carry no issue key. A key from any project counts, not only one from this space, so a pull request naming another project's issue is not listed here.                                                                                                                                                                                                                                                          | Without the key, the work cannot be joined to Jira, so issue to production and the linked share are understated.      |
| Done without a PR        | A delivery item done in the range with no linked pull request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Some work has no code, so this is a prompt to check. A cluster of them usually means keys are missing from branches.  |
| Skipped in progress      | A delivery item done in the range with no move into an in-progress status.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | It has no cycle time, so it is missing from every flow figure. The card was probably moved only when it finished.     |
| Bulk move                | Five or more distinct delivery items moved into done in the range, from a status that is not done, within 10 minutes of the first move of a batch. A move between two done statuses, such as Done to Released, is not counted, and an issue created straight into done counts as a move at creation. Exactly 10 minutes is inside. The same item moved twice counts once. A batch may start at any move, so when the 10 minutes after one move hold too few items the next move is tried, and the search resumes after each batch found. | Closing work in a batch records the day the board was tidied, not the day the work finished, which distorts times.    |
| Reopened                 | A delivery item with a transition in the range from a done category to any category that is not done, including a status of unknown category, unless that is the item's last move and the item is done now, which makes it a move between two done statuses.                                                                                                                                                                                                                                                                             | Work that returns suggests it was closed too early or that a defect escaped, and the later finish is what is counted. |
| Stale work               | A delivery item in progress now whose last update is more than 7 days before now.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Cards that nobody touches hide blocked or abandoned work and inflate work in progress.                                |
| In progress, unassigned  | A delivery item in progress now with no assignee.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Nobody is visibly responsible, so nobody is likely to notice that it has stopped.                                     |

## Delivery from GitHub Issues

A repository whose issues are stored has a page at `/issues/:id`. The `/issues` page is always routed and shows an empty state when nothing qualifies. Otherwise it lists each repository that has stored issues or an issue error, with the error. The header link and the repository page's link appear when any repository is in one of those states. A repository with issues switched off on GitHub is not listed, since one tracked in Jira usually has them off, but its own issue page says so. These figures come from the issues in GitHub, joined to pull requests by closing reference, title and branch, and they are distinct from DORA lead time, which never reads issues. They are named "issue to first pull request" and "issue to production", as in the Jira report, so that they are not confused with it (ADR 0020, ADR 0021, ADR 0028); "idea to production" is only the section title. The page uses UTC and weeks that start on Monday, and its range follows the same rules about `from` and `to` as a repository report, running from the first millisecond of the from date to the last millisecond of the to date with the end capped at now. With no `from`, the range starts at the creation of the earliest stored issue. Unlike the Jira page, it keeps the week the range ends in, draws it lighter and marks it as partial, as the repository page does.

### Reading issues

Issues are read during the repository crawl, most recently updated first. The cursor is the newest update time seen less a five minute overlap and moves only when a read completes, whether full or incremental. A full read starts from the beginning without clearing the stored cursor, so a failed full read leaves the next crawl where the last complete read left it. Only a read that began at the start (a full read, or the first) removes issues the host no longer holds, so an issue deleted or transferred on GitHub stays until a full re-crawl. A missing issues list from GitHub fails the read rather than reading as empty. An error inside one issue's field, such as a closing pull request in an organisation the token cannot see, is tolerated with that field treated as missing, unless it left the whole issue unreadable, and any other GraphQL error fails the read. A rate limit gives a message to crawl again once it resets, and requests time out after 60 seconds. A failed read is stored as the repository's issue error and the rest of the crawl finishes, except that a rejected credential (HTTP 401) fails the whole crawl. Issue authors are not read or stored (ADR 0008).

Each issue is read with at most 10 assignees, 30 labels and 10 closing pull requests, and the last 20 closes and reopens. When the host held older history, the open spans fall back to the creation and final close dates.

Epics are never counted in a flow, a time or an issue check, and only the count of open epics is shown, apart. A pull request linked only to an epic still counts as linked to an issue, so it is not listed as a pull request without one. Pull requests are never issues.

### Kind and priority

Each issue is given a kind (bug, feature, maintenance, incident, security, epic or other) and a priority (P0 to P4, or none) when the report is built, so changing a repository's label override changes the report without a crawl. Evidence is read in order: GitHub's native issue type, then the labels, then the title's prefix, which is each leading `[tag]` and then the text before the first colon, so `[P1] Security: Login` offers `p1` and `security`. The first source that names a kind decides it, and when it names several the precedence is epic, security, incident, bug, feature, maintenance. Priority is decided the same way, by source in order. The first source that names any priority decides it, taking the most urgent it names, so a `p3` label outranks a `[P0]` title prefix. A native type that no list names, such as Task, gives no evidence, so the labels are read next. An issue nothing names is kind `other` with no priority.

Names are compared whole and without case, with a leading `type`, `kind`, `priority` or `prio` followed by a colon or a slash removed, and no pattern a user supplies is ever run. The defaults are below.

| Meaning     | Default names                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Bug         | bug, defect, regression                                                                                      |
| Feature     | feature, enhancement, feature request, story                                                                 |
| Maintenance | chore, maintenance, tech-debt, tech debt, refactor, dependencies, deps, dev-infra, infrastructure, infra, ci |
| Incident    | incident, outage, hotfix                                                                                     |
| Security    | security, vulnerability                                                                                      |
| Epic        | epic                                                                                                         |
| P0          | p0, critical, urgent, blocker                                                                                |
| P1          | p1, high                                                                                                     |
| P2          | p2, medium                                                                                                   |
| P3          | p3, low                                                                                                      |
| P4          | p4, lowest, trivial                                                                                          |

A repository can override these in its Configure panel. An override replaces only the keys it names, so naming `bug` leaves every other kind and every priority on its defaults. A key left out, empty or blank keeps its defaults, which core enforces, so an override can change which names mean a kind or priority but cannot switch one off. Each key takes at most 30 names of at most 100 characters, with no control characters, and the web reads these limits and the default names from `GET /api/issue-labels/defaults`.

### Open, closed and not planned

An issue is open from its creation until a close, and again from each reopen to the next close, replayed from its close and reopen events. When GitHub held more events than were read, or a closed issue has no events, it is treated as open from creation to its final close, and an open issue in that case has no final close and stays open. An issue is open at the end of the range when it is open at the last millisecond of the range.

A closed issue whose reason is completed, or that has no recorded reason, counts as closed. One closed as not planned or as a duplicate counts as not planned, and is left out of every time and of the linked share. Only an issue's final close counts, so one closed and then reopened is not closed until it is closed again. Duplicates are told apart only on that final reason, because a close event cannot say.

### Totals

- **Opened** is issues created in the range.
- **Closed** is issues whose final close is in the range and was completed.
- **Not planned** is issues whose final close is in the range and was not planned or a duplicate.
- **Open** is issues open at the end of the range, and **open epics** is the epics open then, shown apart.

### Time to close

Hours from creation to the final close, over issues closed as completed in the range, as a count, median, 75th percentile and mean. It is also given for each priority, always all six in the order P0 to P4 then none, with a count of zero for a priority nothing fell in. A close earlier than the creation reads as zero hours.

### Weekly flow

Each week of the range has the issues opened, closed and not planned in it, the closed issues by kind (every kind present, zero when none) and the issues open at the last millisecond of the week, or at the end of the range when that is earlier. The week the range ends in is partial.

### Open by kind and priority, and ageing

Open issues at the end of the range are counted by kind and by priority, with `none` for no priority. Ageing lists the 50 oldest of those issues, with the hours from creation to the end of the range, which can be earlier than now, and says how many are open in all. Behind Show people the list also names the assignees, and without it each issue says only whether anyone is assigned.

### Linking pull requests

A pull request is linked to an issue when any of these hold.

- The issue names it as a closing reference, which must be in the same repository as the issue.
- Its title carries `#n` with no letter, digit or underscore just before the `#` or just after the number, so `Fix #12abc` does not link.
- A segment of its branch name starts with the number, or with one word and a hyphen then the number, and the number ends the segment or is followed by a hyphen or underscore that is not followed by a digit, as in `feat/526-tts-gating`, `issue-389-crash` or a bare `123`.

A number in a title or branch counts only when it is a stored issue of this repository opened at or before the pull request and not already closed when the pull request was opened. Date shapes such as `release/2026-10-07` are not read. Issue and pull request numbers share one sequence on GitHub, so together these rules exclude the numbers of pull requests and most dates and versions, though a number in a branch can still match an unrelated issue that happens to be open. Pull requests by bots are ignored.

### Issue to first pull request and to production

For each issue closed as completed in the range that has a linked pull request, **issue to first PR** is the hours from the issue's creation to the opening of its earliest linked pull request. **Issue to production** is the hours from the issue's creation to the completion of the latest deploy among those that shipped its merged linked pull requests, and an issue counts only when every one of its merged pull requests has shipped. It applies the deploy branch and pairing rules of DORA lead time (ADR 0007). A pull request ships with the first successful deploy of the repository's deploy branch created at or after its merge, so an issue whose merged pull request went to another branch, or merged before the first recorded deploy, never gets the figure. Both are clamped at zero, so an issue raised after the work started waited no time, and they are summaries over the issues that have a value.

### Linked share

The issues closed as completed in the range that have at least one linked pull request, out of all those closed as completed. It is shown beside the two figures above so that a reader can see how many issues they cover.

### Hygiene checks

Each check lists what it found and, where a share makes sense, out of how many it looked. They are prompts to look at the issues, not verdicts. They are listed in the order below, with the one most affected by missing closing keywords last. Names appear only in the hygiene lists and the ageing list, and only behind Show people (ADR 0008), and each issue says whether anyone is assigned without naming them. Ageing and stale urgent are measured to the end of the range, not now, and the report carries the 14 day stale threshold.

| Check               | Rule                                                                                                                                                                                                                                                                                            | Of                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Closed without a PR | An issue closed as completed in the range with no linked pull request.                                                                                                                                                                                                                          | Issues closed as completed in the range         |
| Reopened            | An issue with a reopen event in the range, whatever its state now.                                                                                                                                                                                                                              | No share                                        |
| Urgent, unassigned  | An issue open at the end of the range with priority P0 or P1 and nobody assigned.                                                                                                                                                                                                               | Open P0 and P1 issues                           |
| Stale urgent        | An issue open at the end of the range with priority P0 or P1, or of kind incident or security, last updated more than 14 days before the end of the range. The last update is the latest one stored, so for a range that ended in the past an issue touched since then is not counted as stale. | Open issues of those priorities or kinds        |
| Unclassified        | An issue open at the end of the range that is kind `other` with no priority.                                                                                                                                                                                                                    | Issues open at the end of the range             |
| PR without an issue | A pull request merged in the range, not by a bot, that no issue links to, where a link to an epic counts as a link. It lists pull requests, not issues. It is noisy where branches carry no numbers and nobody uses closing keywords.                                                           | Pull requests merged in the range, not by a bot |

## Comparing repositories fairly

- **Align to project start** puts week N of each project on one axis.
- **Per contributor** divides weekly throughput by the people active that week.
- **Period all were active** compares the same calendar weeks, from the latest project start to today.
- **Show people** reveals per-person figures and is off by default (ADR 0008).
