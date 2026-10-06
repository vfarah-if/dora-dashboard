const HOUR_MS = 3_600_000;

export function hoursBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const delta = (Date.parse(to) - Date.parse(from)) / HOUR_MS;
  return Number.isFinite(delta) ? delta : null;
}

const DAY_MS = 24 * HOUR_MS;

/**
 * Hours between two instants that fall on a Monday to Friday in UTC. Saturday and Sunday count as nothing, so a
 * pull request published on Friday afternoon has waited 18 hours by Monday at 10:00. Zero when `to` is not after `from`.
 */
export function weekdayHoursBetween(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  let total = 0;
  for (let day = Math.floor(start / DAY_MS) * DAY_MS; day < end; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    total += Math.min(end, day + DAY_MS) - Math.max(start, day);
  }
  return total / HOUR_MS;
}

/** Linear-interpolated percentile, p in [0, 1]. Returns null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lo = sorted[lower]!;
  const hi = sorted[upper]!;
  return lo + (hi - lo) * (rank - lower);
}

export const median = (values: readonly number[]) => percentile(values, 0.5);
export const p75 = (values: readonly number[]) => percentile(values, 0.75);

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export interface Summary {
  count: number;
  median: number | null;
  p75: number | null;
  mean: number | null;
}

export function summarise(values: readonly (number | null)[]): Summary {
  const present = values.filter((v): v is number => v !== null);
  return { count: present.length, median: median(present), p75: p75(present), mean: mean(present) };
}

/** Monday 00:00 UTC of the ISO week containing the instant, as YYYY-MM-DD. */
export function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDay(); // 0 = Sunday
  const offset = (day + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset));
  return monday.toISOString().slice(0, 10);
}

/** Every week start from the first to the last inclusive, so charts show empty weeks as zero. */
export function weekRange(firstWeek: string, lastWeek: string): string[] {
  const weeks: string[] = [];
  const cursor = new Date(`${firstWeek}T00:00:00Z`);
  const end = Date.parse(`${lastWeek}T00:00:00Z`);
  while (cursor.getTime() <= end) {
    weeks.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}

/**
 * True when the instant falls inside the range, both ends included. The comparison is on the ISO strings, exactly
 * as the report scopes pull requests and runs, so every figure built from a range counts the same items.
 */
export function isWithin(iso: string | null, from: string, to: string): iso is string {
  return iso !== null && iso >= from && iso <= to;
}

const WEEK_MS = 7 * DAY_MS;

/** True for a week, given by its Monday, that had not finished by `to`, the last second of a range. */
export function isPartialWeek(week: string, to: string): boolean {
  return Date.parse(week) + WEEK_MS > Date.parse(to) + 1000;
}
