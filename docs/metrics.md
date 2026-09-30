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

Measured from a shallow clone of each repository's deploy branch, taken at the end of a crawl and analysed with lizard (ADR 0011), together with the file lists of crawled pull requests. It is a snapshot of one commit, shown on the repository page, and is not part of the comparison view. Nothing in the repository is ever executed (ADR 0013), so every figure below comes from reading files, and the thresholds are this project's own convention rather than an industry standard.

A function is anything lizard reports, in any language it reads. Directories named `node_modules`, `vendor`, `dist` and `build`, and minified `.min.js` files, are excluded, so generated code kept elsewhere will still be counted.

### Source and test code

A file is a **test file** when any of these hold, with directory names matched in any letter case.

- Its name contains `.test.` or `.spec.`.
- Its name is `test_*.py`, `*_test.py`, `conftest.py`, `*_test.go` or `*_spec.rb`.
- Its name ends in `Test.java`, `Tests.java`, `Tests.cs`, `Spec.scala` or `Spec.kt`.
- Any directory in its path is named `test`, `tests`, `__tests__`, `__mocks__` or `spec`.

Every other function is **source**. All figures in this section are over source functions only, apart from the test figures, which are counted separately.

| Figure                       | Definition                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Functions                    | Number of source functions found.                                                                                                                                                                       |
| NLOC                         | Lines of code in source functions, excluding blank lines and comments, summed. Code outside any function is not counted.                                                                                |
| Test functions, test NLOC    | The same two counts over test functions.                                                                                                                                                                |
| CCN                          | Cyclomatic complexity of a function, the number of independent paths through it. A function with no branches scores 1.                                                                                  |
| Mean, median, p75 CCN        | Mean, median and 75th percentile (linearly interpolated) of CCN across source functions. Zero when there are none.                                                                                      |
| Maximum CCN                  | The highest CCN of any source function.                                                                                                                                                                 |
| Functions above 10, above 20 | The count of source functions with a CCN strictly above 10 and strictly above 20, with each count also given as a share of all source functions. A function scoring exactly 10 is not counted above 10. |
| Longest function             | The source function with the most NLOC. Ties are broken by higher CCN, then by file path, then by function name.                                                                                        |
| Most complex                 | The single source function with the highest CCN, using the tie-break below.                                                                                                                             |
| Distribution                 | Source function counts in five CCN buckets: 1 to 5, 6 to 10, 11 to 20, 21 to 50 and over 50. Each function falls in exactly one.                                                                        |
| Languages                    | Per language, the function count, summed NLOC and mean CCN, ordered by function count and then by name. Language comes from the file extension, with `.h` counted as C and `.m` as Objective-C.         |
| Hotspots                     | The ten source functions with the highest CCN. Ties are broken by larger NLOC, then by file path, then by function name.                                                                                |

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

The report also carries the commit that was analysed and when. The figures are always those of the last successful analysis. When a later attempt fails, for example because lizard is not installed, the clone failed, it timed out or the output exceeded 64 MiB, the page keeps the earlier figures and shows the reason beside them. Only a repository that has never been analysed successfully shows the reason alone. Flow and DORA figures are unaffected either way. A crawl skips the clone when the branch has not moved since the last successful analysis, unless the snapshot is from an older version (the current version is 3), and a full crawl always analyses again. `CODE_ANALYSIS=off` disables the analysis.

## Comparing repositories fairly

- **Align to project start** puts week N of each project on one axis.
- **Per contributor** divides weekly throughput by the people active that week.
- **Period all were active** compares the same calendar weeks, from the latest project start to today.
- **Show people** reveals per-person figures and is off by default (ADR 0008).
