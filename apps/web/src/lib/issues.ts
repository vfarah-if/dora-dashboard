import type {
  IssueAgeingItem,
  IssueCountedKind,
  IssueHygieneCheck,
  IssueHygieneFinding,
  IssueKind,
  IssueLabelDefaults,
  IssueLabelKind,
  IssueLabelLists,
  IssueLabelRules,
  IssuePriority,
  IssuePriorityKey,
  IssueReport,
  IssueWeekRow,
  RepoListing,
} from "@dora-dashboard/core";
import { copy } from "../copy";
import { formatWeek } from "./format";
import type { PartWeek } from "./weekly";

/**
 * The keys of a record that names every member of `K`, in the order written. The record is what makes the compiler
 * refuse a list that misses a kind or priority that core has added.
 */
const keysOf = <K extends string>(record: Record<K, true>): readonly K[] => Object.keys(record) as K[];

/**
 * True when the GitHub Issues page has something to say about the repository: it has stored issues, or its last read
 * of them failed, since leaving out a failed first read would hide the failure. Issues switched off on GitHub are not
 * enough on their own, because a repository tracked in Jira usually has them off and every such repository would then
 * be listed; its own issue page still says so to anyone who arrives there.
 */
export const hasIssueStatus = (repo: RepoListing): boolean => repo.issues > 0 || repo.issueError !== null;

/** True when any repository belongs on the GitHub Issues page, which is when the page is offered. */
export const hasIssues = (repos: readonly RepoListing[]): boolean => repos.some(hasIssueStatus);

/** The repositories that belong on the GitHub Issues page, in the order the list gave them. */
export const reposWithIssues = (repos: readonly RepoListing[]): RepoListing[] => repos.filter(hasIssueStatus);

/** The kinds a report counts, in the order charts and tables list them. Epics are counted apart. */
export const ISSUE_KINDS = keysOf<IssueCountedKind>({
  bug: true,
  feature: true,
  maintenance: true,
  incident: true,
  security: true,
  other: true,
});

/**
 * Each kind has one colour for good, so a kind that is absent in a range leaves the others where they were. The
 * first five use the series tokens and `other` the neutral one.
 */
const KIND_COLOURS: Record<IssueCountedKind, string> = {
  bug: "var(--series-1)",
  feature: "var(--series-2)",
  maintenance: "var(--series-3)",
  incident: "var(--series-4)",
  security: "var(--series-5)",
  other: "var(--type-other)",
};

export const kindColour = (kind: IssueCountedKind): string => KIND_COLOURS[kind];

export const kindLabel = (kind: IssueKind): string => copy.issue.kinds[kind];

export const priorityLabel = (priority: IssuePriorityKey): string => copy.issue.priorities[priority];

/** The priorities in report order, most urgent first, then none. */
export const ISSUE_PRIORITIES = keysOf<IssuePriorityKey>({ P0: true, P1: true, P2: true, P3: true, P4: true, none: true });

export interface KindSeries {
  key: IssueCountedKind;
  label: string;
  colour: string;
}

const seriesOf = (kind: IssueCountedKind): KindSeries => ({ key: kind, label: kindLabel(kind), colour: kindColour(kind) });

/** The kinds that closed something in the report's weeks, in the fixed order, each in its own colour. */
export function closedKindSeries(weekly: readonly IssueWeekRow[]): KindSeries[] {
  return ISSUE_KINDS.filter((kind) => weekly.some((week) => week.closedByKind[kind] > 0)).map(seriesOf);
}

/** One weekly chart row. `partial` is kept so the part week's bars can be drawn lighter. */
export type IssueFlowRow = { week: string; partial: boolean; opened: number; closed: number; openAtEnd: number } & Record<
  IssueCountedKind,
  number
>;

/** Every week of the report, the part week included, with each kind's closes as a field of its own. */
export function flowRows(weekly: readonly IssueWeekRow[]): IssueFlowRow[] {
  return weekly.map((w) => ({
    week: w.week,
    partial: w.partial,
    opened: w.opened,
    closed: w.closed,
    openAtEnd: w.openAtEnd,
    ...w.closedByKind,
  }));
}

/** True when any week opened or closed something. */
export const hasFlow = (weekly: readonly IssueWeekRow[]): boolean => weekly.some((w) => w.opened > 0 || w.closed > 0);

export interface OpenBar {
  key: string;
  label: string;
  colour: string;
  count: number;
}

/** Open issues by kind, every kind in the fixed order and its own colour, with zero for one with none. */
export function openByKindBars(openByKind: IssueReport["openByKind"]): OpenBar[] {
  return ISSUE_KINDS.map((kind) => ({ ...seriesOf(kind), count: openByKind[kind] }));
}

/** Open issues by priority in report order. Priority is an ordered scale, so all bars share one colour. */
export function openByPriorityBars(openByPriority: IssueReport["openByPriority"], colour: string): OpenBar[] {
  return ISSUE_PRIORITIES.map((key) => ({ key, label: priorityLabel(key), colour, count: openByPriority[key] }));
}

/** The longest open issue, or null when none is open. The report lists the ageing oldest first. */
export const oldestOpen = (ageing: readonly IssueAgeingItem[]): IssueAgeingItem | null => ageing[0] ?? null;

/** The note above the weekly charts for the week the range ends part way through. */
export function issuePartWeekNote(part: PartWeek): string {
  const week = formatWeek(part.week);
  const text = copy.issue.flow.partWeek;
  return part.current ? text.current(week) : text.cut(week, formatWeek(part.through));
}

/** Where each check's card sits, so a check added in core must be given a place here before this compiles. */
const CHECK_RANK: Record<IssueHygieneCheck, number> = {
  closed_without_pr: 0,
  reopened: 1,
  urgent_unassigned: 2,
  stale_urgent: 3,
  unclassified: 4,
  pr_without_issue: 5,
};

/** The hygiene findings in the order the cards are shown, whatever order the API returned them in. */
export const orderedFindings = (findings: readonly IssueHygieneFinding[]): IssueHygieneFinding[] =>
  [...findings].sort((a, b) => CHECK_RANK[a.check] - CHECK_RANK[b.check]);

/** Label names from comma separated text. Blanks are dropped and a name repeated with other capitals is kept once. */
export function parseLabelList(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of text.split(",")) {
    const name = part.trim();
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** Label names as the text a person types, one comma and a space between them. */
export const formatLabelList = (names: readonly string[] | undefined): string => (names ?? []).join(", ");

export type LabelKey = IssueLabelKind;
export const LABEL_KINDS = keysOf<IssueLabelKind>({
  bug: true,
  feature: true,
  maintenance: true,
  incident: true,
  security: true,
  epic: true,
});
export const LABEL_PRIORITIES = keysOf<IssuePriority>({ P0: true, P1: true, P2: true, P3: true, P4: true });

/** The text of every input in the labels panel. */
export interface LabelInputs {
  kinds: Record<LabelKey, string>;
  priorities: Record<IssuePriority, string>;
}

const blank = <K extends string>(keys: readonly K[], from: Partial<Record<K, string[]>> | undefined) =>
  Object.fromEntries(keys.map((key) => [key, formatLabelList(from?.[key])])) as Record<K, string>;

/** The input text for a repository's override; a key it does not override is empty, which means the default. */
export function inputsFromRules(rules: IssueLabelRules | null): LabelInputs {
  return { kinds: blank(LABEL_KINDS, rules?.kinds), priorities: blank(LABEL_PRIORITIES, rules?.priorities) };
}

/** The placeholder text of every input, from the defaults the API classifies with. */
export function defaultInputs(defaults: IssueLabelLists): LabelInputs {
  return { kinds: blank(LABEL_KINDS, defaults.kinds), priorities: blank(LABEL_PRIORITIES, defaults.priorities) };
}

/**
 * The override the inputs stand for. Only a key with a name typed in is sent, so an empty box keeps its default, and
 * null is returned when every box is empty.
 */
export function rulesFromInputs(inputs: LabelInputs): IssueLabelRules | null {
  const kinds: NonNullable<IssueLabelRules["kinds"]> = {};
  for (const key of LABEL_KINDS) {
    const names = parseLabelList(inputs.kinds[key]);
    if (names.length > 0) kinds[key] = names;
  }
  const priorities: NonNullable<IssueLabelRules["priorities"]> = {};
  for (const key of LABEL_PRIORITIES) {
    const names = parseLabelList(inputs.priorities[key]);
    if (names.length > 0) priorities[key] = names;
  }
  const rules: IssueLabelRules = {
    ...(Object.keys(kinds).length > 0 && { kinds }),
    ...(Object.keys(priorities).length > 0 && { priorities }),
  };
  return Object.keys(rules).length > 0 ? rules : null;
}

const hasControlCharacter = (name: string): boolean =>
  [...name].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

/** What is wrong with one input's text, if anything, by the limits and rules the API enforces. */
export function labelProblem(text: string, limits: IssueLabelDefaults["limits"]): "tooMany" | "tooLong" | "control" | null {
  const names = parseLabelList(text);
  if (names.length > limits.names) return "tooMany";
  if (names.some((name) => name.length > limits.length)) return "tooLong";
  if (names.some(hasControlCharacter)) return "control";
  return null;
}
