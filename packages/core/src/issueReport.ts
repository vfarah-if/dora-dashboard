import { instant, rangeOf, sinceCreated, toFirstPr, toProduction, type DeliveredPr, type RangeOptions } from "./delivery.js";
import { shippedPrs } from "./dora.js";
import {
  ISSUE_COUNTED_KINDS,
  ISSUE_PRIORITY_KEYS,
  type IssueCountedKind,
  type IssueKind,
  type IssuePriority,
  type IssuePriorityKey,
} from "./issueKinds.js";
import { classifyIssue } from "./issueLabels.js";
import { linkIssues } from "./issueLinks.js";
import { isBot } from "./pullRequests.js";
import { summarise, weekRange, weekStart, type Summary } from "./stats.js";
import type { ClosedRepoIssue, DeployRun, IssueLabelRules, PullRequest, PullRequestRef, Repo, RepoIssue } from "./types.js";

/**
 * Delivery measured from a repository's GitHub Issues (ADR 0028). Every figure counts issues other than epics; an
 * epic is shown only as a count of the open ones, and is never counted in a flow, a time or an issue check. A pull
 * request linked only to an epic is still linked to an issue, so it is not listed as a pull request without one. The
 * names are distinct from DORA lead time on purpose (ADR 0021).
 */

/** `from` defaults to the earliest issue's creation; `now` is passed in so the report stays pure. */
export interface IssueReportOptions extends RangeOptions {
  /** Include assignee logins in lists and findings. Off by default (ADR 0008). */
  people?: boolean;
  /** The repository's label override; null or absent for the defaults. */
  labels?: IssueLabelRules | null;
}

/** One issue named in a finding or a list. */
export interface IssueRef {
  number: number;
  title: string;
  url: string;
  kind: IssueKind;
  priority: IssuePriority | null;
  /** Whether anyone is assigned. It names nobody, so it is always present, with or without `people`. */
  assigned: boolean;
  /** Present only when `people` was asked for: the first assignee's login, or null when nobody is assigned. */
  assignee?: string | null;
}

export interface IssueWeekRow {
  /** Monday, YYYY-MM-DD. */
  week: string;
  /** Issues opened that week. */
  opened: number;
  /** Issues whose final close that week was as completed. */
  closed: number;
  /** Issues whose final close that week was as not planned or as a duplicate. */
  notPlanned: number;
  /** The completed closes by kind; every kind is present, with zero when none. */
  closedByKind: Record<IssueCountedKind, number>;
  /** Issues open at the last millisecond of the week, or at the end of the range when that is earlier. */
  openAtEnd: number;
  /** True when the week runs past the end of the range. */
  partial: boolean;
}

export interface IssueAgeingItem extends IssueRef {
  createdAt: string;
  /** Hours from creation to the end of the range. */
  ageHours: number;
}

/** Every check, in the order a report lists them; the one that is noisiest without closing keywords comes last. */
export const ISSUE_HYGIENE_CHECKS = [
  "closed_without_pr",
  "reopened",
  "urgent_unassigned",
  "stale_urgent",
  "unclassified",
  "pr_without_issue",
] as const;

export type IssueHygieneCheck = (typeof ISSUE_HYGIENE_CHECKS)[number];

/** The checks whose findings list issues, as against pull requests. */
export type IssueHygieneItemCheck = Exclude<IssueHygieneCheck, "pr_without_issue">;

/** How many open issues the ageing list carries; `ageingTotal` says how many there are. */
export const AGEING_LIMIT = 50;

/** An open urgent issue, incident or security issue untouched for more than this many days is stale. */
export const STALE_URGENT_DAYS = 14;

/** What every hygiene finding carries. */
interface IssueHygieneTally {
  /** How many issues or pull requests were found. */
  count: number;
  /** Out of how many were checked, so a share can be shown; null when a share means nothing. */
  of: number | null;
}

/** Merged pull requests, not by a bot, that no issue is linked to. */
export interface IssueHygienePullRequestFinding extends IssueHygieneTally {
  check: "pr_without_issue";
  pullRequests: PullRequestRef[];
}

/** Any other check: the issues it found, in number order. */
export interface IssueHygieneItemFinding extends IssueHygieneTally {
  check: IssueHygieneItemCheck;
  items: IssueRef[];
}

/** One hygiene check's result. `check` says which variant it is, so each carries only the list its check fills. */
export type IssueHygieneFinding = IssueHygienePullRequestFinding | IssueHygieneItemFinding;

export interface IssueReport {
  repo: Pick<Repo, "id" | "owner" | "name" | "lastCrawledAt">;
  range: { from: string; to: string };
  totals: {
    /** Issues opened in the range. */
    opened: number;
    /** Issues whose final close is in the range and was as completed. */
    closed: number;
    /** Issues whose final close is in the range and was as not planned or a duplicate. */
    notPlanned: number;
    /** Issues open at the end of the range. */
    open: number;
    /** Epics open at the end of the range; shown apart, never counted in the rest. */
    openEpics: number;
  };
  /** Created to the final completed close, hours, over issues closed as completed in the range. */
  timeToClose: Summary;
  /** The same by priority, always all six in order P0 to P4 then none, with a count of zero for one nothing fell in. */
  timeToCloseByPriority: { priority: IssuePriorityKey; summary: Summary }[];
  weekly: IssueWeekRow[];
  /** Open at the end of the range, by kind; epics are not included. */
  openByKind: Record<IssueCountedKind, number>;
  /** Open at the end of the range, by priority; epics are not included. */
  openByPriority: Record<IssuePriorityKey, number>;
  /** The oldest `AGEING_LIMIT` open issues at the end of the range, oldest first, epics left out. */
  ageing: IssueAgeingItem[];
  /** Every open issue at the end of the range, epics left out, so a list cut at `AGEING_LIMIT` can say how many more there are. */
  ageingTotal: number;
  ideaToProduction: {
    /** Created to the first linked pull request opened, hours. */
    toFirstPr: Summary;
    /** Created to the latest deploy among those that shipped its merged linked pull requests, hours; an issue counts only when every one has shipped. */
    toProduction: Summary;
  };
  /** Issues closed as completed in the range that have a linked pull request, out of all those. */
  linkedShare: { linked: number; total: number };
  hygiene: IssueHygieneFinding[];
  /** How many days without an update make an open urgent issue stale, so a page can say so without its own copy. */
  staleUrgentDays: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** A count of zero for each key. The key lists are built with `keysOf`, which will not compile without every member. */
const zeroes = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** A time the issue was open from, to a time it stopped being open; null while it still is. */
type Span = [start: number, end: number | null];

/**
 * When the issue was open, replayed from its closes and reopens. Without a usable history, which is when the host held
 * older events than were read or when a closed issue has none, it was open from creation, until its final close if it
 * is closed.
 */
function spansOf(issue: RepoIssue): Span[] {
  const created = instant(issue.createdAt);
  const finalClose = issue.state === "closed" ? instant(issue.closedAt) : null;
  if (issue.eventsTruncated || (finalClose !== null && issue.events.length === 0)) return [[created, finalClose]];
  const spans: Span[] = [[created, null]];
  for (const event of [...issue.events].sort((a, b) => instant(a.at) - instant(b.at))) {
    const current = spans[spans.length - 1]!;
    if (event.type === "closed" && current[1] === null) current[1] = instant(event.at);
    else if (event.type === "reopened" && current[1] !== null) spans.push([instant(event.at), null]);
  }
  // A closed issue whose events hold no close after the last reopen, such as a transferred one with only a reopened
  // event, would stay open for ever; the host's own final close ends the last span.
  const last = spans[spans.length - 1]!;
  if (finalClose !== null && last[1] === null) last[1] = finalClose;
  return spans;
}

/** An issue with what the report needs of it worked out once. */
interface Tracked {
  issue: RepoIssue;
  kind: IssueKind;
  priority: IssuePriority | null;
  spans: Span[];
}

/** An issue the report counts, which is any but an epic. */
interface Counted extends Tracked {
  kind: IssueCountedKind;
}

/** A counted issue that is closed. */
interface Closed extends Counted {
  issue: ClosedRepoIssue;
}

const isCounted = (t: Tracked): t is Counted => t.kind !== "epic";
const isClosed = (t: Counted): t is Closed => t.issue.state === "closed";
const isCompleted = (t: Closed) => t.issue.closeReason === "completed";

const isOpenAt = ({ spans }: Tracked, ms: number) => spans.some(([start, end]) => start <= ms && (end === null || end > ms));

export function buildIssueReport(
  repo: Pick<Repo, "id" | "owner" | "name" | "deployBranch" | "lastCrawledAt">,
  issues: RepoIssue[],
  prs: PullRequest[],
  runs: DeployRun[],
  options: IssueReportOptions,
): IssueReport {
  const range = rangeOf(issues, options);
  const inRange = (iso: string) => instant(iso) >= range.start && instant(iso) <= range.end;
  const repoId = `${repo.owner}/${repo.name}`;
  const people = options.people === true;
  const tracked: Tracked[] = issues.map((issue) => ({ issue, ...classifyIssue(issue, options.labels), spans: spansOf(issue) }));
  const counted = tracked.filter(isCounted);
  const refOf = ({ issue, kind, priority }: Tracked): IssueRef => {
    const ref: IssueRef = {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      kind,
      priority,
      assigned: issue.assignees.length > 0,
    };
    if (people) ref.assignee = issue.assignees[0] ?? null;
    return ref;
  };
  const refsOf = (list: readonly Tracked[]) => list.map(refOf).sort((a, b) => a.number - b.number);

  const closedInRange = counted.filter(isClosed).filter((t) => inRange(t.issue.closedAt));
  const completed = closedInRange.filter(isCompleted);
  const notPlanned = closedInRange.filter((t) => !isCompleted(t));
  const openAtEnd = counted.filter((t) => isOpenAt(t, range.end));
  const openEpics = tracked.filter((t) => t.kind === "epic" && isOpenAt(t, range.end));

  const { byIssue, linkedPrNumbers } = linkIssues(repo, issues, prs);
  const shipped = new Map<PullRequest, string>(
    shippedPrs(prs, runs, repo.deployBranch).map(({ pr, deploy }) => [pr, deploy.completedAt]),
  );
  const linkedTo = (t: Tracked): readonly PullRequest[] => byIssue.get(t.issue.number) ?? [];
  const deliveredOf = (t: Tracked): DeliveredPr[] => linkedTo(t).map((pr) => ({ pr, deployedAt: shipped.get(pr) ?? null }));
  const withPr = (t: Tracked) => linkedTo(t).length > 0;

  const mergedHuman = prs.filter((pr) => pr.mergedAt !== null && inRange(pr.mergedAt) && !isBot(pr));
  const prsWithoutIssue = mergedHuman.filter((pr) => !linkedPrNumbers.has(pr.number)).sort((a, b) => a.number - b.number);

  const urgent = openAtEnd.filter((t) => t.priority === "P0" || t.priority === "P1");
  const staleCandidates = openAtEnd.filter(
    (t) => t.priority === "P0" || t.priority === "P1" || t.kind === "incident" || t.kind === "security",
  );
  const itemFinding = <C extends IssueHygieneItemCheck>(
    check: C,
    found: readonly Tracked[],
    of: number | null,
  ): IssueHygieneItemFinding & { check: C } => ({
    check,
    count: found.length,
    of,
    items: refsOf(found),
  });
  // Each key holds the finding of its own check, so a finding filed under the wrong check does not compile.
  const findings: { [C in IssueHygieneCheck]: IssueHygieneFinding & { check: C } } = {
    closed_without_pr: itemFinding(
      "closed_without_pr",
      completed.filter((t) => !withPr(t)),
      completed.length,
    ),
    reopened: itemFinding(
      "reopened",
      counted.filter((t) => t.issue.events.some((e) => e.type === "reopened" && inRange(e.at))),
      null,
    ),
    urgent_unassigned: itemFinding(
      "urgent_unassigned",
      urgent.filter((t) => t.issue.assignees.length === 0),
      urgent.length,
    ),
    stale_urgent: itemFinding(
      "stale_urgent",
      staleCandidates.filter((t) => range.end - instant(t.issue.updatedAt) > STALE_URGENT_DAYS * DAY_MS),
      staleCandidates.length,
    ),
    unclassified: itemFinding(
      "unclassified",
      openAtEnd.filter((t) => t.kind === "other" && t.priority === null),
      openAtEnd.length,
    ),
    pr_without_issue: {
      check: "pr_without_issue",
      count: prsWithoutIssue.length,
      of: mergedHuman.length,
      pullRequests: prsWithoutIssue.map((pr): PullRequestRef => ({
        repo: repoId,
        number: pr.number,
        title: pr.title,
        url: pr.url,
      })),
    },
  };

  const weeks = weekRange(weekStart(new Date(range.start).toISOString()), weekStart(new Date(range.end).toISOString()));
  const weekly = weeks.map((week): IssueWeekRow => {
    const weekMs = instant(`${week}T00:00:00Z`);
    const closedThisWeek = completed.filter((t) => weekStart(t.issue.closedAt) === week);
    const closedByKind = zeroes(ISSUE_COUNTED_KINDS);
    for (const t of closedThisWeek) closedByKind[t.kind]++;
    const cutoff = Math.min(weekMs + WEEK_MS - 1, range.end);
    return {
      week,
      opened: counted.filter((t) => inRange(t.issue.createdAt) && weekStart(t.issue.createdAt) === week).length,
      closed: closedThisWeek.length,
      notPlanned: notPlanned.filter((t) => weekStart(t.issue.closedAt) === week).length,
      closedByKind,
      openAtEnd: counted.filter((t) => isOpenAt(t, cutoff)).length,
      partial: weekMs + WEEK_MS > range.end + 1, // `end` is the last millisecond of the range
    };
  });

  const openByKind = zeroes(ISSUE_COUNTED_KINDS);
  const openByPriority = zeroes(ISSUE_PRIORITY_KEYS);
  for (const t of openAtEnd) {
    openByKind[t.kind]++;
    openByPriority[t.priority ?? "none"]++;
  }

  return {
    repo: { id: repo.id, owner: repo.owner, name: repo.name, lastCrawledAt: repo.lastCrawledAt },
    range: { from: range.from, to: range.to },
    totals: {
      opened: counted.filter((t) => inRange(t.issue.createdAt)).length,
      closed: completed.length,
      notPlanned: notPlanned.length,
      open: openAtEnd.length,
      openEpics: openEpics.length,
    },
    timeToClose: summarise(completed.map((t) => sinceCreated(t.issue, t.issue.closedAt))),
    timeToCloseByPriority: ISSUE_PRIORITY_KEYS.map((priority) => ({
      priority,
      summary: summarise(
        completed.filter((t) => (t.priority ?? "none") === priority).map((t) => sinceCreated(t.issue, t.issue.closedAt)),
      ),
    })),
    weekly,
    openByKind,
    openByPriority,
    ageing: openAtEnd
      .map((t) => ({
        ...refOf(t),
        createdAt: t.issue.createdAt,
        ageHours: Math.max(0, range.end - instant(t.issue.createdAt)) / HOUR_MS,
      }))
      .sort((a, b) => b.ageHours - a.ageHours || a.number - b.number)
      .slice(0, AGEING_LIMIT),
    ageingTotal: openAtEnd.length,
    ideaToProduction: {
      toFirstPr: summarise(completed.map((t) => toFirstPr(t.issue, deliveredOf(t)))),
      toProduction: summarise(completed.map((t) => toProduction(t.issue, deliveredOf(t)))),
    },
    linkedShare: { linked: completed.filter(withPr).length, total: completed.length },
    hygiene: ISSUE_HYGIENE_CHECKS.map((check) => findings[check]),
    staleUrgentDays: STALE_URGENT_DAYS,
  };
}
