# 25. Measure JavaScript and TypeScript from a syntax tree

Date: 2026-10-07

## Status

Accepted

## Context

Lizard reads source with a tokeniser and no grammar, so it loses function boundaries when a TypeScript construct looks like something else. Run over this repository, lizard 1.24 found 4,102 functions where a syntax tree finds 4,527, reported 0 parameters for 993 arrow functions, ended `hoursBetween` in `packages/core/src/stats.ts` early (apparently reading a `/` as a regular expression) so that its CCN was 3 rather than 4, and gave `stageMeans` in `packages/core/src/report.ts` 19 lines against a true 9. ADR 0015 answered part of this with a text heuristic that flagged files holding a JSX spread attribute, which names a file and not the missing functions, and the evidence shows the problem is wider than JSX spread.

## Decision

JavaScript and TypeScript are measured in process from a syntax tree built by `@babel/parser` 7.29, and every other language still goes through lizard. `docs/metrics.md` holds the measurement rules, in one place, and this record does not repeat them.

- `BabelAnalyser` (`apps/api/src/infrastructure/babel/babel-analyser.ts`) measures `.ts .tsx .mts .cts .js .jsx .mjs .cjs` files from the listing of the clone, skipping declaration and minified files, and stops after 10 minutes. `measureSource` (`apps/api/src/infrastructure/babel/measure-source.ts`) is the pure function that parses one file. A file read only in part is listed in `partlyMeasured` and logged once at info with a reason for each.
- A file is parsed with legacy decorators first, then with standard decorators if errors remain and the file holds an `@`, then as a `script` if errors remain, and the reading with the fewest errors is kept. A file with errors can therefore be parsed three times, which costs about a second at the 2 MiB limit.
- Flow annotations are read in any `.js`, `.jsx`, `.mjs` or `.cjs` file. The `@flow` pragma only decides syntax that standard JavaScript reads differently, such as `f<T>(x)`.
- The `CodeAnalyser` port has `analyse`, `measures(path)` and `reach()`, which returns `"full"`, `"partial"` or `"none"` and rejects when finding out fails for any reason other than the tool being missing. `analyse` rejects with `AnalyserMissingError` when its tool cannot be found, so the combined analyser learns this from the run itself and lizard is started once per analysis rather than probed again.
- `CombinedAnalyser` (`apps/api/src/infrastructure/analysis/combined-analyser.ts`) takes `{ scripts, others, reader }` and enforces the split itself, keeping the script analyser's results only for files it measures and the other analyser's only for the rest. `createCodeAnalyser` builds it for `main.ts` and `cli.ts`, giving lizard the script extensions as skip globs.
- A lizard that is not found (`ENOENT`) no longer fails the analysis. The scripts are still measured, and the files lizard would have read, judged by `LIZARD_EXTENSIONS` and test files included, are counted as `unmeasuredFiles` for the page to explain. `LIZARD_EXTENSIONS` lists the 55 extensions of lizard 1.24.0 and must be revisited when lizard is upgraded.
- A lizard that is found but does not run, or times out, still fails the whole analysis as ADR 0011 decided. Such a failure is usually passing, and the last complete figures shown beside the reason read truer than a new snapshot graded over only some of the languages. When both analysers fail, the message joins both.
- `CodeHealthService` analyses a snapshot with unmeasured files again at the same commit once `reach()` is `"full"`, so installing lizard and crawling again works, while the cached snapshot stands for as long as lizard is missing. The `analyser-missing` reason is no longer produced by the combined analyser and now mainly comes from snapshots stored before this change.
- The reader's limits of 200,000 entries and 30 directory levels now decide which scripts are measured, so `FsWorkspaceReader` logs a warning when a limit cuts a listing short.
- The JSX spread heuristic and its scan are removed. `CODE_SNAPSHOT_VERSION` is 5, so every repository is analysed again on its next crawl.

Babel 8 needs Node ^22.18 or 24.11 and above, and this repository's `engines` floor is 22.13, so the 7.29 line stays until the floor rises. The runtime dependencies are `@babel/parser` and `@babel/types`, which were already in the lock file.

Alternatives were weighed briefly. Keeping lizard with the heuristic costs nothing but leaves the lost boundaries. Cross-checking lizard against a tree needs a full parser as well, so it carries both costs. oxc-parser ships a native binary for each platform, which a tool installed with plain `npm install` should avoid. TypeScript 5.9, whose compiler API could parse in process, is installed at the root only as a development dependency for linting, so the API would need its own aliased runtime copy of it.

## Consequences

### Positive

- Function boundaries, lines, parameters and CCN for JavaScript and TypeScript come from a grammar, not from tokeniser accidents.
- A repository of JavaScript and TypeScript needs no Python tool, and a missing lizard is explained beside the figures instead of hiding them.

### Negative

- CCN has a second implementation to keep in step with lizard's by hand, and three counts differ from lizard on purpose, namely `??` and `??=`, the TypeScript `this` parameter, and the parameters of anonymous arrow functions. Lizard counts `a ?? b` twice and `a??b` once, whereas this analyser counts each once.
- `.vue` files still go through lizard and can still be misread, and a file mixing parameter decorators with standard decorator syntax is still read only in part.
- Parsing runs on the API's own thread, so one large file blocks it briefly and the deadline is checked only between files. A worker thread is the remedy if that matters.
- Figures from before and after this change are not comparable, and the Babel 7 dependency waits on the Node floor.
