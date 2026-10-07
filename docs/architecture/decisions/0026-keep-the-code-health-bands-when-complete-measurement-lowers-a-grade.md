# 26. Keep the code health bands when complete measurement lowers a grade

Date: 2026-10-07

## Status

Accepted

## Context

The first analysis after ADR 0025, of a private React and TypeScript repository at the same commit lizard had last measured, moved maintainability from high to medium with no change to the code. A reader will ask whether the syntax tree analyser counts more harshly and the bands should be loosened to match. Comparing the two stored snapshots of that commit with core's `codeHealth` shows the opposite, because lizard had been leaving much of the code out.

## Decision

The maintainability bands stay as ADR 0013 set them (`MAINTAINABILITY_LIMITS` in `packages/core/src/codeGrade.ts`), and the lower grade stands. The two snapshots of that commit gave these source figures.

| Figure                      | Lizard | Syntax tree |
| --------------------------- | ------ | ----------- |
| Functions                   | 4,877  | 5,510       |
| NLOC inside functions       | 54,196 | 96,724      |
| Functions above CCN 20      | 6      | 22          |
| Lines above CCN 10          | 8.8%   | 11.2%       |
| Lines above CCN 20          | 0.7%   | 4.7%        |
| Functions over 60 NLOC      | 2.2%   | 3.1%        |
| Functions over 5 parameters | 1.8%   | 1.9%        |

- Lizard's functions held 42,528 fewer lines, 44% of what the syntax tree counts.
- Of the ten most complex functions, lizard reported five under no matching name, the largest (CCN 67 over 494 lines) in a file where it found no function at all. It cut the other five short, at CCN 1 to 13 over 11 to 79 lines against 32 to 47 over 180 to 481.
- Lizard had flagged 171 files as possibly partly measured, and the syntax tree flagged none.
- Three checks crossed the high band's limits of 10%, 3% and 3%. The parameter share, the one figure that the counting differences ADR 0025 chose on purpose would raise, moved by 0.1 points, so those differences did not cause the drop.

Figures from snapshot version 5 are not compared with version 4 for JavaScript and TypeScript. When a grade moves after an analyser change, compare two stored snapshots of the same commit with `codeHealth` before concluding that the code changed. The `code_snapshots` table keeps the last 10 per repository. Loosening the bands was rejected because it would grade every repository against limits that suited lizard's omissions, and keeping lizard's figures beside the new ones was rejected because it would carry a number known to be wrong.

## Consequences

### Positive

- Grades for JavaScript and TypeScript cover all of the code, and the largest components, which lizard hid, now lead the hotspots and the advice on where to start.
- One set of limits applies before and after the change, so a band means the same thing for every repository.

### Negative

- Teams see a lower grade on the next crawl with no change to their code, which the README has to explain, and every repository analysed before ADR 0025 can move the same way.
- The evidence is one repository, so the size of the drop elsewhere is unknown until each is analysed again.
- The comparison is done by hand, since there is no command for it.
