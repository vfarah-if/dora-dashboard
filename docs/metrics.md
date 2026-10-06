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

Open pull requests are grouped as one piece of work when they share a ticket key (such as `ABC-123`) in the title, branch or linked issues, name each other on a `Related:` line in the description, share a head branch other than a common trunk name such as `main` or `develop`, or form a stack, where one is based on another's branch. Only groups of two or more are shown. These are heuristics, so a group is a prompt to look, not a fact.

## Code health

Measured from a shallow clone of each repository's deploy branch, taken at the end of a crawl and analysed with lizard (ADR 0011), together with the file lists of crawled pull requests. It is a snapshot of one commit, shown on the repository page, and is not part of the comparison view. Nothing in the repository is ever executed (ADR 0013), so every figure below comes from reading files, and the thresholds are this project's own convention rather than an industry standard.

A function is anything lizard reports, in any language it reads. Directories named `node_modules`, `vendor`, `dist` and `build`, and minified `.min.js` files, are excluded, so generated code kept elsewhere will still be counted.

### Source and test code

A file is a **test file** when any of these hold, with directory names matched in any letter case.

- Its name contains `.test.` or `.spec.`.
- Its name is `test_*.py`, `*_test.py`, `conftest.py`, `*_test.go` or `*_spec.rb`.
- Its name ends in `Test.java`, `Tests.java`, `Tests.cs`, `Spec.scala` or `Spec.kt`.
- Any directory in its path is named `test`, `tests`, `__tests__`, `__mocks__` or `spec`.

Every other function is **source**. All figures in this section are over source functions only, apart from the test figures, which are counted separately.

| Figure                       | Definition                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Functions                    | Number of source functions found.                                                                                                                                                                                                                                                                                            |
| NLOC                         | Lines of code in source functions, excluding blank lines and comments, summed. Code outside any function is not counted.                                                                                                                                                                                                     |
| Test functions, test NLOC    | The same two counts over test functions.                                                                                                                                                                                                                                                                                     |
| CCN                          | Cyclomatic complexity of a function, the number of independent paths through it. A function with no branches scores 1.                                                                                                                                                                                                       |
| Mean, median, p75 CCN        | Mean, median and 75th percentile (linearly interpolated) of CCN across source functions. Zero when there are none.                                                                                                                                                                                                           |
| Maximum CCN                  | The highest CCN of any source function.                                                                                                                                                                                                                                                                                      |
| Functions above 10, above 20 | The count of source functions with a CCN strictly above 10 and strictly above 20, with each count also given as a share of all source functions. A function scoring exactly 10 is not counted above 10.                                                                                                                      |
| Longest function             | The source function with the most NLOC. Ties are broken by higher CCN, then by file path, then by function name.                                                                                                                                                                                                             |
| Most complex                 | The single source function with the highest CCN, using the tie-break below.                                                                                                                                                                                                                                                  |
| Distribution                 | Source function counts in five CCN buckets: 1 to 5, 6 to 10, 11 to 20, 21 to 50 and over 50. Each function falls in exactly one.                                                                                                                                                                                             |
| Languages                    | Per language, the function count, summed NLOC and mean CCN, ordered by function count and then by name. Language comes from the file extension, with `.h` counted as C and `.m` as Objective-C.                                                                                                                              |
| Hotspots                     | The ten source functions with the highest CCN, each with its shape, line share and whether it is on the path to the next band. Ties are broken by larger NLOC, then by file path, then by function name.                                                                                                                     |
| Next band                    | A short list of source functions to simplify for maintainability to reach the band above its current one, largest NLOC first, with their summed NLOC. Absent when maintainability is elite or there is no source. See below.                                                                                                 |
| Hotspot shape                | The kind of change that helps a hotspot. None when CCN is 10 or less and NLOC is 60 or less. Otherwise `component` (a capitalised function in a `.tsx` or `.jsx` file), `dense` (0.5 or more CCN per line), `long` (40 lines or more) or `branching`, taken in that order. Parameters are not considered.                    |
| Line share                   | A hotspot's NLOC over all source NLOC, from 0 to 1.                                                                                                                                                                                                                                                                          |
| Partly measured              | Source files, sorted, that may have been read only in part because they hold a JSX spread attribute, such as `<div {...props}>`, which lizard cannot parse and answers by dropping the enclosing function and the next. Only `.tsx` and `.jsx` files are checked, by a text heuristic. Empty for snapshots before version 4. |

### Where to start

The advice uses the same limits as the maintainability table and does not change any band. To reach the next band, the checks are taken in this order and offenders are picked until the share is below the next band's limit, largest NLOC first for the two checks over lines and those failing the most checks first for the two over functions: lines above CCN 20, lines above CCN 10, long functions, then many parameters. Functions picked for the CCN 20 check also count towards the CCN 10 check. A picked function is assumed to end up within every limit and total source NLOC is assumed to stay the same, so the list is a minimum and more may be needed. The shapes and their limits (0.5 CCN per line, 40 lines) are this project's convention.

The partly measured notice is a text heuristic and not a parse (ADR 0015). It can flag a file that has no JSX spread when an object spread follows an identifier it does not recognise (destructuring after `const`, `let` or `var` is recognised), and it can miss one, and it names the file and not the functions that are missing.

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

| Figure         | Definition                                                                                                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Test ratio     | Test NLOC divided by source NLOC. Zero when there is no test code or no source.                                                                                                                                                                                                                                |
| PRs with tests | Of the pull requests merged in the chosen range that change at least one source code file, the share that also change a test file. Bots are left out. Only the first 100 changed files of each pull request are recorded, so a pull request with more than 100 files is excluded, as is one with no file data. |
| CI runs tests  | A workflow, or a `make` target, package script or `turbo` task it calls, runs `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `npm test` or `npm run test`, `pnpm test`, `yarn test`, `mvn` with `test`, `gradle` or `gradlew` with `test`, or `dotnet test`.                                             |
| Coverage floor | The lowest line coverage threshold found, as a percentage, or none. See below.                                                                                                                                                                                                                                 |

For PRs with tests, a source code file is one whose extension is a language lizard reads and that is not a test file. The range is the same `from` and `to` dates the report uses, and `to` includes the whole day. When no pull request qualifies the figure is absent and the requirement is ignored, and a full crawl is needed to fetch file lists for pull requests crawled earlier.

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

The report also carries the commit that was analysed and when. The figures are always those of the last successful analysis. When a later attempt fails, for example because lizard is not installed, the clone failed, it timed out or the output exceeded 64 MiB, the page keeps the earlier figures and shows the reason beside them. Only a repository that has never been analysed successfully shows the reason alone. Each failure carries a reason code (`analyser-missing`, `analysis-off` or `failed`), and when lizard is missing the page shows how to install it on each platform. Flow and DORA figures are unaffected either way. A crawl skips the clone when the branch has not moved since the last successful analysis, unless the snapshot is from an older version (the current version is 3), and a full crawl always analyses again. `CODE_ANALYSIS=off` disables the analysis.

## Delivery from Jira

A Jira space linked to repositories has its own page at `/spaces/:id`. These figures come from the issue history in Jira, joined to pull requests by issue key, and they are distinct from DORA lead time. DORA lead time runs from a commit to a deploy and never reads Jira. The figures here are named issue cycle time, issue lead time, issue to first PR and issue to production so that the two are not confused (ADR 0020, ADR 0021). The page also uses UTC and weeks that start on Monday, and its range is reported as dates. It runs from the first millisecond of the from date to the last millisecond of the to date, 23:59:59.999, with the end capped at now.

Only delivery items count. These are issues at Jira hierarchy level 0, such as stories, bugs, tasks and features. Sub-tasks and epics are not counted, although a sub-task's key links its pull requests to its parent, and open epics are shown as a separate total. Items crawled before levels were recorded are told apart by their type name.

| Figure              | From                                  | To                                                              | Notes                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue cycle time    | First move into an in-progress status | Last move into done                                             | Over items done in the range. An item done without ever being in progress has no cycle time and is listed under hygiene.                                                                                                                                        |
| Issue lead time     | Issue created                         | Last move into done                                             | Over items done in the range. It includes time waiting in the backlog. Never below zero, so an issue created after its move into done, as a migrated issue can be, counts as zero.                                                                              |
| Issue to first PR   | Issue created                         | Earliest pull request opened that names the issue or a sub-task | Never below zero, because a ticket raised after the work started waited no time.                                                                                                                                                                                |
| Issue to production | Issue created                         | Deploy that shipped the last merged pull request that names it  | Counts an item only when every merged pull request linked to it has shipped, so an item whose merged pull request went to a branch with no deploy never gets this figure. Never below zero. Each repository uses its own deploy branch and the ADR 0007 window. |

Each figure shows the median and the 75th percentile. An item is done only when its current category is done and its history holds a move into done, so `resolvedAt` is not used. An item with no history is treated as being in its current category from creation.

### Throughput

Delivery items done per week, by the week of their last move into done, split by issue type.

### Work in progress and ageing

Work in progress is the number of delivery items in an in-progress status at the last millisecond of each week, or at the end of the range when that is earlier, rebuilt from the status history. A week that runs past the end of the range is partial and is left off the charts. Ageing work lists the items in progress now, oldest first, with the time since each started. Ageing is measured as of now, not at the end of the range.

### Time per column

For each item done in the range, the time from started to done is divided among the board columns it spent time in. An item visits a column only if it spent time there. The chart shows the mean hours per done item, so the columns add up to the mean issue cycle time, and the table adds the median and the number of items. A status is matched to the space's statuses by exact name and then ignoring case, and is shown under the space's spelling. Time in a status that matches no column, for example one renamed since the work happened, is shown as "Not on the board" so that no time disappears. When a space has no board, its statuses are the columns, in the space's order, with unknown statuses last in alphabetical order. Time in To Do before the work started is not included.

### Flow efficiency

Active time divided by the time from started to done, summed over the items done in the range. Waiting time is time in an in-progress status whose name contains block, hold, wait, ready or queue, together with any time back in to do or done between start and done. All other time in progress is active. This is a rule about names, so a status that does not follow the naming reads as active, and a per-space override will come later (ADR 0021).

### Linked share

The share of delivery items done in the range that have at least one linked pull request, shown beside issue to production so that a reader can see how many items the figure covers. Every pull request in a linked repository counts as a link, including those from bots and those not merged.

### Hygiene checks

Each check lists the issue keys or pull requests it found, and where a share makes sense it shows how many were checked. They are prompts to look at the board, not verdicts. Stale work, unassigned work and ageing are measured as of now. Names appear only in these lists, and only behind Show people (ADR 0008). An incremental crawl adds names it has not seen and updates any that changed, while a full crawl replaces the stored names with those it read.

| Check                    | Rule                                                                                                                                                                                                                                                                                                                                   | Why it matters                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Pull request without key | A merged pull request in a linked repository, opened by a person and not a bot, whose title and branch name carry no issue key. A key from any project counts, not only one from this space, so a pull request naming another project's issue is not listed here.                                                                      | Without the key, the work cannot be joined to Jira, so issue to production and the linked share are understated.      |
| Done without a PR        | A delivery item done in the range with no linked pull request.                                                                                                                                                                                                                                                                         | Some work has no code, so this is a prompt to check. A cluster of them usually means keys are missing from branches.  |
| Skipped in progress      | A delivery item done in the range with no move into an in-progress status.                                                                                                                                                                                                                                                             | It has no cycle time, so it is missing from every flow figure. The card was probably moved only when it finished.     |
| Bulk move                | Five or more distinct delivery items moved to done within 10 minutes of the first move of a batch. Exactly 10 minutes is inside. The same item moved twice counts once. A batch may start at any move, so when the 10 minutes after one move hold too few items the next move is tried, and the search resumes after each batch found. | Closing work in a batch records the day the board was tidied, not the day the work finished, which distorts times.    |
| Reopened                 | A delivery item with a transition from a done category to any category that is not done, including a status of unknown category.                                                                                                                                                                                                       | Work that returns suggests it was closed too early or that a defect escaped, and the later finish is what is counted. |
| Stale work               | A delivery item in progress now whose last update is more than 7 days before now.                                                                                                                                                                                                                                                      | Cards that nobody touches hide blocked or abandoned work and inflate work in progress.                                |
| In progress, unassigned  | A delivery item in progress now with no assignee.                                                                                                                                                                                                                                                                                      | Nobody is visibly responsible, so nobody is likely to notice that it has stopped.                                     |

## Comparing repositories fairly

- **Align to project start** puts week N of each project on one axis.
- **Per contributor** divides weekly throughput by the people active that week.
- **Period all were active** compares the same calendar weeks, from the latest project start to today.
- **Show people** reveals per-person figures and is off by default (ADR 0008).
