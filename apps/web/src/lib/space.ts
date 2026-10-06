import type { ColumnTime, ItemRef, JiraHygieneCheck, SpaceWeekRow } from "@dora-dashboard/core";
import { copy } from "../copy";

/**
 * Where each hygiene card sits on the page, so the page reads the same every time. A record rather than a list, so a
 * check added to core fails to compile here until it is given a place, instead of never being shown.
 */
const HYGIENE_RANK: Record<JiraHygieneCheck, number> = {
  pr_without_key: 0,
  done_without_pr: 1,
  skipped_in_progress: 2,
  bulk_move: 3,
  reopened: 4,
  stale_in_progress: 5,
  in_progress_unassigned: 6,
};

/** Every hygiene check, in the order the cards are shown. */
export const HYGIENE_ORDER: readonly JiraHygieneCheck[] = (Object.keys(HYGIENE_RANK) as JiraHygieneCheck[]).sort(
  (a, b) => HYGIENE_RANK[a] - HYGIENE_RANK[b],
);

/** How many entries a list shows before the reader asks for the rest. */
export const LIST_LIMIT = 10;

/** A column's name as the page shows it: the board's own name, or the page's words for time outside the board (null). */
export function columnLabel(column: string | null): string {
  return column ?? copy.space.columns.notOnBoard;
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
  /** One row per week that does not run past the end of the range, with a count for each series key. */
  rows: ({ week: string } & Record<string, number | string>)[];
}

const typeKey = (label: string) => `type-${label}`;
/** Lower case, so it cannot meet a known type's key. */
const OTHER_KEY = "type-other";

/**
 * Weeks that do not run past the end of the range; a week cut short there would read as a slump. A first week cut
 * short by the start of the range is kept.
 */
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
    const onBoard = column.column !== null;
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
  /** Unique among the groups: names and the two nameless groups are kept apart by a prefix, so no name can clash. */
  id: string;
  /** The assignee's name, or null when there is none to show. */
  name: string | null;
  /** True when someone is assigned, so a group with no name holds work whose assignee's name was not recorded. */
  assigned: boolean;
  items: T[];
}

/** Named groups A to Z, then assigned work whose name was not recorded, then unassigned work. */
const groupRank = (group: AssigneeGroup<unknown>) => (group.name !== null ? 0 : group.assigned ? 1 : 2);

/**
 * Groups items by assignee name, A to Z, then assigned work with no recorded name, then unassigned work last, so work
 * from a space crawled before names were recorded is not shown as nobody's. Order within a group is kept.
 */
export function groupByAssignee<T extends Pick<ItemRef, "assigned" | "assignee">>(items: readonly T[]): AssigneeGroup<T>[] {
  const groups = new Map<string, AssigneeGroup<T>>();
  for (const item of items) {
    const name = (item.assigned && item.assignee?.trim()) || null;
    const id = name !== null ? `name:${name}` : item.assigned ? "assigned" : "unassigned";
    const group = groups.get(id) ?? { id, name, assigned: item.assigned, items: [] };
    group.items.push(item);
    groups.set(id, group);
  }
  // There is one nameless group of each kind, so only named groups share a rank and need comparing by name.
  return [...groups.values()].sort(
    (a, b) => groupRank(a) - groupRank(b) || String(a.name).localeCompare(String(b.name), "en-GB"),
  );
}

/** The heading for a group: the assignee's name, or what the page says for work with no name to show. */
export function assigneeLabel(group: Pick<AssigneeGroup<unknown>, "name" | "assigned">): string {
  if (group.name !== null) return group.name;
  return group.assigned ? copy.space.hygiene.nameNotRecorded : copy.space.hygiene.unassigned;
}

/** Keeps the first `limit` items across the groups, dropping groups that end up empty. */
export function limitGroups<T>(groups: readonly AssigneeGroup<T>[], limit: number): AssigneeGroup<T>[] {
  let left = limit;
  return groups.flatMap((group) => {
    if (left <= 0) return [];
    const items = group.items.slice(0, left);
    left -= items.length;
    return [{ ...group, items }];
  });
}
