import type { CoverageCount, LineRange } from "@dora-dashboard/core";

/** The most ranges kept in each list for one file. The counts stay exact however many ranges are dropped. */
export const MAX_RANGES_PER_FILE = 1_000;

export interface LineCoverage {
  lines: CoverageCount;
  covered: LineRange[];
  uncovered: LineRange[];
}

/** Joins ascending, distinct line numbers into runs of consecutive lines, keeping at most `MAX_RANGES_PER_FILE`. */
function runsOf(lines: readonly number[]): LineRange[] {
  const ranges: LineRange[] = [];
  for (const line of lines) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === line - 1) last[1] = line;
    else if (ranges.length < MAX_RANGES_PER_FILE) ranges.push([line, line]);
    else break;
  }
  return ranges;
}

/**
 * Turns the hit count of each instrumented line into its totals and into covered and uncovered ranges. Lines that
 * the report does not mention are neither: a comment between two covered lines splits no range, because only
 * consecutive line numbers join. Anything that is not a positive whole line number is ignored.
 */
export function lineRanges(hits: ReadonlyMap<number, number>): LineCoverage {
  const covered: number[] = [];
  const uncovered: number[] = [];
  for (const [line, count] of [...hits].sort((a, b) => a[0] - b[0])) {
    if (!Number.isInteger(line) || line < 1) continue;
    (count > 0 ? covered : uncovered).push(line);
  }
  return {
    lines: { covered: covered.length, total: covered.length + uncovered.length },
    covered: runsOf(covered),
    uncovered: runsOf(uncovered),
  };
}

/** Records a hit count for a line, keeping the highest when the line appears again (merged reports, several statements). */
export function addHit(hits: Map<number, number>, line: number, count: number): void {
  hits.set(line, Math.max(hits.get(line) ?? 0, count));
}
