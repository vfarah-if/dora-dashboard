# 13. Grade code health from git data, never by running the repository's code

Date: 2026-09-29

## Status

Accepted

## Context

ADR 0011 added complexity figures for each repository, but a list of figures leaves the reader to decide whether they are good. Readers also want to know whether the code is tested and whether linting and formatting are in place, and the usual ways of answering that involve running the repository's own test suite, linter or formatter to obtain a coverage percentage or a pass rate. Those tools execute whatever the crawled repository configures, on the host that holds the user's token, and this dashboard is pointed at repositories its operator may not fully trust.

## Decision

The code health section gives an overall grade made of three parts, and every input comes from files in the shallow clone and from the file lists of crawled pull requests. Nothing in a crawled repository is executed, which includes its test suites, its linter and formatter configurations (read as text, never loaded) and its package scripts and make targets (searched as text).

- **Maintainability.** The worst of four checks over source functions, namely the share of source lines in functions above a CCN of 10, the share above 20, the share of functions longer than 60 lines and the share with more than 5 parameters. Test functions are counted separately and never feed this part.
- **Testing.** The ratio of test lines to source lines, the share of merged pull requests that change source and also change a test, whether a CI workflow runs tests, and whether a coverage floor is configured. The band is the highest whose requirements all hold.
- **Hygiene.** Four checks (a linter is configured, a formatter is configured, CI runs the linter, and CI checks formatting). Four passes is elite, three high, one or two medium and none low.
- **Overall.** The lowest of the three parts, so a strength in one area cannot hide a gap in another. The reason names the part and the check responsible, and the stable check identifiers are listed in `GRADE_CHECKS` in `packages/core/src/codeGrade.ts` for front ends to write their own wording from.
- **Thresholds are our own convention.** The band limits are exported constants in `codeGrade.ts` and were chosen by the maintainers as reasonable limits. They are not an industry standard, no external body publishes them, and they can be changed by a later ADR.
- **Where the signals come from.**
  - Function metrics and test paths come from lizard (ADR 0011) with `isTestPath` in `packages/core/src/codeTooling.ts` deciding what is a test.
  - Tooling comes from `WorkspaceReader` (`apps/api/src/infrastructure/fs/fs-workspace-reader.ts`), which uses `node:fs` only, refuses paths outside the clone, refuses any path with a symbolic link on the way, skips `.git`, `node_modules`, `vendor`, `dist` and `build` by name at any depth, reads files up to 256 KiB and stops listing after 200,000 entries or 30 levels.
  - Pull request file lists come from the GitHub GraphQL query, which now asks for the first 100 changed paths of each pull request and the total count. A pull request with more than 100 files is marked as truncated and left out of the pull-request check, since its list is incomplete. A page that fails with a 502 or 504 is retried once at 25 pull requests instead of 50.
  - `detectTooling` is pure and works on `{ path, content }` pairs. It follows `make` targets, package scripts and `turbo run` from a workflow file, so that a workflow calling `make check` reaches the `prettier --check` behind it, and it also follows `pnpm -r`, `pnpm --filter`, `turbo` and `npx turbo`. It ignores comments, step names, `echo` lines, install commands and steps marked `continue-on-error`, so a tool that is only mentioned does not count as run. Every step reading untrusted text is bounded in line length, total size and Makefile expansion.
- **Coverage floor.** Where several configuration files set a threshold, the lowest is reported, because the weakest gate is the one that lets a regression through. A floor of 0 counts as none, and elite testing needs a floor of at least 60 (`MIN_COVERAGE_FLOOR`), so a token floor does not earn it. A `--cov-fail-under` flag counts only when CI reaches it, while a threshold in a configuration file is accepted as written, since a file cannot say whether CI collects coverage.
- **One list of checks.** The report carries a `checks` list, one entry per check with its figure and band, as the single source of each check's band, so front ends hold no thresholds of their own. It also reports the longest function.
- **The editorconfig file.** `.editorconfig` counts only as a weak formatter. It guides editors but enforces nothing, so it does not satisfy the formatter check, and the reason says so when it is the only one found.
- **Snapshot version.** Snapshots now carry `tooling` and a `snapshotVersion` (currently 3). A snapshot from an older version is analysed again even when the branch head has not moved, which overrides the skip described in ADR 0011.
- **Backfilling pull request files.** Pull requests crawled before this change have no file list and are ignored for the pull-request check until a full crawl fetches them. When no pull request has file data the check is ignored rather than failed.

Left out for now:

- **Real coverage percentages** from CI artefacts or Codecov. They would be more truthful than a configured floor, but they need a per-repository credential and a new external system, and they belong in their own ADR.
- **Lint pass rates** from the GitHub checks API, for the same reason.

## Consequences

### Positive

- Every repository gets a verdict with a stated reason, and the host never runs code it did not write.
- The grade is computed from stored snapshots and pull requests on request, so changing a threshold changes every past report without a re-crawl.
- Reading configuration as text makes detection testable with fixture strings and no processes.

### Negative

- The grade shows what a repository is set up to do, not what it achieves. A coverage floor below 60 still counts as a floor for high but not for elite, and a CI step whose `if` condition means it rarely runs still counts, because detection is text matching and does not evaluate conditions.
- A configuration file does not prove that CI collects coverage, so a floor read from one is a statement of intent.
- Pull requests with more than 100 files are left out of the pull-request check, which biases it towards smaller changes.
- Tool detection knows a fixed list of tools and file names, so an unusual setup can look unconfigured until a rule is added.
- The bands have a cliff edge. In a small repository a single function can move a share across a limit and change the band, which is why the figure is always shown beside the band and the reason names the check involved.
- Repositories without pull request file data, or with few merged pull requests in the range, have a weaker pull-request check until a full crawl has run.
- The thresholds are a convention, so grades are comparable across repositories on this dashboard and not with figures from other tools.

## Revision History

- 2026-09-30: the snapshot version is now 4, which records files the analyser may have read only in part (ADR 0015).
- 2026-10-07: `CODE_SNAPSHOT_VERSION` is now 5 (ADR 0025), so every repository is analysed again on its next crawl even when the branch has not moved. The body above says "currently 3"; the current version is the one in `packages/core/src/codeHealth.ts`. The body also says function metrics come from lizard. JavaScript and TypeScript are now measured by the syntax tree analyser of ADR 0025, which reads files and never runs them, and lizard measures every other language.
- 2026-10-07: the crawl now reads up to about 3000 changed paths of each pull request rather than the first 100, and marks one as truncated only when fewer were read than GitHub's total. A truncated pull request counts in the pull-request check when the paths read already include a source file and a test file, and a tool's configuration file no longer counts as source there (ADR 0027). The body above says pull requests with more than 100 files are left out; that now holds only past about 3000 files, and only when the paths read do not settle the answer.
- 2026-10-10: measured coverage is now read from CI artefacts under ADR 0030, for display only, and it still never feeds the grade. The body above says real coverage percentages need a per-repository credential. They do not, because the token the crawl already holds can read a repository's Actions artefacts, and the existing `repo` scope covers them. A fine-grained token needs read access to Actions. Areas of a repository carry a maintainability band and no grade (ADR 0029), and `CodeHealthReport` carries the `thresholds` its counts were taken at.
