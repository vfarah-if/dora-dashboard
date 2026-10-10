# 29. Break code analysis down by area

Date: 2026-10-10

## Status

Accepted

## Context

Code health reported a repository as one unit and listed only its ten worst functions, so a monorepo with a tidy package and a tangled one averaged out to a middling figure. A reader who wants to know where to start needs the same figures broken down by the parts people recognise, which are the packages of a monorepo and the top-level source folders of anything else. Version 5 snapshots hold no end line, no file list and nothing about the layout, so areas could not be decided and a function's lines could not be matched to a coverage report (ADR 0030).

## Decision

**Snapshot version 6.** `CODE_SNAPSHOT_VERSION` is 6 and a snapshot gains three things, all optional so that older snapshots stay readable.

- `FunctionMetrics.endLine`, set by both analysers (ADR 0025 for JavaScript and TypeScript, and the lizard adapter for the rest).
- `CodeSnapshot.files`, every code file in the clone's listing with tests included, sorted and capped at 200,000.
- `CodeSnapshot.layout`, which holds `manifests` (the paths of manifest files, capped at 20,000) and `workspaces` (the patterns the root declares, or null). `CodeHealthService.readClone` lists the clone once, reads the tooling candidates and the root `package.json`, `pnpm-workspace.yaml` and `lerna.json` at 256 KiB each, and returns all three results together. If the listing fails, `files` and `layout` are left out and the figures are still stored. The `CodeAnalyser` port is unchanged.

**Areas are decided in core, on request.** `codeAreas(files, layout)` in `packages/core/src/codeAreas.ts` is pure and runs over the stored file list whenever a report is built, so changing a rule changes every stored report without a crawl. The rules, in order, are as follows.

1. A candidate is the directory of a manifest (`isManifest` in `codeLayout.ts`, whose list of manifest names is in `docs/metrics.md`). The repository root, a test or fixture directory itself or any directory inside one, and any directory with no code file at any depth below it are not candidates.
2. When the root declares workspaces, the candidates that match a positive pattern and no `!` pattern, reduced to their outermost directories as in rule 3, become areas of kind `workspace`. Brace patterns are not supported. If no candidate matches, the next rule applies.
3. Otherwise the outermost candidates are taken, so a manifest inside a package does not become an area of its own. Two or more make the areas, again of kind `workspace`, which covers polyglot monorepos and Cargo, Go and Gradle layouts without a parser for each. A single candidate, such as a `docs/package.json`, is not enough.
4. Otherwise the repository is in folder mode, which looks at source files only (code files that are not tests and not under fixture directories). It starts at `src/` when any source file is under it and at the root otherwise. It descends into the child that holds the most source files while that child holds at least 80% of the source below the current directory, for at most 10 levels, and it stops before a child none of whose subdirectories holds a source file. Each child directory of the final directory becomes an area of kind `folder`.
5. Every file that is in no area is grouped under its top-level folder as an area of kind `folder`, and files at the root form an area named `.` of kind `root`. Every file therefore belongs to exactly one area, by the longest `path/` prefix.
6. The mode `unknown` means the snapshot has no file list, because it predates version 6 or its listing failed. The paths of its functions and partly measured files stand in for the list and the folder rules run. A full re-crawl or a new commit finds the workspaces.

**The areas chart.** `AreaSummary.nlocAboveWarn` is the source NLOC in functions above the warning threshold, and the area chart shows it, so an area is measured by how much code is complex and not by how many functions are.

**An area has a maintainability band and no overall grade.** Tests often live outside the area they test, and CI, linting and formatting are configured for the whole repository, so testing and hygiene scored for one folder would be wrong in a way that looks precise. `AreaSummary` carries only the maintainability band, computed by `codeFigures` over the area's functions, and an area with no source function has none. The overall grade is still the whole repository's (ADR 0013).

**Thresholds in the report.** `CodeHealthReport` carries `thresholds`, so the web app keeps no copy of the limits (ADR 0013).

**One re-clone.** Raising the version means every repository is analysed again on its next crawl even when its branch has not moved, as happened at version 5 (ADR 0025).

**Two steps in core.** `prepareCodeDetail(snapshot, coverage, thresholds)` does the expensive work, which is the areas, the alignment of coverage and the groupings, and `codeDetail(prepared, { area, lastError })` builds the view for one area. `CodeDetailService` keeps an in-process memo of prepared results, for eight repositories at most and keyed by the newest and newest successful snapshots, so switching area does not parse the snapshots again. Nothing is persisted, so a restart empties the memo.

**Where it is served.** `GET /api/repos/:id/code-detail?area=` returns the report (`codeDetail` in `packages/core/src/codeDetail.ts`), which the page at `/repos/:id/code` shows. An `area` that is not one of the report's areas falls back to the whole repository and the report says so. Lists are capped (300 areas, 500 functions) and each carries its total.

## Consequences

### Positive

- A reader can see which package or folder holds the complex code, and scope every figure to it, with the same definitions as the repository page.
- Rules for areas can improve without a re-crawl, because only the file list and layout are stored.
- A new ecosystem usually needs no new code, because its members have manifests and rule 3 finds them.
- Function end lines allow per-function coverage and the list of complex functions that no test runs (ADR 0030).

### Negative

- The memo holds up to eight prepared analyses in memory, each as large as a snapshot's file list and coverage.
- Every repository is cloned and analysed once more after upgrading.
- The file list enlarges each code snapshot, and with the newest 10 kept a very large repository can hold up to 200,000 paths ten times over.
- The rules are heuristics. A repository that keeps its packages under a directory with no manifests, or declares workspaces with brace patterns, falls through to folder mode and may be broken down differently from how its team thinks of it.
- Workspace patterns come from `package.json` and `lerna.json` as JSON and from `pnpm-workspace.yaml` by a bounded line reader, so an unusual YAML layout in that file can be missed.
- A snapshot without a file list shows areas guessed from folder names until a full re-crawl or a new commit, and one from before version 6 has no `endLine`, so its functions show no coverage.
