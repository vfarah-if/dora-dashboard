import type { ColumnTime, ItemRef, JiraHygieneCheck, SpaceWeekRow } from "@dora-dashboard/core";
import { copy } from "../copy";

/** The order the hygiene cards are shown in, so the page reads the same every time. */
export const HYGIENE_ORDER: readonly JiraHygieneCheck[] = [
  "pr_without_key",
  "done_without_pr",
  "skipped_in_progress",
  "bulk_move",
  "reopened",
  "stale_in_progress",
  "in_progress_unassigned",
];

/** How many entries a list shows before the reader asks for the rest. */
export const LIST_LIMIT = 10;

/** The name the API gives time spent in statuses that no board column holds. Compared against, never shown. */
const NOT_ON_BOARD = "Not on the board";

/** A column's name as the page shows it: the board's own name, or the page's words for time outside the board. */
export function columnLabel(column: string): string {
  return column === NOT_ON_BOARD ? copy.space.columns.notOnBoard : column;
}

/** The link to an issue in Jira. A trailing slash on the site address is tolerated. */
export function browseUrl(siteUrl: string, key: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`;
}

/** A share between 0 and 1, or null when there was nothing to share out of. */
export function shareOf(count: number, of: number | null): number | null {
  return of === null || of <= 0 ? null : count / of;
}

/**
 * Colours follow the issue type by name, never by how many were done, so a busy week does not repaint a type.
 * Types beyond these four share one neutral colour in a single series.
 */
export const KNOWN_TYPES = ["Story", "Bug", "Task", "Feature"] as const;

export interface TypeSeries {
  /** The field name in the chart rows. */
  key: string;
  /** The type name shown to the reader. */
  label: string;
  colour: string;
}

export interface ThroughputChart {
  series: TypeSeries[];
  /** One row per complete week, with a count for each series key. */
  rows: ({ week: string } & Record<string, number | string>)[];
}

const typeKey = (label: string) => `type-${label}`;
/** Lower case, so it cannot meet a known type's key. */
const OTHER_KEY = "type-other";

/** Weeks that have finished. A running week would read as a slump on a weekly chart. */
export const completeWeeks = (weekly: readonly SpaceWeekRow[]) => weekly.filter((w) => !w.partial);

/** Throughput stacked by type. Only types that appear are listed, in a fixed order. */
export function throughputChart(weekly: readonly SpaceWeekRow[]): ThroughputChart {
  const weeks = completeWeeks(weekly);
  const present = new Set(weeks.flatMap((w) => Object.keys(w.doneByType).filter((t) => (w.doneByType[t] ?? 0) > 0)));
  const known = KNOWN_TYPES.filter((t) => present.has(t));
  const hasOther = [...present].some((t) => !(KNOWN_TYPES as readonly string[]).includes(t));
  const series: TypeSeries[] = [
    ...known.map((label) => ({
      label,
      key: typeKey(label),
      colour: `var(--series-${KNOWN_TYPES.indexOf(label) + 1})`,
    })),
    ...(hasOther ? [{ label: copy.space.flow.throughput.otherType, key: OTHER_KEY, colour: "var(--type-other)" }] : []),
  ];
  const rows = weeks.map((w) => {
    const row: ThroughputChart["rows"][number] = { week: w.week };
    for (const s of series) row[s.key] = 0;
    for (const [type, count] of Object.entries(w.doneByType)) {
      const key = (KNOWN_TYPES as readonly string[]).includes(type) ? typeKey(type) : OTHER_KEY;
      row[key] = (row[key] as number) + count;
    }
    return row;
  });
  return { series, rows };
}

export interface ColumnSegment {
  key: string;
  label: string;
  colour: string;
  meanHours: number;
}

const COLUMN_COLOURS = 8;

/**
 * Segments for the single stacked bar, in board order. A column keeps its colour by its place on the board,
 * so a column with no time does not shift the others. Time outside the board is neutral.
 */
export function columnSegments(columns: readonly ColumnTime[]): ColumnSegment[] {
  let slot = 0;
  return columns.flatMap((column, index) => {
    const onBoard = column.column !== NOT_ON_BOARD;
    const colour = onBoard ? `var(--column-${(slot % COLUMN_COLOURS) + 1})` : "var(--column-none)";
    if (onBoard) slot += 1;
    return column.meanHours > 0
      ? [{ key: `column-${index}`, label: columnLabel(column.column), colour, meanHours: column.meanHours }]
      : [];
  });
}

/** The one row a stacked horizontal bar needs, keyed by segment. */
export function columnRow(segments: readonly ColumnSegment[]): Record<string, number | string> {
  return { name: "", ...Object.fromEntries(segments.map((s) => [s.key, s.meanHours])) };
}

export interface AssigneeGroup<T> {
  /** The assignee's name, or null for work with nobody assigned. */
  name: string | null;
  items: T[];
}

/** Groups items by assignee name, A to Z, with unassigned work last. Order within a group is kept. */
export function groupByAssignee<T extends Pick<ItemRef, "assignee">>(items: readonly T[]): AssigneeGroup<T>[] {
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const name = item.assignee?.trim() || null;
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return [...groups.entries()]
    .map(([name, grouped]) => ({ name, items: grouped }))
    .sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name, "en-GB")));
}

/** Keeps the first `limit` items across the groups, dropping groups that end up empty. */
export function limitGroups<T>(groups: readonly AssigneeGroup<T>[], limit: number): AssigneeGroup<T>[] {
  let left = limit;
  return groups.flatMap((group) => {
    if (left <= 0) return [];
    const items = group.items.slice(0, left);
    left -= items.length;
    return [{ name: group.name, items }];
  });
}
