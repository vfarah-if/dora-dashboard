import { DEFAULT_ISSUE_LABELS, ISSUE_HYGIENE_CHECKS } from "@dora-dashboard/core";
import type {
  IssueAgeingItem,
  IssueCountedKind,
  IssueHygieneCheck,
  IssueHygieneFinding,
  IssueKind,
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

/** True when any repository has stored issues, which is when the GitHub Issues page is offered. */
export const hasIssues = (repos: readonly RepoListing[]): boolean => repos.some((repo) => repo.issues > 0);

/** The repositories that have stored issues, in the order the list gave them. */
export const reposWithIssues = (repos: readonly RepoListing[]): RepoListing[] => repos.filter((repo) => repo.issues > 0);

/** The kinds a report counts, in the order charts and tables list them. Epics are counted apart. */
export const ISSUE_KINDS: readonly IssueCountedKind[] = ["bug", "feature", "maintenance", "incident", "security", "other"];

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
export const ISSUE_PRIORITIES: readonly IssuePriorityKey[] = ["P0", "P1", "P2", "P3", "P4", "none"];

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

/** The hygiene findings in the order the cards are shown, whatever order the API returned them in. */
export function orderedFindings(findings: readonly IssueHygieneFinding[]): IssueHygieneFinding[] {
  const byCheck = new Map<IssueHygieneCheck, IssueHygieneFinding>(findings.map((f) => [f.check, f]));
  return ISSUE_HYGIENE_CHECKS.flatMap((check) => {
    const finding = byCheck.get(check);
    return finding ? [finding] : [];
  });
}

/** What the API allows for one kind or priority. */
export const MAX_LABEL_NAMES = 30;
export const MAX_LABEL_LENGTH = 100;

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

export type LabelKey = Exclude<IssueKind, "other">;
export const LABEL_KINDS: readonly LabelKey[] = ["bug", "feature", "maintenance", "incident", "security", "epic"];
export const LABEL_PRIORITIES: readonly IssuePriority[] = ["P0", "P1", "P2", "P3", "P4"];

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

/** The placeholder text of every input, from the defaults core classifies with. */
export function defaultInputs(): LabelInputs {
  return {
    kinds: blank(LABEL_KINDS, DEFAULT_ISSUE_LABELS.kinds),
    priorities: blank(LABEL_PRIORITIES, DEFAULT_ISSUE_LABELS.priorities),
  };
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

/** What is wrong with one input's text, if anything, by the limits the API enforces. */
export function labelProblem(text: string): "tooMany" | "tooLong" | null {
  const names = parseLabelList(text);
  if (names.length > MAX_LABEL_NAMES) return "tooMany";
  if (names.some((name) => name.length > MAX_LABEL_LENGTH)) return "tooLong";
  return null;
}
