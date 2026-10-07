import { copy } from "../copy";
import { formatWeek } from "./format";

/**
 * Drops the weeks before the first one that has anything to show, so a series that started late
 * (a deploy workflow added a year into the repository's life, say) does not open on a long flat run.
 * When no week is active the weeks come back unchanged and the caller shows its empty state.
 */
export function fromFirstActive<T>(weeks: readonly T[], isActive: (week: T) => boolean): T[] {
  const first = weeks.findIndex(isActive);
  return first === -1 ? [...weeks] : weeks.slice(first);
}

/** How many weeks a weekly chart shows before it gains a zoom slider. */
export const ZOOM_AFTER_WEEKS = 26;

/**
 * The window a weekly chart opens on: the latest `visible` weeks, or null when every week fits
 * and no zoom slider is needed. Indices are inclusive, as the chart's slider expects.
 */
export function initialWindow(length: number, visible = ZOOM_AFTER_WEEKS): { startIndex: number; endIndex: number } | null {
  if (length <= visible) return null;
  return { startIndex: length - visible, endIndex: length - 1 };
}

/** The week a report's range ends part way through, which the report flags as partial. */
export interface PartWeek {
  /** The Monday the week starts on, as YYYY-MM-DD. */
  week: string;
  /** The day the range ends on, part way through the week, as YYYY-MM-DD. */
  through: string;
  /** True when the range ends today, so the week is still under way and its figures can still change. */
  current: boolean;
}

/**
 * The week the range ends part way through, or null when the range ends with a week. `today` is the UTC day, as
 * YYYY-MM-DD, because weeks are cut in UTC.
 */
export function partWeek(
  report: { weekly: readonly { week: string; partial: boolean }[]; range: { to: string } },
  today: string,
): PartWeek | null {
  const week = report.weekly.find((w) => w.partial)?.week;
  if (!week) return null;
  const through = report.range.to.slice(0, 10);
  return { week, through, current: through >= today };
}

/** The note above the weekly charts, saying why the part week is marked and drawn as it is. */
export function partWeekNote(part: PartWeek): string {
  const week = formatWeek(part.week);
  return part.current ? copy.charts.partWeek.current(week) : copy.charts.partWeek.cut(week, formatWeek(part.through));
}

/**
 * Names for a week in a weekly chart's tooltip, table and legend. The part week is marked so far while it is under way,
 * or with the day the range stops at when the range ended earlier.
 */
export function weekNames(part: PartWeek | null) {
  const mark = (week: string, name: string) => {
    if (week !== part?.week) return name;
    return part.current ? copy.charts.partWeek.soFar(name) : copy.charts.partWeek.to(name, formatWeek(part.through));
  };
  return {
    /** A tooltip heading or legend label, such as "Week starting 5 Oct". */
    heading: (week: string | number) => mark(String(week), `${copy.charts.weekStarting} ${formatWeek(String(week))}`),
    /** A table's first column, such as "5 Oct". */
    cell: (week: string) => mark(week, formatWeek(week)),
  };
}
