# 30. Read measured coverage from CI artefacts, for display only

Date: 2026-10-10

## Status

Accepted

## Context

ADR 0013 grades testing from what a repository is set up to do and left measured coverage out, on the grounds that it would need a per-repository credential and a new external system. Reading it is now worth the cost, because the detailed code analysis (ADR 0029) can show which files and which complex functions no test runs. The assumption about credentials was wrong, since the token the crawl already holds can read a repository's Actions artefacts when it can read the repository, and the existing `repo` scope covers them. The remaining new system is the storage host that GitHub redirects an artefact download to.

## Decision

**Display only.** Coverage never enters `codeHealth` or `judge`, and a test asserts that the grade is identical with and without coverage stored. A figure that CI published says what ran and not whether the tests are good, and a grade that moved because a workflow was edited would break the rule in ADR 0026 that bands change only with the code or a more complete measurement.

**A port of its own.** `CoverageSource` (`apps/api/src/interfaces/coverage-source.ts`) has one adapter, `GitHubCoverageSource`, wired only in `main.ts` and `cli.ts` (ADR 0003). The adapter downloads and parses the archive and returns reports in core's shape, so no service imports infrastructure or sees a file format. The parsers live in `apps/api/src/infrastructure/coverage-reports/`, because the repository's ignore files and lint configuration skip any directory named `coverage`.

**Discovery.** The adapter pages `GET /repos/:owner/:name/actions/artifacts` at 100 per page, at most three pages, and keeps an artefact when all of these hold.

- Its name contains `coverage`, in any letter case.
- It has not expired.
- Its run was on the repository's deploy branch.
- Its run's head repository is the repository itself, which excludes forks, whose coverage the maintainers did not produce.

The result is newest first. There is no per-repository setting.

**Run choice.** `chooseCoverageRun` takes the newest run that built the analysed commit, or the newest run when none did, and returns all of that run's matching artefacts, at most five, so a matrix that uploads `coverage-api` and `coverage-web` keeps both. `CoverageService` reads on every crawl, apart from the clone skip, so coverage that CI finishes after a crawl is found by the next one even though the branch has not moved. It does nothing when no artefact is found, and it skips the read when the run, the artefact ids and the stored version are unchanged and the last read succeeded, unless the crawl is full. A failed read is stored as an error snapshot and logged, the last good snapshot stays the one the report uses, and the page shows both. Only `UnauthorisedError` is rethrown and fails the crawl, as in ADR 0028. Snapshots go in a `coverage_snapshots` table, which keeps the newest five and the newest successful one.

**Formats.** The reader recognises a file by its base name alone.

- lcov (`lcov.info`, `*.lcov`).
- Istanbul `coverage-final.json`, which has per-line detail.
- Istanbul `coverage-summary.json`, which has totals per file and no lines.
- Cobertura XML (`coverage.xml`, or a name containing `cobertura`, whose root has `line-rate=` and not `clover=`).

JaCoCo, Clover and Go coverage profiles are not read, and an archive with nothing readable is stored as an error that names the formats. When one directory holds several formats the best is kept in the order lcov, Istanbul final, Cobertura, Istanbul summary, and when several reports cover one file the most detailed wins.

**Path alignment.** `alignCoverage` in core maps the paths a report uses onto repository paths. Reports name files relative to a package or as absolute runner paths. The repository's files are indexed by every run of trailing segments, so a report path finds the files that share the most trailing segments with it by lookup, and a package full of files with the same name still offers the one whose directories also agree. Each path votes for the transform that adds a prefix or strips one so that it lands on those files. A path with more than 50 equally good matches says little by itself, so it votes last, and then only for the leading transforms that put it on a known file. The transform with the most votes is applied, ties go to the archive directory hint and then to the fewest segments added, and a path still unmatched falls back to a suffix match that must be unique, whose cost is bounded by the depth of the path. Cobertura `<source>` roots are joined first, and separators, `file://`, `./`, `..` and drive letters are normalised. Test files are dropped. Unmatched files are counted per artefact, report directory and path, because the same relative path in two reports can be two files, and a path that another report's layout places on a matched file is not counted as unmatched. The report states how many files it named, how many matched and how many did not.

**Caps.** An artefact larger than 50 MiB is not downloaded, and a download stops at that size whether the size is declared or only found while streaming, with a 120 second timeout. An archive is scanned for at most 5,000 entries (`MAX_ENTRIES_SCANNED`). One file may unzip to at most 64 MiB (`MAX_ENTRY_BYTES`), an XML file to at most 32 MiB (`MAX_XML_ENTRY_BYTES`, lower because the XML parser builds a tree several times the size of its input), and all files together to 192 MiB (`MAX_TOTAL_BYTES`). At most 1,000 line ranges are stored per file with the counts kept exact, and a report returns at most 20 ranges per file. The detail report caps least covered files at 50, files not in the report at 200 and untested complex functions at 100, each with its total.

**Security.** Archives come from CI and are not trusted.

- The token goes only to the API host. The download follows the redirect by hand, for one hop only, requires an `https` address, cancels the body of the redirect answer first and makes the second request with no `Authorization` header. No message carries the token or either address. A host allow-list for the storage host was considered and rejected, because GitHub's storage hosts change and an allow-list would break coverage without warning. The protection that matters is that the token never travels to the storage host.
- Only files chosen by base name are inflated, in memory, and nothing is written to disk. No message names a path from inside an archive.
- The zip reader (`read-coverage-archive.ts`) streams with fflate's `Unzip`, feeds the archive in 16 KiB chunks and yields to the event loop between groups of them. It counts the bytes each selected entry really produces and refuses the archive when an entry passes its cap, passes the size it declares, or ends with a different size from a declared size that is not zero, and when a declared size of zero meets real data. A truncated file is therefore never read as if it were whole. An entry written as a stream, with no declared size, is held to the per-file and total caps by the bytes it produces. Bytes that do not open with a zip entry and close with an end-of-central-directory record, which includes an archive cut short at its tail, are refused before unzipping.
- XML is parsed with entity processing off, and input containing a document type or entity declaration is refused before parsing.
- Raw report paths and the report directory inside the artefact are stored in SQLite with the coverage snapshot, which the aligner needs on every report, and they are never returned by the API. The API returns counts only, because a self-hosted runner path can hold a person's or a client's name.
- Parsing yields to the event loop between files.

**Dependencies.** `fflate` 0.8.3 reads the zip and `fast-xml-parser` 5.11.2 reads Cobertura. Both are installed in `apps/api` only, so core stays free of dependencies and the web bundle does not grow. They were chosen under ADR 0024 with `--min-release-age=7`, and neither has an install script. The alternative rejected for XML is a hand-written Cobertura scanner, which would avoid a dependency but would mean maintaining a parser for untrusted input, with its own entity and nesting hazards, for a format that is small but not trivial. Writing a zip reader by hand was not considered, because inflating untrusted data is better left to a maintained library.

**Egress and credentials.** The API now needs to reach GitHub's artefact storage host over https, the address of which comes from the redirect, as well as the API host. A fine-grained token needs read access to Actions on top of what pull requests and issues need, and a 403 that is not a rate limit is reported as exactly that. A GitHub error answer is echoed up to 300 characters in the stored coverage error, as it already is for other GitHub calls, and that is accepted. A classic token or the local `gh` login with the `repo` scope needs nothing more.

## Consequences

### Positive

- A reader can see what the tests run, which complex functions no test reaches and which source files a report leaves out, with no per-repository setup beyond uploading an artefact.
- The grade is unchanged by whether coverage is published, so repositories stay comparable.
- A failing or missing coverage read costs one panel and never the crawl, apart from a rejected credential.

### Negative

- Coverage appears only for repositories whose CI uploads an artefact named for it from the deploy branch. Artefacts expire (90 days by default on GitHub), so the figures can go stale and the page then says which commit they describe.
- A token that lacks Actions read access shows a coverage error until it is granted, and a firewall that blocks the storage host does the same.
- Unzipping still runs on the API's thread. It yields between groups of chunks, but one chunk can inflate to several megabytes, so an archive near the limits slows other requests for a moment. A worker thread is the remedy if that matters.
- Reports are held in memory whole, up to the caps, before they are parsed, so one artefact near the limits can take a few hundred megabytes briefly.
- Raw report paths sit in the local SQLite file, so the database is as sensitive as the repository it describes.
- The storage host is not restricted by name, so a redirect to any https address is followed once without the token.
- Alignment is a vote, so a report that covers several packages with clashing file names can be mapped wrongly. The matched and unmatched counts make a poor alignment visible, but a wrong figure remains possible.
- JaCoCo, Clover and Go profiles are not read, so Java, Kotlin and Go repositories need a Cobertura or lcov export.
- Two more runtime dependencies, with their own update stream.
