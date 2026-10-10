# 30. Read measured coverage from CI artefacts, for display only

Date: 2026-10-10

## Status

Accepted

## Context

ADR 0013 graded testing from what a repository is set up to do and left measured coverage out, on the grounds that it would need a per-repository credential and a new external system. Reading it is now worth the cost, because the detailed code analysis (ADR 0029) can show which files and complex functions no test runs. The credential assumption was partly wrong. The token the crawl holds can read a repository's Actions artefacts when it can read the repository, although a fine-grained token also needs read access to Actions. The new external system is the storage host that GitHub redirects an artefact download to. The caps, merge rules and alignment procedure behind these choices are in `docs/metrics.md`.

## Decision

**Display only.** Coverage never enters `codeHealth` or `judge`, and a test asserts that the grade is identical with and without coverage stored. A figure that CI published says what ran and not whether the tests are good, and a grade that moved because a workflow was edited would break the rule in ADR 0026 that bands change only with the code or a more complete measurement.

**A port of its own.** `CoverageSource` (`apps/api/src/interfaces/coverage-source.ts`) has one adapter, `GitHubCoverageSource`, wired only in `main.ts` and `cli.ts` (ADR 0003). The adapter downloads and parses the archive and returns reports in core's shape, so no service sees a file format. The parsers live in `apps/api/src/infrastructure/coverage-reports/`, because the ignore files and lint configuration skip any directory named `coverage`.

**Discovery and schedule.** The adapter searches the newest 300 artefacts of any name and branch and keeps those named for coverage, unexpired, from a run on the deploy branch of the repository itself, which excludes forks. When nothing from the deploy branch is among them, a failure saying so is stored and logged, because older coverage may lie beyond the limit. When a complete search finds nothing, an earlier failure is cleared so that it is not shown as current. `CoverageService` reads on every crawl while code analysis is on, whether or not the clone is skipped, so coverage that CI finishes later is found by the next crawl, and with `CODE_ANALYSIS=off` nothing is read. It skips a read when the run, artefact ids and stored version are unchanged and the last read succeeded, unless the crawl is full. Only `UnauthorisedError` fails the crawl (ADR 0028). Snapshots go in a `coverage_snapshots` table that keeps the newest five and the newest successful one, with a column that records failure so that finding them reads no snapshot JSON.

**Run choice.** `chooseCoverageRun` takes the newest run that built the analysed commit, otherwise the newest run, and reads up to five of its artefacts, so a matrix that uploads `coverage-api` and `coverage-web` keeps both. The page says how many of the run's artefacts were read when it had more.

**Partial reads.** A coverage file that cannot be parsed is left out and counted, and the rest of the artefact is kept. A failure is stored only when nothing was readable, with a message that tells an unreadable file, a file that lists no files and no recognised file apart. After a failed read the last good snapshot stays the one the report uses, and the page shows both.

**Formats.** Files are picked by base name, as lcov, Istanbul (`coverage-final.json` and `coverage-summary.json`) or Cobertura XML. JaCoCo, Clover and Go profiles are not read.

**Merging and trust.** When several reports cover one file, their line ranges are joined where both sides have them, so a matrix of unit and integration jobs does not understate coverage. Counts that are impossible are dropped, a share of 0 of 0 is absent and never 0%, and a file whose ranges would be too many keeps only exact totals, so per-function coverage for it is unknown and never wrong.

**Path alignment.** `alignCoverage` in core maps report paths onto repository paths by a vote on one prefix transform per report, with a unique suffix match as the fallback. A name shared by many files never places a path on its own, because it would put figures on an arbitrary package, so such a path is left unmatched and counted. The page never shows unmatched paths.

**Security.** Archives come from CI and are not trusted.

- The token goes only to the API host. The download follows GitHub's redirect by hand, requires https and refuses a redirect to localhost or to a loopback, private, shared, link-local, site-local or unspecified IP literal, including one carried inside a NAT64, 6to4 or IPv4-mapped IPv6 address. The second request carries no `Authorization` header. A host allow-list was rejected, because GitHub's storage hosts change and the list would break coverage without warning.
- Only files chosen by base name are inflated, in memory, under caps on the download, the entries scanned and the unzipped size. The zip reader counts the bytes each entry really produces and refuses a truncated or inconsistent archive. No message carries the token, an address or a path from inside an archive.
- XML is validated before parsing, so a truncated report is refused. An external DOCTYPE, which Istanbul, Vitest, Jest, nyc and Java Cobertura write, is read. A DOCTYPE with an internal subset, or any ENTITY, is refused, entities are never expanded and no DTD is fetched.
- Raw report paths are stored in SQLite, because the aligner needs them on every report, and the API returns counts only, because a runner path can hold a person's or a client's name.
- Each coverage file is parsed in one synchronous step. The yields between files and between archive chunks keep the event loop free between files and not within one.

**Dependencies and egress.** `fflate` 0.8.3 reads the zip and `fast-xml-parser` 5.11.2 reads Cobertura. Both are installed in `apps/api` only, were chosen under ADR 0024 with `--min-release-age=7`, and add nine packages to the lockfile, because `fast-xml-parser` brings seven of its own, none with an install script. A hand-written Cobertura scanner was rejected, because maintaining a parser for untrusted input costs more than the dependency. The API now also reaches the storage host over https. Only a 403 whose body says "Resource not accessible by" is reported as a missing Actions permission, and other 403s keep GitHub's message, echoed to 300 characters.

## Consequences

### Positive

- A reader can see what the tests run, which complex functions no test reaches and which files a report leaves out, with no setup beyond uploading an artefact.
- The grade does not depend on whether coverage is published, so repositories stay comparable.
- A missing or failing read costs one panel and never the crawl, apart from a rejected credential, and an unreadable file costs only itself.

### Negative

- Coverage appears only for repositories whose CI uploads a coverage artefact from the deploy branch within the newest 300. Artefacts expire (90 days by default), so figures can go stale, and the page says which commit they describe.
- A token without Actions read access, or a firewall that blocks the storage host, shows a coverage error.
- Parsing runs on the API's thread and holds a report in memory whole, so an artefact near the caps slows other requests briefly and can take a few hundred megabytes. A worker thread is the remedy if that matters.
- Raw report paths sit in the local SQLite file, so the database is as sensitive as the repository it describes.
- The storage host is not restricted by name, so a redirect to any public https address is followed once without the token.
- Alignment is a vote, so a report covering several packages with clashing file names can be mapped wrongly or left unmatched. The counts make this visible, but a wrong figure remains possible.
- Java, Kotlin and Go repositories need a Cobertura or lcov export, and the two new dependencies have their own update stream.
