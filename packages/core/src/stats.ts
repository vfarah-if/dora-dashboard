const HOUR_MS = 3_600_000;

export function hoursBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const delta = (Date.parse(to) - Date.parse(from)) / HOUR_MS;
  return Number.isFinite(delta) ? delta : null;
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
