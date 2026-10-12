# 32. Read workflow, dependency and container facts from the clone

Date: 2026-10-11

## Status

Accepted

## Context

Several security signals need no GitHub feature and no payment, because they are written in the repository itself. They include how workflows pin and permission their actions, whether a privileged trigger checks out a pull request's code, which lockfiles exist, and how Dockerfiles choose their images. Code health already takes a shallow clone of the deploy branch (ADR 0011) and reads it without executing anything (ADR 0013), so the same clone can supply these facts at almost no extra cost.

## Decision

**A hook on the existing clone.** `CodeHealthService` takes an optional `CloneInspector` with `isStale` and `inspect`. The service lists the clone once and shares that listing, and runs the inspector in its own try and catch before analysis, so a failure in one never costs the other. The inspector also runs when the analyser cannot be found, because these facts need no analyser. When the head has not moved, `inspectIfStale` tries a failing inspection twice in all for one head in one process, and then not again until the head moves or the API restarts. A crawl that analyses the code inspects the clone whatever that count says. A failed inspection is recorded beside the facts, in the `supply_chain_failure` table, with a message that names no path or address, and the report carries it as `supplyChainFailure` with the time of the attempt, so the page can say that the facts are older than the code. A good inspection clears it, and a stored record that cannot be read counts as stale, so the next inspection writes it again, and asking whether it is stale never fails the analysis. `SupplyChainService` implements the hook and stores its facts and the public packages separately from code snapshots. Code health output is unchanged for the same commit, which a test asserts.

**Versioned apart from code snapshots.** `SUPPLY_CHAIN_VERSION` in `packages/core/src/securityTypes.ts` (now 3) is raised when what is read from the clone changes. The inspector is stale when there is no row, the version differs or the commit differs. When the branch head has not moved but the facts are stale, the clone is made once and inspected without analysing it and without a new code snapshot, so a repository is not analysed again for a change that touches only these facts.

**Nothing executed.** Everything is read as text, as in ADR 0013. Key-like files such as `.env`, `id_rsa` and `*.p12` are matched by name only and never opened.

**No new dependency.** Workflows and Dockerfiles are scanned line by line with attention to indentation, as `codeTooling.ts` already does for configuration, and no YAML parser is added. A composite action or reusable workflow is read with the triggers of the workflows in the repository that call it by local path. What is found covers `uses:` pinning, permissions, privileged triggers with a pull request head checkout, untrusted text in `run` steps, security tools run in CI, update configuration, security policy files, manifests without lockfiles and Dockerfile habits.

**Caps.** At most 500 workflow files of 256 KiB each, lines cut at 2,000 characters, 50 Dockerfiles of 256 KiB, 100 Makefiles and `package.json` files of 256 KiB for finding tools, and lockfiles of 16 MiB each, 64 MiB in total, 20 files and 20,000 packages. A file over its cap is skipped whole and never read in part. A lockfile past the first 20, over its size or past the total gets a summary marked unreadable in the stored facts, and the OSV lookup leaves its alerts as they were. The report neither counts nor lists unreadable lockfiles. Workflows and Dockerfiles that were not read are listed as unread. At most 2,000 findings of each risk and 10,000 action uses of each kind, pinned and unpinned counted apart, are kept from one file and again across the repository, and what the caps leave out is counted. The listing of the clone stops at 200,000 entries or 30 levels of depth, and an unreadable directory costs its own files, and this is stored as `listingComplete`. With an incomplete listing, no lockfile is treated as deleted and no manifest is reported as lacking a lockfile. A lockfile with more than 20,000 public packages is marked capped and keeps only the first 20,000. Script injection evidence is stored with its quoted strings blanked, so a literal such as a hardcoded token is never kept. Evidence kept for a finding is at most 200 characters and never a whole script.

**Public packages for OSV.** Lockfile parsing keeps only packages the lockfile proves came from a public registry, and stores them for the optional lookup in ADR 0034.

**Requires `CODE_ANALYSIS`.** With code analysis off no clone is made, so these facts are absent and the report says why rather than reporting them as clean.

## Consequences

### Positive

- Pinning, permissions, injection patterns and key files can be graded for every repository, including private ones with no paid GitHub product.
- The extra read adds no process, no dependency and no credential, and reuses the clone's limits.

### Negative

- Each repository is cloned once more after the upgrade, even where its code has not moved, and again whenever `SUPPLY_CHAIN_VERSION` is raised.
- Line scanning misses YAML anchors, aliases, generated workflows and unusual layouts, so a clean result means nothing was found and not that nothing is there.
- Text matching can mislead, for example a pattern inside a quoted string or a command that a `make` target never runs, and the page states findings as what was seen in the files.
- A file that is too large, or a repository past the caps, is skipped and reported as unread where the facts have a place for it. A tool that only a skipped Makefile or `package.json` runs is missed.

## Revision History

- 2026-10-12: Corrected the caps to skip whole files, listed what is reported as unread, and recorded that the inspector runs without the analyser and that a failing inspection is retried at most twice for a head.
- 2026-10-12: Corrected the location of `SUPPLY_CHAIN_VERSION` and raised it to 2, stated the two attempts for an inspection as a limit that applies only when the head has not moved, recorded the stored inspection failure, and corrected what is reported as unread, which is workflows and Dockerfiles and not lockfiles. CODEOWNERS files are not read (ADR 0033, ADR 0036).
- 2026-10-12: Recorded `listingComplete` and what an incomplete listing withholds.
- 2026-10-12: Raised `SUPPLY_CHAIN_VERSION` to 3. Findings are capped for each risk and action uses for each kind, from one file and across the repository, with counts of what was left out, so advice can no longer crowd out a graded finding. Composite actions and reusable workflows take on the triggers of the workflows that call them by local path. Facts stored without `listingComplete` are no longer read, since the version check refuses them.
