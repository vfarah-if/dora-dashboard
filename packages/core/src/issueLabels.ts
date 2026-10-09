import {
  ISSUE_LABEL_KINDS,
  ISSUE_PRIORITIES,
  keysOf,
  type IssueKind,
  type IssueLabelKind,
  type IssuePriority,
} from "./issueKinds.js";
import type { IssueLabelLists, IssueLabelRules, RepoIssue } from "./types.js";

/**
 * Decides what kind of work a GitHub issue is and how urgent it is, from the host's own issue type, its labels and the
 * prefix of its title (ADR 0028). Names are compared whole and without case; no user-supplied pattern is ever run.
 */

/** Kinds in the order that decides between several matches: the first listed wins. */
const KIND_PRECEDENCE = keysOf<IssueLabelKind>({
  epic: true,
  security: true,
  incident: true,
  bug: true,
  feature: true,
  maintenance: true,
});

/** The label names that mean each kind and priority until a repository overrides them. */
export const DEFAULT_ISSUE_LABELS: IssueLabelLists = {
  kinds: {
    bug: ["bug", "defect", "regression"],
    feature: ["feature", "enhancement", "feature request", "story"],
    maintenance: [
      "chore",
      "maintenance",
      "tech-debt",
      "tech debt",
      "refactor",
      "dependencies",
      "deps",
      "dev-infra",
      "infrastructure",
      "infra",
      "ci",
    ],
    incident: ["incident", "outage", "hotfix"],
    security: ["security", "vulnerability"],
    epic: ["epic"],
  },
  priorities: {
    P0: ["p0", "critical", "urgent", "blocker"],
    P1: ["p1", "high"],
    P2: ["p2", "medium"],
    P3: ["p3", "low"],
    P4: ["p4", "lowest", "trivial"],
  },
};

/** The most names one kind or priority of an override may list, and the most characters one name may have. */
export const ISSUE_LABEL_LIMITS = { names: 30, length: 100 } as const;

const PREFIX = /^(?:type|kind|priority|prio)\s*[:/]\s*/;

/** A name as compared: trimmed, lower case, without a leading `type:`, `kind/`, `priority:` or `prio:` style prefix. */
const normalise = (name: string) => name.trim().toLowerCase().replace(PREFIX, "").trim();

/**
 * What a title's prefix may name: each leading `[tag]`, then the text before the first colon of what is left, so
 * `[P1] Security: Login` offers `p1` and `security`, and `Bug: Crash` offers `bug`.
 */
function titlePrefixes(title: string): string[] {
  const found: string[] = [];
  let rest = title.trim();
  for (let tag = /^\[([^\]]*)\]\s*/.exec(rest); tag; tag = /^\[([^\]]*)\]\s*/.exec(rest)) {
    found.push(tag[1]!);
    rest = rest.slice(tag[0].length);
  }
  const colon = rest.indexOf(":");
  if (colon > 0) found.push(rest.slice(0, colon));
  return found;
}

function kindFrom(names: readonly string[], lists: Record<IssueLabelKind, Set<string>>): IssueLabelKind | null {
  return KIND_PRECEDENCE.find((kind) => names.some((name) => lists[kind].has(name))) ?? null;
}

function priorityFrom(names: readonly string[], lists: Record<IssuePriority, Set<string>>): IssuePriority | null {
  return ISSUE_PRIORITIES.find((priority) => names.some((name) => lists[priority].has(name))) ?? null;
}

/**
 * Each key's names as compared. An override replaces a key's defaults only when it names something once normalised,
 * so an empty or blank list keeps the defaults and can never switch a kind or priority off (ADR 0028).
 */
const setsOf = <K extends string>(
  keys: readonly K[],
  defaults: Record<K, string[]>,
  override: Partial<Record<K, string[]>> | undefined,
) =>
  Object.fromEntries(
    keys.map((key) => {
      const named = (override?.[key] ?? []).map(normalise).filter((name) => name !== "");
      return [key, new Set(named.length > 0 ? named : defaults[key].map(normalise))];
    }),
  ) as Record<K, Set<string>>;

/**
 * The kind and priority of an issue. Evidence is read in order: the native issue type, then the labels, then the
 * title's prefix, and the first source that names a kind decides it, however many of its names match, by the kind
 * precedence epic, security, incident, bug, feature, maintenance. Kind and priority are decided separately, so a label
 * may give the kind while the title gives the priority. Within the source that decides, the most urgent priority wins.
 * A native type such as "Task" that no list names gives no evidence, so the labels are read next.
 * An issue nothing names is kind `other` with no priority.
 */
export function classifyIssue(
  issue: Pick<RepoIssue, "title" | "labels" | "issueType">,
  rules?: IssueLabelRules | null,
): { kind: IssueKind; priority: IssuePriority | null } {
  const kinds = setsOf(ISSUE_LABEL_KINDS, DEFAULT_ISSUE_LABELS.kinds, rules?.kinds);
  const priorities = setsOf(ISSUE_PRIORITIES, DEFAULT_ISSUE_LABELS.priorities, rules?.priorities);
  const sources = [
    issue.issueType === null ? [] : [normalise(issue.issueType)],
    issue.labels.map(normalise),
    titlePrefixes(issue.title).map(normalise),
  ];
  let kind: IssueLabelKind | null = null;
  let priority: IssuePriority | null = null;
  for (const names of sources) {
    kind ??= kindFrom(names, kinds);
    priority ??= priorityFrom(names, priorities);
  }
  return { kind: kind ?? "other", priority };
}
