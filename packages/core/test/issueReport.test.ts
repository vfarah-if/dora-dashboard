import { describe, expect, it } from "vitest";
import {
  buildIssueReport,
  AGEING_LIMIT,
  ISSUE_HYGIENE_CHECKS,
  STALE_URGENT_DAYS,
  type IssueHygieneCheck,
  type IssueHygieneFinding,
  type IssueReport,
  type IssueReportOptions,
} from "../src/issueReport.js";
import type { DeployRun, PullRequest, RepoIssue } from "../src/types.js";
import { closedIssue, deploy, issue, pr } from "./issue.js";

const NOW = "2026-10-07T12:00:00Z"; // a Wednesday; the week starts on Monday 2026-10-05
const repo = { id: 21, owner: "acme", name: "widgets", deployBranch: "main", lastCrawledAt: "2026-10-07T08:00:00Z" };
const EMPTY = { count: 0, median: null, p75: null, mean: null };

const build = (issues: RepoIssue[], options: Partial<IssueReportOptions> = {}, prs: PullRequest[] = [], runs: DeployRun[] = []) =>
  buildIssueReport(repo, issues, prs, runs, { now: NOW, ...options });

const finding = <C extends IssueHygieneCheck>(report: IssueReport, check: C) =>
  report.hygiene.find((f): f is IssueHygieneFinding & { check: C } => f.check === check)!;
const numbers = (refs: { number: number }[]) => refs.map((r) => r.number);

describe("buildIssueReport with nothing to report", () => {
  const report = build([]);

  it("names the repository and ranges over today alone", () => {
    expect(report.repo).toEqual({ id: 21, owner: "acme", name: "widgets", lastCrawledAt: "2026-10-07T08:00:00Z" });
    expect(report.range).toEqual({ from: "2026-10-07", to: "2026-10-07" });
  });

  it("gives zero counts and empty summaries", () => {
    expect(report.totals).toEqual({ opened: 0, closed: 0, notPlanned: 0, open: 0, openEpics: 0 });
    expect(report.timeToClose).toEqual(EMPTY);
    expect(report.ageing).toEqual([]);
    expect(report.ageingTotal).toBe(0);
    expect(report.linkedShare).toEqual({ linked: 0, total: 0 });
    expect(report.ideaToProduction).toEqual({ toFirstPr: EMPTY, toProduction: EMPTY });
  });

  it("lists all six priorities, in order, with a count of zero", () => {
    expect(report.timeToCloseByPriority).toEqual(
      ["P0", "P1", "P2", "P3", "P4", "none"].map((priority) => ({ priority, summary: EMPTY })),
    );
  });

  it("gives every hygiene check, in the published order, with a count of zero", () => {
    expect(report.hygiene.map((f) => f.check)).toEqual([...ISSUE_HYGIENE_CHECKS]);
    expect(report.hygiene.map((f) => f.count)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("publishes the stale threshold as fourteen days", () => {
    expect(STALE_URGENT_DAYS).toBe(14);
  });
});

describe("the range", () => {
  it("starts at the earliest issue's creation and ends today by default", () => {
    const report = build([
      issue({ number: 1, createdAt: "2026-09-30T08:00:00Z" }),
      issue({ number: 2, createdAt: "2026-10-02T00:00:00Z" }),
    ]);
    expect(report.range).toEqual({ from: "2026-09-30", to: "2026-10-07" });
  });

  it("stops at now when `to` lies in the future", () => {
    expect(build([issue({ number: 1 })], { to: "2026-12-31" }).range.to).toBe("2026-10-07");
  });

  it("honours a `from` and a `to` that lie in the past, taking only the date of each", () => {
    const report = build([issue({ number: 1 })], { from: "2026-09-10T15:00:00Z", to: "2026-09-20" });
    expect(report.range).toEqual({ from: "2026-09-10", to: "2026-09-20" });
  });

  it("counts a close at the very end of the last day, and not one a millisecond later", () => {
    const issues = [
      closedIssue({ number: 1, closedAt: "2026-09-20T23:59:59.999Z" }),
      closedIssue({ number: 2, closedAt: "2026-09-21T00:00:00Z" }),
    ];
    expect(build(issues, { from: "2026-09-01", to: "2026-09-20" }).totals.closed).toBe(1);
  });
});

describe("weeks", () => {
  const issues = [issue({ number: 1, createdAt: "2026-09-16T00:00:00Z" })];

  it("lists every week from the one the range starts in to the one it ends in, with empty weeks as zero", () => {
    const weeks = build(issues).weekly;
    expect(weeks.map((w) => w.week)).toEqual(["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"]);
    expect(weeks.map((w) => w.opened)).toEqual([1, 0, 0, 0]);
  });

  it("keeps the part week and flags only it, when the range ends in the week of now", () => {
    expect(build(issues).weekly.map((w) => w.partial)).toEqual([false, false, false, true]);
  });

  it("does not flag a week whose last day is the last day of the range", () => {
    const weeks = build(issues, { to: "2026-10-04" }).weekly;
    expect(weeks.map((w) => [w.week, w.partial])).toEqual([
      ["2026-09-14", false],
      ["2026-09-21", false],
      ["2026-09-28", false],
    ]);
  });

  it("flags the week the range ends in when it ends mid-week", () => {
    const weeks = build(issues, { to: "2026-09-23" }).weekly;
    expect(weeks.map((w) => w.partial)).toEqual([false, true]);
  });
});

describe("flow over a range", () => {
  // Range Monday 14 to Sunday 27 September 2026.
  const issues = [
    closedIssue({ number: 1, createdAt: "2026-09-14T00:00:00Z", closedAt: "2026-09-14T10:00:00Z", labels: ["bug", "p1"] }),
    closedIssue({ number: 2, createdAt: "2026-09-15T00:00:00Z", closedAt: "2026-09-17T00:00:00Z", labels: ["enhancement"] }),
    closedIssue({ number: 3, createdAt: "2026-09-16T00:00:00Z", closedAt: "2026-09-19T00:00:00Z", labels: ["bug", "p1"] }),
    closedIssue({
      number: 4,
      createdAt: "2026-09-17T00:00:00Z",
      closedAt: "2026-09-18T00:00:00Z",
      closeReason: "not_planned",
      labels: ["bug"],
    }),
    closedIssue({
      number: 5,
      createdAt: "2026-09-18T00:00:00Z",
      closedAt: "2026-09-19T00:00:00Z",
      closeReason: "duplicate",
    }),
    closedIssue({ number: 6, createdAt: "2026-09-14T12:00:00Z", closedAt: "2026-09-15T00:00:00Z", labels: ["epic"] }),
    // Closed with no reason and no events: counted as completed, open from creation to its close.
    issue({
      number: 7,
      state: "closed",
      createdAt: "2026-09-20T00:00:00Z",
      closedAt: "2026-09-20T06:00:00Z",
      updatedAt: "2026-09-20T06:00:00Z",
    }),
    issue({ number: 8, createdAt: "2026-09-21T00:00:00Z" }),
    issue({ number: 9, createdAt: "2026-09-10T00:00:00Z" }),
  ];
  const report = build(issues, { from: "2026-09-14", to: "2026-09-27" });

  it("counts opened, completed, not planned and open, leaving epics out", () => {
    // Opened: 1, 2, 3, 4, 5, 7 and 8; issue 9 was opened before the range and issue 6 is an epic.
    // Open at the end: 8 and 9.
    expect(report.totals).toEqual({ opened: 7, closed: 4, notPlanned: 2, open: 2, openEpics: 0 });
  });

  it("measures creation to the completed close, leaving out epics, not planned and duplicates", () => {
    // Issue 1 took 10 hours, 2 took 48, 3 took 72 and 7 took 6, so 6, 10, 48, 72.
    // Median (10 + 48) / 2 = 29; p75 sits a quarter of the way from 48 to 72, 54; mean 136 / 4 = 34.
    expect(report.timeToClose).toEqual({ count: 4, median: 29, p75: 54, mean: 34 });
  });

  it("measures the same by priority, with a count of zero where nothing fell", () => {
    // P1: issues 1 and 3, 10 and 72 hours. None: issues 2 and 7, 48 and 6 hours.
    expect(report.timeToCloseByPriority).toEqual([
      { priority: "P0", summary: EMPTY },
      { priority: "P1", summary: { count: 2, median: 41, p75: 56.5, mean: 41 } },
      { priority: "P2", summary: EMPTY },
      { priority: "P3", summary: EMPTY },
      { priority: "P4", summary: EMPTY },
      { priority: "none", summary: { count: 2, median: 27, p75: 37.5, mean: 27 } },
    ]);
  });

  it("builds a row per week with closes counted in the week of the final close", () => {
    // Issue 7 closed on Sunday the 20th, which belongs to the week starting Monday the 14th.
    const none = { bug: 0, feature: 0, maintenance: 0, incident: 0, security: 0, other: 0 };
    expect(report.weekly).toEqual([
      {
        week: "2026-09-14",
        opened: 6,
        closed: 4,
        notPlanned: 2,
        closedByKind: { ...none, bug: 2, feature: 1, other: 1 },
        openAtEnd: 1, // issue 9 only; issue 8 does not exist yet
        partial: false,
      },
      { week: "2026-09-21", opened: 1, closed: 0, notPlanned: 0, closedByKind: none, openAtEnd: 2, partial: false },
    ]);
  });
});

describe("an issue reopened and closed again", () => {
  const reopened = closedIssue({
    number: 1,
    createdAt: "2026-09-14T00:00:00Z",
    closedAt: "2026-09-18T00:00:00Z",
    events: [
      { at: "2026-09-18T00:00:00Z", type: "closed", reason: "completed" },
      { at: "2026-09-16T00:00:00Z", type: "reopened", reason: null }, // out of order on purpose
      { at: "2026-09-15T00:00:00Z", type: "closed", reason: "completed" },
    ],
  });
  const range = { from: "2026-09-14" };

  it("counts one close, measured from creation to the final close", () => {
    const report = build([reopened], { ...range, to: "2026-09-27" });
    expect(report.totals).toMatchObject({ opened: 1, closed: 1, open: 0 });
    expect(report.timeToClose).toEqual({ count: 1, median: 96, p75: 96, mean: 96 });
    expect(report.weekly.map((w) => w.closed)).toEqual([1, 0]);
  });

  it("is open while reopened, replayed from the events", () => {
    // 16 September at 23:59:59.999 falls between the reopen and the final close.
    const report = build([reopened], { ...range, to: "2026-09-16" });
    expect(report.totals).toMatchObject({ closed: 0, open: 1 });
    expect(report.weekly.map((w) => w.openAtEnd)).toEqual([1]);
  });

  it("is closed between the first close and the reopen", () => {
    const report = build([reopened], { ...range, to: "2026-09-15" });
    expect(report.totals).toMatchObject({ opened: 1, closed: 0, open: 0 });
  });

  it("is open again after a reopen that no close follows, whatever the issue's state says", () => {
    const stillOpen = issue({
      number: 2,
      createdAt: "2026-09-14T00:00:00Z",
      events: [
        { at: "2026-09-15T00:00:00Z", type: "closed", reason: "completed" },
        { at: "2026-09-16T00:00:00Z", type: "reopened", reason: null },
      ],
    });
    expect(build([stillOpen], { ...range, to: "2026-09-15" }).totals.open).toBe(0);
    expect(build([stillOpen], { ...range, to: "2026-09-16" }).totals.open).toBe(1);
    expect(build([stillOpen], range).totals.open).toBe(1);
  });

  it("ignores a repeated close and a reopen of an issue that is open", () => {
    const noisy = issue({
      number: 3,
      createdAt: "2026-09-14T00:00:00Z",
      events: [
        { at: "2026-09-13T00:00:00Z", type: "reopened", reason: null },
        { at: "2026-09-15T00:00:00Z", type: "closed", reason: "completed" },
        { at: "2026-09-16T00:00:00Z", type: "closed", reason: "completed" },
      ],
    });
    // Closed on the 15th, so closed by the end of the 15th and not reopened by the 16th.
    expect(build([noisy], { ...range, to: "2026-09-16" }).totals.open).toBe(0);
  });
});

describe("a closed issue whose events hold no close after the last reopen", () => {
  // Transferred in: closed on the 12th according to the host, but the only event read is a reopen on the 10th.
  const transferred = issue({
    number: 8,
    state: "closed",
    closeReason: "completed",
    createdAt: "2026-09-08T00:00:00Z",
    closedAt: "2026-09-12T00:00:00Z",
    updatedAt: "2026-09-12T00:00:00Z",
    events: [{ at: "2026-09-10T00:00:00Z", type: "reopened", reason: null }],
  });

  it("stays open until its final close, then is closed", () => {
    // Open from the 8th to the 12th: open on the 11th, closed by the 13th.
    expect(build([transferred], { from: "2026-09-08", to: "2026-09-11" }).totals.open).toBe(1);
    expect(build([transferred], { from: "2026-09-08", to: "2026-09-13" }).totals.open).toBe(0);
  });

  it("does not sit in the ageing list for ever", () => {
    const report = build([transferred], { from: "2026-09-08", to: "2026-10-07" });
    expect(report.ageing).toEqual([]);
    expect(report.ageingTotal).toBe(0);
  });
});

describe("the ageing list is bounded", () => {
  // 60 open bugs, numbered 1 to 60, each opened one hour after the one before it, so number 1 is the oldest.
  const many = Array.from({ length: 60 }, (_, i) =>
    issue({
      number: i + 1,
      createdAt: `2026-09-01T${String(i % 24).padStart(2, "0")}:00:00Z`.replace(
        "2026-09-01",
        `2026-09-0${1 + Math.floor(i / 24)}`,
      ),
    }),
  );
  const epic = issue({ number: 99, labels: ["epic"], createdAt: "2026-08-01T00:00:00Z" });
  const report = build([...many, epic], { from: "2026-09-01", to: "2026-09-30" });

  it("keeps the oldest AGEING_LIMIT open issues in order and counts them all", () => {
    expect(AGEING_LIMIT).toBe(50);
    expect(report.ageing).toHaveLength(50);
    expect(numbers(report.ageing)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(report.ageingTotal).toBe(60);
  });

  it("leaves an epic out of both", () => {
    expect(report.ageing.some((a) => a.number === 99)).toBe(false);
    expect(report.totals.openEpics).toBe(1);
  });

  it("reports the total as the list length when it is not cut", () => {
    const small = build(many.slice(0, 3), { from: "2026-09-01", to: "2026-09-30" });
    expect(small.ageing).toHaveLength(3);
    expect(small.ageingTotal).toBe(3);
  });
});

describe("open spans without a usable history", () => {
  const range = { from: "2026-09-14", to: "2026-09-17" };

  it("falls back to creation and close when the host held older events than were read", () => {
    // The one event read says closed on the 15th, but the final close was on the 20th, and the events are partial.
    const truncated = closedIssue({
      number: 1,
      createdAt: "2026-09-14T00:00:00Z",
      closedAt: "2026-09-20T00:00:00Z",
      events: [{ at: "2026-09-15T00:00:00Z", type: "closed", reason: "completed" }],
      eventsTruncated: true,
    });
    expect(build([truncated], range).totals.open).toBe(1);
    expect(build([truncated], { ...range, to: "2026-09-20" }).totals.open).toBe(0);
  });

  it("falls back when a closed issue has no events at all", () => {
    const bare = issue({
      number: 2,
      state: "closed",
      closeReason: "completed",
      createdAt: "2026-09-14T00:00:00Z",
      closedAt: "2026-09-20T00:00:00Z",
    });
    expect(build([bare], range).totals.open).toBe(1);
    expect(build([bare], { ...range, to: "2026-09-27" }).totals).toMatchObject({ open: 0, closed: 1 });
  });

  it("keeps an open issue with truncated events open from creation", () => {
    const open = issue({ number: 3, createdAt: "2026-09-14T00:00:00Z", eventsTruncated: true });
    expect(build([open], range).totals.open).toBe(1);
  });

  it("uses the last update when a closed issue somehow has no close date", () => {
    const odd = issue({
      number: 4,
      state: "closed",
      closeReason: "completed",
      createdAt: "2026-09-14T00:00:00Z",
      updatedAt: "2026-09-16T00:00:00Z",
    });
    const report = build([odd], range);
    expect(report.totals).toMatchObject({ closed: 1, open: 0 });
    expect(report.timeToClose.median).toBe(48);
  });
});

describe("epics", () => {
  const issues = [
    issue({ number: 1, createdAt: "2026-09-14T00:00:00Z", labels: ["epic"] }),
    closedIssue({ number: 2, createdAt: "2026-09-14T00:00:00Z", closedAt: "2026-09-16T00:00:00Z", labels: ["epic"] }),
    issue({ number: 3, createdAt: "2026-09-14T00:00:00Z", labels: ["bug"] }),
  ];
  const report = build(issues, { from: "2026-09-14", to: "2026-09-27" });

  it("counts open epics apart and leaves every epic out of the other figures", () => {
    expect(report.totals).toEqual({ opened: 1, closed: 0, notPlanned: 0, open: 1, openEpics: 1 });
    expect(report.timeToClose.count).toBe(0);
    expect(report.openByKind.bug).toBe(1);
    expect(Object.values(report.openByKind).reduce((a, b) => a + b, 0)).toBe(1);
    expect(numbers(report.ageing)).toEqual([3]);
    expect(report.weekly.map((w) => [w.opened, w.closed, w.openAtEnd])).toEqual([
      [1, 0, 1],
      [0, 0, 1],
    ]);
  });

  it("leaves an epic out of the hygiene checks", () => {
    const unlabelled = issue({ number: 4, labels: ["epic"], assignees: [] });
    const found = build([unlabelled]);
    expect(found.hygiene.map((f) => f.count)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("open now", () => {
  // Range from 1 September to now, 7 October 12:00.
  const issues = [
    issue({ number: 21, createdAt: "2026-10-05T12:00:00Z", labels: ["bug", "p0"], assignees: ["dana"] }),
    issue({ number: 22, createdAt: "2026-10-03T12:00:00Z", labels: ["enhancement", "medium"] }),
    issue({ number: 23, createdAt: "2026-10-03T12:00:00Z" }),
    issue({ number: 24, createdAt: "2026-09-01T00:00:00Z", labels: ["epic"] }),
    closedIssue({ number: 25, createdAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-02T00:00:00Z" }),
    issue({ number: 26, createdAt: "2026-10-06T12:00:00Z", labels: ["incident", "critical"] }),
    issue({ number: 27, createdAt: "2026-10-06T12:00:00Z", labels: ["security", "low"] }),
    issue({ number: 28, createdAt: "2026-10-06T12:00:00Z", labels: ["chore", "trivial"] }),
  ];
  const report = build(issues);

  it("counts open issues by kind and by priority, epics left out", () => {
    expect(report.totals.open).toBe(6);
    expect(report.openByKind).toEqual({ bug: 1, feature: 1, maintenance: 1, incident: 1, security: 1, other: 1 });
    expect(report.openByPriority).toEqual({ P0: 2, P1: 0, P2: 1, P3: 1, P4: 1, none: 1 });
  });

  it("lists the open issues oldest first, ties by number, with their age in hours at the end of the range", () => {
    expect(report.ageing.map((a) => [a.number, a.ageHours])).toEqual([
      [22, 96],
      [23, 96],
      [21, 48],
      [26, 24],
      [27, 24],
      [28, 24],
    ]);
  });

  it("describes each aged issue without naming anyone unless asked", () => {
    expect(report.ageing[2]).toEqual({
      number: 21,
      title: "Issue 21",
      url: "https://github.com/acme/widgets/issues/21",
      kind: "bug",
      priority: "P0",
      assigned: true,
      createdAt: "2026-10-05T12:00:00Z",
      ageHours: 48,
    });
    expect(report.ageing.every((a) => !("assignee" in a))).toBe(true);
  });

  it("names the first assignee, or null, behind the people toggle", () => {
    const named = build(issues, { people: true });
    expect(named.ageing.map((a) => [a.number, a.assignee])).toEqual([
      [22, null],
      [23, null],
      [21, "dana"],
      [26, null],
      [27, null],
      [28, null],
    ]);
  });

  it("measures age to the end of the range, not to now, when the range ends earlier", () => {
    const earlier = build(issues, { to: "2026-10-04" });
    // Only issues 22 and 23 existed by then, both created on the 3rd at 12:00; the end is the last millisecond of the 4th.
    expect(earlier.ageing.map((a) => a.number)).toEqual([22, 23]);
    expect(earlier.ageing[0]!.ageHours).toBeCloseTo(36, 3);
  });

  it("reads priorities and kinds through the repository's label override", () => {
    const overridden = build([issue({ number: 1, labels: ["glitch", "sev1"] })], {
      labels: { kinds: { bug: ["glitch"] }, priorities: { P0: ["sev1"] } },
    });
    expect(overridden.openByKind.bug).toBe(1);
    expect(overridden.openByPriority.P0).toBe(1);
  });
});

describe("idea to production", () => {
  // Issues 10 to 13 were opened on 14 September at midnight and completed within the range.
  const created = "2026-09-14T00:00:00Z";
  const closed = (number: number) => closedIssue({ number, createdAt: created, closedAt: "2026-09-18T00:00:00Z" });
  const issues = [10, 11, 12, 13].map(closed);
  const prs = [
    pr({ number: 30, title: "Fix #10", createdAt: "2026-09-14T06:00:00Z", mergedAt: "2026-09-14T12:00:00Z" }),
    pr({ number: 31, title: "Fix #11", createdAt: "2026-09-14T03:00:00Z", mergedAt: "2026-09-14T14:00:00Z" }),
    // Opened but never merged, so it does not hold back production for issue 11.
    pr({ number: 32, headRef: "fix/11-more", createdAt: "2026-09-14T05:00:00Z", state: "OPEN", mergedAt: null }),
    pr({ number: 33, headRef: "feat/12-extra", createdAt: "2026-09-15T12:00:00Z", mergedAt: "2026-09-15T13:00:00Z" }),
  ];
  const runs = [
    deploy(1, "2026-09-13T08:00:00Z"),
    deploy(2, "2026-09-14T13:00:00Z"), // ships pull request 30, done at 13:10
    deploy(3, "2026-09-15T09:00:00Z"), // ships pull request 31, done at 09:10 the next morning
  ];
  const report = build(issues, { from: "2026-09-14", to: "2026-09-27" }, prs, runs);

  it("measures creation to the first linked pull request opened", () => {
    // Issue 10: 6 hours. Issue 11: 3 hours, the earlier of its two. Issue 12: 36 hours. Issue 13 has no pull request.
    // Median 6; p75 halfway from 6 to 36, 21; mean 45 / 3 = 15.
    expect(report.ideaToProduction.toFirstPr).toEqual({ count: 3, median: 6, p75: 21, mean: 15 });
  });

  it("measures creation to the deploy that shipped the merged pull requests, leaving out what has not shipped", () => {
    // Issue 10: 13 hours 10 minutes. Issue 11: 33 hours 10 minutes. Issue 12's pull request merged after the last deploy.
    const { toProduction } = report.ideaToProduction;
    expect(toProduction.count).toBe(2);
    expect(toProduction.median).toBeCloseTo(23 + 1 / 6, 6); // (13 + 1/6 + 33 + 1/6) / 2
    expect(toProduction.mean).toBeCloseTo(23 + 1 / 6, 6);
  });

  it("counts the share of completed issues with a linked pull request", () => {
    expect(report.linkedShare).toEqual({ linked: 3, total: 4 });
  });

  it("measures nothing from pull requests when there are no deploy runs for production", () => {
    const unshipped = build(issues, { from: "2026-09-14", to: "2026-09-27" }, prs, []);
    expect(unshipped.ideaToProduction.toProduction.count).toBe(0);
    expect(unshipped.ideaToProduction.toFirstPr.count).toBe(3);
  });

  it("never measures a negative time when the pull request was opened before the issue", () => {
    const early = [
      closedIssue({
        number: 10,
        createdAt: "2026-09-14T00:00:00Z",
        closedAt: "2026-09-18T00:00:00Z",
        closedBy: [{ repo: "acme/widgets", number: 30 }],
      }),
    ];
    const before = [pr({ number: 30, createdAt: "2026-09-13T00:00:00Z", mergedAt: "2026-09-13T01:00:00Z" })];
    const found = build(early, { from: "2026-09-14", to: "2026-09-27" }, before, []);
    expect(found.ideaToProduction.toFirstPr).toEqual({ count: 1, median: 0, p75: 0, mean: 0 });
  });

  it("measures only issues closed as completed in the range", () => {
    const mixed = [
      closedIssue({ number: 10, createdAt: created, closedAt: "2026-09-18T00:00:00Z", closeReason: "not_planned" }),
      closedIssue({ number: 11, createdAt: created, closedAt: "2026-10-02T00:00:00Z" }),
    ];
    const found = build(mixed, { from: "2026-09-14", to: "2026-09-27" }, prs, runs);
    expect(found.linkedShare).toEqual({ linked: 0, total: 0 });
    expect(found.ideaToProduction.toFirstPr.count).toBe(0);
  });
});

describe("hygiene", () => {
  // Range from 1 September to now, 7 October 12:00, so a week-old issue is stale only past 23 September 12:00.
  const base = { createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z" };
  const issues = [
    closedIssue({ ...base, number: 1, closedAt: "2026-09-10T00:00:00Z", labels: ["bug"] }),
    closedIssue({ ...base, number: 2, closedAt: "2026-09-10T00:00:00Z" }),
    closedIssue({ ...base, number: 3, closedAt: "2026-09-10T00:00:00Z", closeReason: "not_planned" }),
    closedIssue({ ...base, number: 4, closedAt: "2026-09-10T00:00:00Z", labels: ["epic"] }),
    issue({ ...base, number: 5, labels: ["p0"] }),
    issue({ ...base, number: 6, labels: ["high", "bug"], assignees: ["carol"], updatedAt: "2026-09-20T00:00:00Z" }),
    issue({ ...base, number: 7, labels: ["medium"] }),
    issue({ ...base, number: 8, labels: ["incident"], updatedAt: "2026-09-01T00:00:00Z" }),
    issue({ ...base, number: 9, labels: ["security"], updatedAt: "2026-09-23T12:00:00Z" }), // exactly 14 days
    issue({ ...base, number: 10 }),
    issue({ ...base, number: 11, labels: ["ux"] }),
    issue({ ...base, number: 12, title: "P3: Tidy the footer" }),
    issue({
      ...base,
      number: 13,
      labels: ["bug"],
      events: [
        { at: "2026-09-05T00:00:00Z", type: "closed", reason: "completed" },
        { at: "2026-09-08T00:00:00Z", type: "reopened", reason: null },
      ],
    }),
    issue({
      ...base,
      number: 14,
      createdAt: "2026-08-01T00:00:00Z",
      labels: ["bug"],
      events: [
        { at: "2026-08-05T00:00:00Z", type: "closed", reason: "completed" },
        { at: "2026-08-10T00:00:00Z", type: "reopened", reason: null },
      ],
    }),
    closedIssue({ ...base, number: 15, closedAt: "2026-09-12T00:00:00Z", labels: ["p0"] }),
  ];
  const prs = [
    pr({ number: 50, title: "Fix #2", mergedAt: "2026-09-10T00:00:00Z" }),
    pr({ number: 51, title: "Fix #15", mergedAt: "2026-09-12T00:00:00Z" }),
    pr({ number: 52, title: "Tidy the docs", mergedAt: "2026-09-20T00:00:00Z" }),
    pr({ number: 53, title: "Bump a dependency", authorIsBot: true, mergedAt: "2026-09-21T00:00:00Z" }),
    pr({ number: 54, title: "Old work", createdAt: "2026-08-29T00:00:00Z", mergedAt: "2026-08-30T00:00:00Z" }),
    pr({ number: 55, title: "Still open", state: "OPEN", mergedAt: null }),
  ];
  const report = build(issues, { from: "2026-09-01" }, prs);

  it("lists the checks in the published order", () => {
    expect(report.hygiene.map((f) => f.check)).toEqual([
      "closed_without_pr",
      "reopened",
      "urgent_unassigned",
      "stale_urgent",
      "unclassified",
      "pr_without_issue",
    ]);
  });

  it("finds issues completed in the range with no linked pull request, out of all completed", () => {
    // Completed in range: 1, 2 and 15 (3 was not planned, 4 is an epic). Only issue 1 has no pull request.
    const found = finding(report, "closed_without_pr");
    expect(numbers(found.items)).toEqual([1]);
    expect([found.count, found.of]).toEqual([1, 3]);
    expect(found.items[0]).toEqual({
      number: 1,
      title: "Issue 1",
      url: "https://github.com/acme/widgets/issues/1",
      kind: "bug",
      priority: null,
      assigned: false,
    });
  });

  it("finds merged pull requests from people that no issue is linked to, out of all such merged", () => {
    // Merged in range by a person: 50, 51 and 52. Not 53 (a bot), 54 (before the range) or 55 (never merged).
    const found = finding(report, "pr_without_issue");
    expect([found.count, found.of]).toEqual([1, 3]);
    expect(found.pullRequests).toEqual([
      { repo: "acme/widgets", number: 52, title: "Tidy the docs", url: "https://github.com/acme/widgets/pull/52" },
    ]);
  });

  it("finds issues with a reopen in the range, and not one reopened before it", () => {
    const found = finding(report, "reopened");
    expect(numbers(found.items)).toEqual([13]);
    expect([found.count, found.of]).toEqual([1, null]);
  });

  it("finds open P0 and P1 issues nobody is assigned to, out of the open urgent ones", () => {
    // Urgent and open: 5 (P0) and 6 (P1); issue 15 is P0 but closed, and issue 7 is only P2.
    const found = finding(report, "urgent_unassigned");
    expect(numbers(found.items)).toEqual([5]);
    expect([found.count, found.of]).toEqual([1, 2]);
  });

  it("finds open urgent, incident and security issues untouched for more than fourteen days", () => {
    // Candidates: 5, 6, 8 and 9. Issue 5 was updated yesterday; issue 9 exactly 14 days before the end, which is not
    // more than 14; issue 6 was updated 17 days before the end and issue 8 36 days before.
    const found = finding(report, "stale_urgent");
    expect(numbers(found.items)).toEqual([6, 8]);
    expect([found.count, found.of]).toEqual([2, 4]);
  });

  it("finds open issues with neither a kind nor a priority, out of all open", () => {
    // Open, not epics: 5 to 14, ten issues. Of them only 10 and 11 (an unknown label) name neither.
    const found = finding(report, "unclassified");
    expect(numbers(found.items)).toEqual([10, 11]);
    expect([found.count, found.of]).toEqual([2, 10]);
  });

  it("finds nothing when every check passes", () => {
    const clean = build(
      [closedIssue({ ...base, number: 1, closedAt: "2026-09-10T00:00:00Z", labels: ["bug"] })],
      { from: "2026-09-01" },
      [pr({ number: 50, title: "Fix #1", mergedAt: "2026-09-10T00:00:00Z" })],
    );
    expect(clean.hygiene.map((f) => f.count)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(clean.hygiene.map((f) => f.of)).toEqual([1, null, 0, 0, 0, 1]);
  });

  it("names nobody in any finding unless asked", () => {
    const refs = report.hygiene.flatMap((f) => (f.check === "pr_without_issue" ? [] : f.items));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref) => !("assignee" in ref))).toBe(true);
    expect(refs.find((ref) => ref.number === 6)).toMatchObject({ assigned: true });
    expect(JSON.stringify(report)).not.toContain("carol");
  });

  it("names the first assignee, or null, behind the people toggle", () => {
    const named = build(issues, { from: "2026-09-01", people: true }, prs);
    const stale = finding(named, "stale_urgent");
    expect(stale.items.map((ref) => [ref.number, ref.assigned, ref.assignee])).toEqual([
      [6, true, "carol"],
      [8, false, null],
    ]);
  });
});
