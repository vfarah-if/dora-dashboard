# 15. Advise where to start simplifying and flag partly measured files

Date: 2026-09-30

## Status

Accepted

## Context

The code health grade of ADR 0013 says which band maintainability is in and which check holds it back, but it leaves the reader to work out which functions to change. Because two of the four checks weigh lines inside complex functions, the functions with the highest complexity are not always the ones that move a band. Before df4bb67 the ranking on this repository named the most complex functions without saying which of them mattered, and a hand analysis showed that simplifying `RepoRow`, `CodeHealthReportView` and `buildReport` (266 lines) was the path from medium to high, which is what the advice now computes.

Building the advice also showed that lizard silently drops functions in files containing JSX spread attributes. Adding `<div {...props}>` to a file removes the enclosing function and the one after it from lizard's output, without any error, so the figures can read better than the code is.

## Decision

The report gains advice that uses the figures and limits of ADR 0013, and none of it changes a band.

- **Next band.** `nextBand` in `packages/core/src/codeAdvice.ts` returns a short list of functions to simplify for maintainability to reach the band above its current one, or null when it is already elite or there is no source. Each check is taken in turn (lines above CCN 20, lines above CCN 10, long functions, many parameters) and offenders are picked until the share falls below the next band's limit: largest first by NLOC for the two checks over lines, and those failing the most checks first for the two checks over functions, since each of those picks removes one function whatever its size. The CCN 20 check goes first, so that functions it needs also count towards the CCN 10 check. A picked function is assumed to end up within every limit and total source size is assumed not to change, so the list is a floor on the work and not a promise.
- **Hotspot shapes.** Each hotspot carries a shape that decides the kind of change that helps, and these are conventions of this project. A function within the CCN 10 and 60 line limits has no shape. Otherwise a capitalised function in a `.tsx` or `.jsx` file is a `component`, a function with at least 0.5 CCN per line is `dense`, one of 40 lines or more is `long`, and the rest are `branching`. Parameters are left out of the shapes because a long parameter list calls for an options object whatever the body looks like. Each hotspot also carries its `lineShare` of source NLOC and whether it is on the path to the next band.
- **Partly measured files.** `CodeAnalyser.analyse` now returns a `CodeAnalysis` holding the functions and a `partlyMeasured` list. `LizardAnalyser` reads each `.tsx` and `.jsx` file through the existing `WorkspaceReader` (up to 2 MiB) and flags those for which `hasJsxSpread` is true. The snapshot stores the list and the report shows it, with test files filtered out. `CODE_SNAPSHOT_VERSION` is now 4, so older snapshots are analysed again as described in ADR 0013.
- **Limits of the heuristic.** `hasJsxSpread` is a text match on `{...` after comments and strings are blanked, and it is not a parser.
  - It excludes a spread that follows `=`, `(`, `[`, `,`, `:`, `?`, `{`, `&`, `|`, `;`, `=>`, `return`, `default` or `yield`, and treats any other as JSX.
  - It can flag a file wrongly when an object spread follows an identifier or keyword it does not know. Destructuring after `const`, `let` or `var` is recognised and not flagged.
  - It can miss a JSX spread that follows one of the excluded characters, and it does not look at `.ts`, `.js` or other extensions.
  - Quotes are assumed not to span lines except in template literals, so an unbalanced quote in JSX text is contained to its line, and a string that genuinely spans lines may be misread.
  - It names the file and not the missing functions, and files above 2 MiB are not checked.
- **Alternatives considered.** A TypeScript-aware complexity tool would measure such files fully, but it would be a new dependency for one language and would replace lizard's coverage of more than 25 languages. An explanation written by an LLM would be a new external system that needs a credential and sends source code out, and its output would not be deterministic, whereas every figure here can be tested with hand-computed expectations.

## Consequences

### Positive

- The reader is told which few functions to change first, and the advice is computed from the same figures as the grade, so it cannot disagree with it.
- A file that lizard may have read only in part is named, so a good figure is not trusted blindly.
- No new dependency, external system or credential, and all of it is pure and tested in core.

### Negative

- The list is a floor. Changes that add lines elsewhere, or a picked function that stays above a limit, need more work than it suggests.
- Shapes and their limits are our own convention and a function on the boundary can reasonably be argued to fit another shape. The `dense` advice also concedes that part of such a score is how the analyser counts.
- The heuristic has both false positives and false negatives, so the notice is a prompt to look and not a finding.
- Functions lizard drops stay unmeasured. The notice warns about the gap without closing it.
- Older snapshots are analysed again after an upgrade, which costs one clone and analysis per repository.
