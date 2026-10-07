# 27. Count cut pull requests that show tests, and leave tool configuration out of source

Date: 2026-10-07

## Status

Accepted

## Context

The pull request check (ADR 0013) asks what share of merged pull requests that change source also change a test file. This repository read 2 of 4, held at high, while its changes were tested. Its largest pull request changed 106 files, 31 of them tests, and was left out whole because GitHub lists only the first 100. Two others changed only `.ncurc.mjs`, the configuration of the dependency upgrade tool, which counted as source changed without tests because its extension is on the code list.

## Decision

`changesTests` in `packages/core/src/codeHealth.ts` follows two rules.

- **A cut list counts when it already proves the answer.** A pull request whose file list stops at 100 counts as changing tests when the listed files include both a source file and a test file, because the files left off can add a test but cannot remove one. When the listed files show source and no test, or no source, it is still left out, since a later file could change the verdict.
- **A tool's configuration is not source.** `isToolConfig` in `packages/core/src/codeTooling.ts` names a file whose name starts with a dot, such as `.ncurc.mjs` or `.eslintrc.cjs`, or contains `.config.`, such as `vite.config.ts`. Such a file never makes a pull request count as changing source. A module named `config.ts` is still source. Only this check uses the rule. Maintainability still measures every function in these files.

Neither rule moves a band (ADR 0026). The grade is computed from stored pull requests when a report is asked for, so no new crawl is needed. With both rules this repository reads 3 of 3 (#8, #13 and #21), and with the first alone it reads 3 of 5.

## Consequences

### Positive

- A large pull request that brought its tests with it now counts, so the check no longer favours small changes as much as it did.
- Changing a linter, bundler or upgrade tool setting no longer reads as untested source.

### Negative

- The cut-list rule works in one direction only. A cut pull request can count as changing tests but never as untested, since source without a test in the first 100 files is still left out, so the rule can only raise the share. It is kept because leaving every cut pull request out biases the check the other way, towards small changes. Reading a cut pull request's full file list would remove the bias in both directions, at the cost of more requests per large pull request in the crawl, and is the better fix when it is needed.
- The configuration rule goes by file name. A product module named like configuration, such as `database.config.ts`, or a dot-file that holds real product code, stops counting as source. In the other direction, tool files named differently, such as `karma.conf.js`, `jest.setup.ts` or `Gruntfile.js`, scripts under a dot-directory, such as `.github/scripts/release.js`, and configuration in other forms, such as `setup.py` or `build.gradle.kts`, still count as source.
- This change raised this repository's own figure, which is how the faults were found, so a reader may suspect the grade was tuned. Each rule stands on its own argument, and the counts above are given so they can be checked.

## Revision History

- 2026-10-07: the fix named in the first negative is done. `GitHubProvider` in `apps/api/src/infrastructure/github/github-provider.ts` now reads a pull request's whole file list, 100 paths per request after the first page and one pull request at a time, until it holds about 3000, the most GitHub's REST API lists. A pull request is marked cut only when fewer paths were read than GitHub's total, so the cut-list rule now applies only past about 3000 files, or when a file request fails upstream part way, in which case the paths already read are kept rather than the page failing. A refused credential or a repository gone from view still fails the page. Reading costs one more GraphQL request per 100 files beyond the first 100, so up to 29 for each large pull request on a page. Pull requests crawled before keep their first 100 paths until a full crawl reads them again.
