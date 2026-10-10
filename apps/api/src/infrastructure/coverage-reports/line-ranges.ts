import type { CoverageCount, LineRange, LineRanges } from "@dora-dashboard/core";

/** The most ranges kept in each list for one file. The counts stay exact however many runs the file has. */
export const MAX_RANGES_PER_FILE = 1_000;

/**
 * Joins ascending, distinct line numbers into runs of consecutive lines. Returns null as soon as there would be more
 * than `MAX_RANGES_PER_FILE` runs, so a file full of tiny runs costs no more than the cap to examine.
 */
function runsOf(lines: readonly number[]): LineRange[] | null {
  const ranges: LineRange[] = [];
  for (const line of lines) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === line - 1) last[1] = line;
    else if (ranges.length < MAX_RANGES_PER_FILE) ranges.push([line, line]);
    else return null;
  }
  return ranges;
}

/**
 * Turns the hit count of each instrumented line into its totals and into covered and uncovered ranges. A line the
 * report does not mention is in neither list, and no range joins across it, because only consecutive line numbers join.
 * Anything that is not a positive whole line number is ignored.
 *
 * When either list needs more than `MAX_RANGES_PER_FILE` runs, both are left out and only the exact counts are
 * returned. A list cut short would make the lines past the cut look untested (or tested) when the report says nothing
 * of the sort, so core is given all of the ranges or none of them.
 */
export function lineRanges(hits: ReadonlyMap<number, number>): { lines: CoverageCount; ranges?: LineRanges } {
  const covered: number[] = [];
  const uncovered: number[] = [];
  for (const [line, count] of [...hits].sort((a, b) => a[0] - b[0])) {
    if (!Number.isInteger(line) || line < 1) continue;
    (count > 0 ? covered : uncovered).push(line);
  }
  const lines = { covered: covered.length, total: covered.length + uncovered.length };
  const coveredRuns = runsOf(covered);
  const uncoveredRuns = runsOf(uncovered);
  return coveredRuns && uncoveredRuns ? { lines, ranges: { covered: coveredRuns, uncovered: uncoveredRuns } } : { lines };
}

/** Records a hit count for a line, keeping the highest when the line appears again (merged reports, several statements). */
export function addHit(hits: Map<number, number>, line: number, count: number): void {
  hits.set(line, Math.max(hits.get(line) ?? 0, count));
}
