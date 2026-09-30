# 11. Measure code health from a shallow clone

Date: 2026-09-29

## Status

Accepted

## Context

The dashboard shows how work flows through pull requests and the four DORA measures, but nothing about the code itself. Cyclomatic complexity (CCN) needs the source, and the GitHub API used by the crawl (ADR 0003) exposes metadata, file lists and individual blobs, but no practical way to read a whole tree and measure every function in it without one request per file. Teams want a complexity figure beside their flow figures, and it must work for private repositories without sending code to a third party.

## Decision

Each crawl clones the repository's deploy branch, analyses it, stores the result and discards the clone.

- **Clone.** `GitCheckout` (`apps/api/src/infrastructure/git/git-checkout.ts`) implements the `SourceCheckout` port with `git clone --depth 1 --single-branch --no-tags --branch <branch>` into a fresh `mkdtemp` directory named `dora-checkout-*`. The directory is removed in a `finally` block whether the analysis succeeds or not, and a failure to remove it is logged without discarding a finished analysis. At start-up `main.ts` sweeps any `dora-checkout-*` directories a crash left behind.
- **Token.** The token travels only in the child process environment, as `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0` setting `http.extraHeader`. It is therefore absent from argv (which `ps` can show), from the clone URL and from the clone's `.git/config`. The child also runs with `GIT_CONFIG_NOSYSTEM=1` and `GIT_TERMINAL_PROMPT=0`, and every command sets `protocol.file.allow=never` and `http.followRedirects=false`, so a crafted URL or redirect cannot reach a local path or send the header to another host. No shell is involved. Errors from `execFile` quote the whole command line, so `GitCheckout` builds its own message from `stderr` and replaces both the token and its encoded form with `***` before the message can be stored or shown.
- **Input checks.** Branch names may not start with `-`, or contain whitespace or control characters, and the repository owner and name may not be `.` or `..`, so nothing supplied by a user can be read by git as an option or a path.
- **Analysis.** `LizardAnalyser` (`apps/api/src/infrastructure/lizard/lizard-analyser.ts`) implements the `CodeAnalyser` port by running `lizard --csv` inside the clone, excluding `node_modules`, `vendor`, `dist`, `build` and minified files. It reads more than 25 languages and reports CCN, NLOC and parameter count for every function. The CSV parser is a pure function, tested without spawning a process, and skips malformed rows rather than failing the analysis.
- **Limits.** Each external process has a timeout and is killed with SIGKILL when it is exceeded, at 5 minutes for the clone, 60 seconds for `ls-remote` and 10 minutes for lizard. Lizard output is capped at 64 MiB, and a larger result is reported as a repository that is too large to analyse.
- **Skipping unchanged code.** Before cloning, `git ls-remote` reads the branch head. When it equals the commit of the last successful snapshot the crawl skips the clone and stores nothing new. A full crawl always analyses again, and a failure to read the head falls back to analysing.
- **Optional dependency.** lizard (`uv tool install lizard` or `pipx install lizard`; the README lists macOS and Windows commands) and the `git` binary are external tools rather than npm packages. `available()` asks lizard for its version, and when it is missing the snapshot records an instruction to install it. `CODE_ANALYSIS=off` switches the feature off entirely.
- **Failure never fails the crawl.** `CodeHealthService` catches every analysis problem (missing lizard, a clone that fails, a timeout, a parse error), logs it and stores it on the snapshot as `error`. `CrawlService` also guards the call, so the pull request and deploy figures are saved and the crawl finishes as normal.
- **Reporting.** The report serves the last successful snapshot, with a `lastError` field when a newer attempt failed, so one bad crawl does not hide figures that are still true. Only a repository that has never been analysed successfully returns the error on its own.
- **Thresholds.** A function with a CCN above 10 is counted as worth a look and above 20 as hard to test and to change safely, following the bands commonly attributed to McCabe's original guidance. They are the defaults of `codeHealth` in `packages/core/src/codeHealth.ts` and are passed in, so a future setting does not touch the metric.
- **Storage.** Snapshots go in a `code_snapshots` table keyed by repository and analysis time. The newest 10 are kept, always including the newest successful one, which leaves room for a trend without a schema change and stops a run of failures erasing the last real figures.

Alternatives considered:

- **A TypeScript AST walker.** It would add no external tool, but it would cover only the languages we write a walker for, and every language added later would be new code to maintain and test. lizard already covers the common ones.
- **Importing from SonarQube or Codecov.** Both give richer results, but they require a server or a paid account per team, a separate credential, and a pipeline that already runs them. That is a poor fit for a self-hosted tool pointed at any repository, and their definitions would differ from one setup to the next.
- **Reading files through the GitHub API.** This needs a request per file, is quickly rate limited on large repositories, and cannot cope with a tree that is not small.

The new port pair follows ADR 0003, and only `main.ts` names the concrete adapters.

## Consequences

### Positive

- Code complexity sits beside flow and DORA figures for any repository the token can read, in every language lizard supports.
- Source is held only for the length of an analysis, and nothing is sent to a third party.
- A missing tool or a failed clone degrades one section of the page and leaves the rest untouched.
- Keeping the newest 10 snapshots makes a trend chart a later, additive change.

### Negative

- Every crawl now includes a clone and an analysis, which adds time that grows with repository size, up to the timeouts above. Only a branch that has not moved skips the work, and there is no incremental analysis of a changed branch.
- The host needs `git` and, for this feature, Python with lizard installed, which is a step the rest of the tool does not ask for.
- The view is a single point in time at the tip of the deploy branch, with no trend yet, and it says nothing about test coverage or code that has since changed.
- CCN counts paths through a function and is a proxy for risk, not a measure of quality. Generated code that is not in an excluded directory will inflate the figures.
