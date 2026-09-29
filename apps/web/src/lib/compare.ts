import type { WeekRow } from "@dora-dashboard/core";

/**
 * Pure transforms that turn several repositories' weekly rows into chart rows. Each output row carries an
 * `x` (a calendar week or a week index) and one field per series key, null where that repository has no
 * row for that x. Kept free of React so every rule here can be tested directly.
 */

export interface WeeklySeries {
  key: string;
  weekly: readonly WeekRow[];
}

export type ChartRow = { x: string | number } & Record<string, number | string | null>;

export interface MergeOptions {
  /** Align on weeks since each project's first pull request rather than calendar week. */
  aligned: boolean;
  value: (row: WeekRow) => number | null;
}

export interface MergeResult {
  rows: ChartRow[];
  /** When aligned, the number of weeks every series was clipped to; null in calendar mode. */
  clippedTo: number | null;
}

/**
 * The number of weeks of history the shortest series has, counted from its project start. Rows before
 * project start (negative index) do not count. Returns 0 when any series has no history at all.
 */
export function shortestHistory(series: readonly WeeklySeries[]): number {
  if (series.length === 0) return 0;
  return Math.min(
    ...series.map((s) => {
      const indices = s.weekly.map((w) => w.weekIndex).filter((i) => i >= 0);
      return indices.length ? Math.max(...indices) + 1 : 0;
    }),
  );
}

export function mergeWeekly(series: readonly WeeklySeries[], options: MergeOptions): MergeResult {
  if (options.aligned) {
    const limit = shortestHistory(series);
    const first = Math.min(
      ...series.flatMap((s) => s.weekly.filter((w) => w.weekIndex >= 0 && w.weekIndex < limit).map((w) => w.weekIndex)),
      limit,
    );
    const rows: ChartRow[] = [];
    for (let index = first; index < limit; index += 1) {
      const row: ChartRow = { x: index };
      for (const s of series) {
        const week = s.weekly.find((w) => w.weekIndex === index);
        row[s.key] = week ? options.value(week) : null;
      }
      rows.push(row);
    }
    return { rows, clippedTo: limit };
  }

  const weeks = [...new Set(series.flatMap((s) => s.weekly.map((w) => w.week)))].sort();
  const lookup = series.map((s) => new Map(s.weekly.map((w) => [w.week, w])));
  const rows = weeks.map((week) => {
    const row: ChartRow = { x: week };
    series.forEach((s, i) => {
      const found = lookup[i]!.get(week);
      row[s.key] = found ? options.value(found) : null;
    });
    return row;
  });
  return { rows, clippedTo: null };
}

/** Weekly merged pull requests, or merged per active author when `perContributor` is on. */
export function throughput(row: WeekRow, perContributor: boolean): number | null {
  if (!perContributor) return row.merged;
  return row.activeAuthors > 0 ? row.merged / row.activeAuthors : null;
}

/**
 * Running totals per series key. A series stays null until its first row with a value, then carries its
 * total forward over any gap, so a line never drops back to zero.
 */
export function cumulative(rows: readonly ChartRow[], keys: readonly string[]): ChartRow[] {
  const totals = new Map<string, number | null>(keys.map((k) => [k, null]));
  return rows.map((row) => {
    const next: ChartRow = { ...row };
    for (const key of keys) {
      const value = row[key];
      const previous = totals.get(key) ?? null;
      const total = typeof value === "number" ? (previous ?? 0) + value : previous;
      totals.set(key, total);
      next[key] = total;
    }
    return next;
  });
}

/** Replaces zero and negative values with null so a log scale can plot the rest. */
export function positiveOnly(rows: readonly ChartRow[], keys: readonly string[]): ChartRow[] {
  return rows.map((row) => {
    const next: ChartRow = { ...row };
    for (const key of keys) {
      const value = row[key];
      next[key] = typeof value === "number" && value > 0 ? value : null;
    }
    return next;
  });
}

export type StageKey = "coding" | "waitingForReview" | "inReview" | "toMerge";
export const STAGE_KEYS: readonly StageKey[] = ["coding", "waitingForReview", "inReview", "toMerge"];
export type Stages = Record<StageKey, number>;

/** The mean of each stage over the weeks that have stage data, or null when none do. */
export function meanStages(weekly: readonly WeekRow[]): Stages | null {
  const rows = weekly.map((w) => w.stages).filter((s): s is Stages => s !== null);
  if (rows.length === 0) return null;
  const result = {} as Stages;
  for (const key of STAGE_KEYS) result[key] = rows.reduce((sum, s) => sum + s[key], 0) / rows.length;
  return result;
}

/** Each stage as a share of the total, summing to 1; null when the total is zero. */
export function stageShares(stages: Stages | null): Stages | null {
  if (!stages) return null;
  const total = STAGE_KEYS.reduce((sum, key) => sum + stages[key], 0);
  if (total <= 0) return null;
  const result = {} as Stages;
  for (const key of STAGE_KEYS) result[key] = stages[key] / total;
  return result;
}

/**
 * Drops weeks that had not finished by the end of the range. Weekly rate charts use this so the current,
 * part-finished week does not read as a sudden drop; cumulative charts keep every week.
 */
export function completeWeeks<T extends WeeklySeries>(series: readonly T[]): T[] {
  return series.map((s) => ({ ...s, weekly: s.weekly.filter((w) => !w.partial) }));
}

/**
 * Vertical pixel offsets for end-of-line labels, so two lines finishing close together do not print their
 * labels on top of each other. Labels are ordered by their final value and pushed apart until at least
 * `gap` pixels separate neighbours, measured on a chart `height` pixels tall.
 */
export function endLabelOffsets(
  rows: readonly ChartRow[],
  keys: readonly string[],
  height: number,
  gap = 14,
): Record<string, number> {
  const ends = keys
    .map((key) => {
      const index = lastValueIndex(rows, key);
      return { key, value: index >= 0 ? (rows[index]![key] as number) : null };
    })
    .filter((e): e is { key: string; value: number } => e.value !== null);
  const offsets: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  if (ends.length < 2) return offsets;
  const max = Math.max(...ends.map((e) => e.value), 0);
  const scale = max > 0 ? height / max : 0;
  // Highest value first, top of the chart; y grows downwards on screen.
  const sorted = [...ends].sort((a, b) => b.value - a.value);
  let previousY = Number.NEGATIVE_INFINITY;
  for (const end of sorted) {
    const naturalY = (max - end.value) * scale;
    const y = Math.max(naturalY, previousY + gap);
    offsets[end.key] = y - naturalY;
    previousY = y;
  }
  return offsets;
}

/** Index of the last row where `key` has a number, for placing a direct label at a line's end. */
export function lastValueIndex(rows: readonly ChartRow[], key: string): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (typeof rows[i]![key] === "number") return i;
  return -1;
}

/**
 * The span when every compared project was active, from the latest project start to today, as
 * YYYY-MM-DD. Returns null when any report has no project start, since that project has no activity.
 */
export function overlappingRange(
  reports: readonly { projectStart: string | null }[],
  now: Date = new Date(),
): { from: string; to: string } | null {
  if (reports.length === 0) return null;
  const starts = reports.map((r) => r.projectStart);
  if (starts.some((s) => s === null)) return null;
  const latest = (starts as string[])
    .map((s) => s.slice(0, 10))
    .sort()
    .at(-1)!;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  return { from: latest > today ? today : latest, to: today };
}
