/**
 * The kinds and priorities a GitHub issue can have (ADR 0028), each written once. The types come from these lists, and
 * every other order is a record that must name each member, so a kind or priority added here is a compile error
 * everywhere that has not dealt with it.
 */

/** The kinds a label, a native issue type or a title prefix can name, in the order forms list them. */
export const ISSUE_LABEL_KINDS = ["bug", "feature", "maintenance", "incident", "security", "epic"] as const;
export type IssueLabelKind = (typeof ISSUE_LABEL_KINDS)[number];

/** What sort of work a GitHub issue is; `other` when nothing names a kind. */
export type IssueKind = IssueLabelKind | "other";

/** How urgent a GitHub issue is, most urgent first. */
export const ISSUE_PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** The kinds a report counts; epics are counted apart. */
export type IssueCountedKind = Exclude<IssueKind, "epic">;
/** A priority, or `none` for an issue that names none. */
export type IssuePriorityKey = IssuePriority | "none";

/** The keys of a record that names every member of `K`, in the order written; leaving one out does not compile. */
export const keysOf = <K extends string>(record: Record<K, true>): readonly K[] => Object.keys(record) as K[];

/** The counted kinds in the order reports, charts and tables list them. */
export const ISSUE_COUNTED_KINDS = keysOf<IssueCountedKind>({
  bug: true,
  feature: true,
  maintenance: true,
  incident: true,
  security: true,
  other: true,
});

/** The priorities in report order, most urgent first, then none. */
export const ISSUE_PRIORITY_KEYS = keysOf<IssuePriorityKey>({ P0: true, P1: true, P2: true, P3: true, P4: true, none: true });
