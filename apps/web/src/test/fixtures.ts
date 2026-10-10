import type {
  CodeDetailReport,
  CodeHealthReport,
  IssueLabelDefaults,
  IssueAgeingItem,
  IssueRef,
  IssueReport,
  ItemRef,
  RepoListing,
  SpaceHygieneItemCheck,
  SpaceHygieneItemFinding,
  QueueEntry,
  RepoReport,
  ReviewQueue,
  SpaceReport,
  WeekRow,
} from "@dora-dashboard/core";

export function week(overrides: Partial<WeekRow> & Pick<WeekRow, "week" | "weekIndex">): WeekRow {
  return {
    opened: 2,
    merged: 2,
    activeAuthors: 1,
    mergedPerAuthor: 2,
    medianOpenToMergeHours: 5,
    medianCodingHours: 1,
    stages: { coding: 1, waitingForReview: 2, inReview: 1, toMerge: 1 },
    deploys: 1,
    deployFailures: 0,
    partial: false,
    linesMerged: 120,
    ...overrides,
  };
}

export function repo(overrides: Partial<RepoListing> = {}): RepoListing {
  return {
    id: 1,
    owner: "acme",
    name: "widgets",
    deployWorkflows: ["deploy.yml"],
    deployBranch: "main",
    addedAt: "2026-01-01T00:00:00Z",
    lastCrawledAt: "2026-03-01T10:00:00Z",
    crawlStatus: "idle",
    crawlError: null,
    crawlProgress: null,
    pullRequests: 42,
    deployRuns: 10,
    issues: 0,
    issuesEnabled: null,
    issueLabels: null,
    issueLabelsUnreadable: false,
    issueError: null,
    ...overrides,
  };
}

const summary = (median: number | null) => ({
  count: median === null ? 0 : 5,
  median,
  p75: median === null ? null : median * 2,
  mean: median,
});

export function report(
  overrides: { id?: number; name?: string; owner?: string; authorCount?: number } & Partial<RepoReport> = {},
): RepoReport {
  const { id = 1, name = "widgets", owner = "acme", authorCount = 2, ...rest } = overrides;
  return {
    repo: { id, owner, name, deployWorkflows: ["deploy.yml"], deployBranch: "main", lastCrawledAt: "2026-03-01T10:00:00Z" },
    range: { from: "2026-01-05T00:00:00Z", to: "2026-01-25T23:59:59Z" },
    projectStart: "2026-01-05T09:00:00Z",
    totals: {
      opened: 6,
      merged: 6,
      stillOpen: 0,
      closedUnmerged: 0,
      authors: authorCount,
      reviewedShare: 0.5,
      selfMergedShare: 0.25,
      authorWeeks: 3,
      mergedPerAuthorWeek: 2,
      linesMerged: 360,
      linesPerAuthorWeek: 120,
    },
    summary: {
      codingHours: summary(1),
      firstReviewHours: summary(3),
      openToMergeHours: summary(5),
      openToMergeReviewedHours: summary(8),
      openToMergeUnreviewedHours: summary(2),
      cycleHours: summary(6),
      size: summary(40),
    },
    dora: {
      profile: {
        id: "dora-2023",
        name: "DORA 2023",
        source: {
          title: "2023 Accelerate State of DevOps Report",
          year: 2023,
          url: "https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf",
        },
      },
      deploymentFrequency: { perWeek: 1, total: 3, weeks: 3, band: "high" },
      leadTime: { medianHours: 30, count: 4, band: "high" },
      changeFailure: { rate: 0.25, failed: 1, total: 4, band: "low", revertPrs: 0, rework: { rate: 0.25, deploys: 1, total: 4 } },
      timeToRestore: { medianHours: 2, count: 1, band: "high" },
    },
    doraDrivers: {
      position: {
        deploymentFrequency: { band: "high", next: "elite", threshold: 7, gap: 6 },
        leadTime: { band: "high", next: "elite", threshold: 24, gap: 6 },
        changeFailure: { band: "low", next: "medium", threshold: 0.15, gap: 0.1 },
        timeToRestore: { band: "high", next: "elite", threshold: 1, gap: 1 },
      },
      leadTime: {
        count: 4,
        meanHours: 36,
        p75Hours: 48,
        // Shares of the 36 hour mean: 18 / 36, 9 / 36, 4.5 / 36 twice.
        parts: [
          { part: "coding", meanHours: 18, share: 0.5 },
          { part: "waitingForReview", meanHours: 9, share: 0.25 },
          { part: "inReview", meanHours: 4.5, share: 0.125 },
          { part: "toMerge", meanHours: 4.5, share: 0.125 },
          { part: "toDeploy", meanHours: 0, share: 0 },
        ],
        size: summary(40),
      },
      deploymentFrequency: { deploys: 3, completeWeeks: 3, weeksWithoutDeploy: 0, prsPerDeploy: summary(2) },
      changeFailure: {
        failed: 1,
        total: 4,
        byWorkflow: [{ workflow: "deploy.yml", failed: 1, total: 4 }],
        rework: { deploys: 1, total: 4 },
      },
      timeToRestore: { streaks: 1, failedRunsPerStreak: summary(1), longestHours: 2, unrecovered: null },
    },
    aiCohorts: {
      assisted: { prs: 2, medianCycleHours: 4, p75CycleHours: 6, medianSize: 30, reviewedShare: 1, revertShare: 0 },
      unassisted: { prs: 4, medianCycleHours: 10, p75CycleHours: 20, medianSize: 50, reviewedShare: 0.5, revertShare: 0.25 },
      unknown: 3,
    },
    weekly: [
      week({ week: "2026-01-05", weekIndex: 0 }),
      week({ week: "2026-01-12", weekIndex: 1, deployFailures: 1 }),
      week({ week: "2026-01-19", weekIndex: 2, stages: null, medianOpenToMergeHours: null }),
    ],
    distribution: [
      { key: "lt1h", label: "< 1 hour", short: "< 1h", count: 1, share: 1 / 6 },
      { key: "1to4h", label: "1 to 4 hours", short: "1 to 4h", count: 2, share: 2 / 6 },
      { key: "4to24h", label: "4 to 24 hours", short: "4 to 24h", count: 3, share: 3 / 6 },
    ],
    authors: [
      { author: "ada", opened: 4, merged: 4, medianOpenToMergeHours: 4, medianCodingHours: 1, reviewsGiven: 2 },
      { author: "grace", opened: 2, merged: 2, medianOpenToMergeHours: 6, medianCodingHours: 2, reviewsGiven: 3 },
    ],
    authorChoices: [
      { author: "ada", opened: 4, excluded: false },
      { author: "grace", opened: 2, excluded: false },
    ],
    prs: [
      {
        number: 7,
        title: "Add widget sorting",
        url: "https://github.com/acme/widgets/pull/7",
        author: "ada",
        createdAt: "2026-01-06T10:00:00Z",
        mergedAt: "2026-01-06T15:00:00Z",
        codingHours: 1,
        firstReviewHours: 2,
        approvalHours: 3,
        openToMergeHours: 5,
        cycleHours: 6,
        stages: { coding: 1, waitingForReview: 2, inReview: 1, toMerge: 2 },
        reviewed: true,
        reviewerCount: 1,
        reviewRounds: 1,
        size: 0,
      },
      {
        number: 8,
        title: "Fix gadget rendering",
        url: "https://github.com/acme/widgets/pull/8",
        author: "grace",
        createdAt: "2026-01-13T10:00:00Z",
        mergedAt: null,
        codingHours: 2,
        firstReviewHours: null,
        approvalHours: null,
        openToMergeHours: null,
        cycleHours: null,
        stages: null,
        reviewed: false,
        reviewerCount: 0,
        reviewRounds: 0,
        size: 300,
      },
    ],
    ...rest,
  };
}

export function queueEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  const number = overrides.number ?? 1;
  const repoId = overrides.repoId ?? 1;
  return {
    key: `${repoId}#${number}`,
    repoId,
    repo: "acme/widgets",
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    author: "casey",
    authorIsBot: false,
    lane: "awaiting_review",
    band: "fresh",
    waitHours: 2,
    waitingSince: "2026-03-02T09:00:00Z",
    requestedReviewers: [{ name: "robin", isTeam: false }],
    requestedReviewerCount: 1,
    additions: 20,
    deletions: 5,
    changedFiles: 2,
    checks: "passing",
    isDraft: false,
    labels: [],
    ticketKeys: [],
    headRef: `feature-${number}`,
    updatedAt: "2026-03-02T09:00:00Z",
    idleDays: 0,
    ...overrides,
  };
}

const zeroLanes = { held: 0, with_author: 0, approved: 0, awaiting_review: 0, no_reviewer: 0 };

/** A queue with one stale unreviewed PR, one overdue awaiting review, one approved, one draft and one bot PR. */
export function reviewQueue(overrides: Partial<ReviewQueue> = {}): ReviewQueue {
  const entries = [
    queueEntry({
      number: 10,
      title: "Rework billing",
      lane: "no_reviewer",
      band: "stale",
      waitHours: 288,
      requestedReviewers: [],
      requestedReviewerCount: 0,
      ticketKeys: ["ACME-7"],
    }),
    queueEntry({
      number: 11,
      title: "Add export",
      lane: "awaiting_review",
      band: "overdue",
      waitHours: 40,
      ticketKeys: ["ACME-7"],
    }),
    queueEntry({
      number: 12,
      title: "Tidy docs",
      lane: "approved",
      band: "fresh",
      waitHours: 1,
      requestedReviewers: [],
      requestedReviewerCount: 0,
    }),
    queueEntry({
      number: 13,
      title: "Draft spike",
      lane: "held",
      isDraft: true,
      band: "ageing",
      waitHours: 6,
      requestedReviewers: [],
      requestedReviewerCount: 0,
    }),
    queueEntry({
      number: 14,
      title: "Bump deps",
      author: "dependabot",
      authorIsBot: true,
      lane: "awaiting_review",
      band: "ageing",
      waitHours: 5,
    }),
    queueEntry({ number: 15, title: "Fix retry", lane: "with_author", band: "fresh", waitHours: 3, checks: "failing" }),
  ];
  return {
    now: "2026-03-09T10:00:00Z",
    fetchedAt: "2026-03-09T09:58:00Z",
    entries,
    tiles: {
      waiting: { count: 3, repos: 1, heldForRedChecks: 1 },
      pastDay: { count: 2, longestHours: 288 },
      noReviewer: { count: 1, oldestHours: 288 },
      stale: { count: 1, longestHours: 288 },
      fastLane: { count: 2 },
      idle: { count: 0 },
    },
    repos: [
      {
        repoId: 1,
        repo: "acme/widgets",
        open: 6,
        bands: { fresh: 0, ageing: 1, overdue: 1, stale: 1 },
        lanes: { ...zeroLanes, no_reviewer: 1, awaiting_review: 2, approved: 1, held: 1, with_author: 1 },
      },
    ],
    needsAttention: ["1#10", "1#11"],
    features: [
      {
        id: "ACME-7",
        title: "ACME-7",
        evidence: ["ticket"],
        ticketKeys: ["ACME-7"],
        members: [
          {
            key: "1#10",
            repoId: 1,
            repo: "acme/widgets",
            number: 10,
            title: "Rework billing",
            url: "https://github.com/acme/widgets/pull/10",
            lane: "no_reviewer",
            waitHours: 288,
          },
          {
            key: "1#11",
            repoId: 1,
            repo: "acme/widgets",
            number: 11,
            title: "Add export",
            url: "https://github.com/acme/widgets/pull/11",
            lane: "awaiting_review",
            waitHours: 40,
          },
        ],
        lanes: { ...zeroLanes, no_reviewer: 1, awaiting_review: 1 },
        longestWaitHours: 288,
      },
    ],
    errors: [],
    warnings: [],
    ...overrides,
  };
}

/** A finding for a check that lists delivery items; pull request and bulk move findings are written out in full. */
const hygiene = (check: SpaceHygieneItemCheck, overrides: Partial<SpaceHygieneItemFinding> = {}): SpaceHygieneItemFinding => ({
  check,
  count: 0,
  of: null,
  items: [],
  ...overrides,
});

const issue = (key: string, assigned: boolean, assignee?: string | null): ItemRef => ({
  key,
  type: "Story",
  summary: `Summary of ${key}`,
  assigned,
  ...(assignee === undefined ? {} : { assignee }),
});

/** A space report for the space WID on https://acme.example.test (ADR 0009). Names appear only when asked for. */
export function spaceReport(options: { people?: boolean } = {}): SpaceReport {
  /** Assigned unless the name is null; pass `assigned` for someone assigned whose name was not recorded. */
  const named = (key: string, name: string | null, assigned = name !== null) =>
    issue(key, assigned, options.people ? name : undefined);
  return {
    space: {
      id: 7,
      key: "WID",
      name: "Widgets",
      siteUrl: "https://acme.example.test",
      lastCrawledAt: "2026-03-01T10:00:00Z",
      crawlStatus: "idle",
      crawlError: null,
      board: "read",
    },
    range: { from: "2026-01-05", to: "2026-01-25" },
    repos: [{ id: 1, name: "acme/widgets" }],
    totals: { done: 12, inProgress: 3, created: 15, epicsOpen: 2 },
    issueCycleTime: { count: 10, median: 30, p75: 60, mean: 40 },
    issueLeadTime: { count: 12, median: 72, p75: 120, mean: 90 },
    weekly: [
      { week: "2026-01-05", doneByType: { Story: 3, Bug: 1 }, done: 4, inProgress: 2, partial: false },
      { week: "2026-01-12", doneByType: { Story: 2, Task: 1 }, done: 3, inProgress: 3, partial: false },
      { week: "2026-01-19", doneByType: { Story: 5 }, done: 5, inProgress: 3, partial: true },
    ],
    ageing: [
      {
        key: "WID-9",
        type: "Bug",
        summary: "Oldest bug",
        assigned: true,
        status: "In review",
        startedAt: "2026-01-01T09:00:00Z",
        ageHours: 240,
      },
      {
        key: "WID-10",
        type: "Story",
        summary: "Newer story",
        assigned: true,
        status: "In progress",
        startedAt: "2026-01-10T09:00:00Z",
        ageHours: 24,
      },
    ],
    columns: [
      { column: "In progress", meanHours: 20, medianHours: 18, items: 10 },
      { column: "In review", meanHours: 10, medianHours: 6, items: 9 },
      { column: null, meanHours: 2, medianHours: 1, items: 2 },
    ],
    flowEfficiency: 0.4,
    ideaToProduction: {
      toFirstPr: { count: 8, median: 50, p75: 90, mean: 60 },
      toProduction: { count: 7, median: 100, p75: 200, mean: 120 },
      linked: 8,
      of: 12,
    },
    hygiene: [
      hygiene("in_progress_unassigned", { count: 1, items: [named("WID-20", null)] }),
      {
        check: "pr_without_key",
        count: 2,
        of: 8,
        pullRequests: [
          { repo: "acme/widgets", number: 5, title: "Tidy the readme", url: "https://github.com/acme/widgets/pull/5" },
          { repo: "acme/widgets", number: 6, title: "Bump deps", url: "https://github.com/acme/widgets/pull/6" },
        ],
      },
      hygiene("done_without_pr", {
        count: 3,
        of: 12,
        items: [named("WID-1", "Zoe Example"), named("WID-2", "Ann Example"), named("WID-3", "Ann Example")],
      }),
      hygiene("skipped_in_progress"),
      {
        check: "bulk_move",
        count: 5,
        of: 12,
        items: [],
        batches: [{ at: "2026-01-16T15:00:00Z", keys: ["WID-1", "WID-2", "WID-3", "WID-4", "WID-5"] }],
      },
      // WID-31 is assigned, but to someone whose name the space did not record.
      hygiene("reopened", { count: 2, items: [named("WID-30", "Ann Example"), named("WID-31", null, true)] }),
      hygiene("stale_in_progress", {
        count: 12,
        items: Array.from({ length: 12 }, (_, i) => named(`WID-${100 + i}`, "Ann Example")),
      }),
    ],
  };
}

const issueUrl = (number: number) => `https://github.com/acme/widgets/issues/${number}`;

/** An issue as a report lists it. The assignee's name is present only when names were asked for (ADR 0008). */
function issueRef(
  options: { people?: boolean },
  number: number,
  title: string,
  kind: IssueRef["kind"],
  priority: IssueRef["priority"],
  assignee: string | null,
): IssueRef {
  return {
    number,
    title,
    url: issueUrl(number),
    kind,
    priority,
    assigned: assignee !== null,
    ...(options.people ? { assignee } : {}),
  };
}

/**
 * A GitHub Issues report for acme/widgets, 5 to 21 January 2026, so the last week is a part week. The weeks add up
 * to the totals. Opened 6 + 5 + 4 = 15 and closed 4 + 5 + 3 = 12, with the open count walking 5, 5, then 5 + 4 - 3 = 6.
 */
export function issueReport(options: { people?: boolean } = {}): IssueReport {
  const ref = (...args: [number, string, IssueRef["kind"], IssueRef["priority"], string | null]) => issueRef(options, ...args);
  const noKinds = { bug: 0, feature: 0, maintenance: 0, incident: 0, security: 0, other: 0 };
  const aged = (item: IssueRef, ageHours: number): IssueAgeingItem => ({
    ...item,
    createdAt: "2026-01-01T09:00:00Z",
    ageHours,
  });
  return {
    repo: { id: 1, owner: "acme", name: "widgets", lastCrawledAt: "2026-03-01T10:00:00Z" },
    range: { from: "2026-01-05", to: "2026-01-21" },
    staleUrgentDays: 14,
    totals: { opened: 15, closed: 12, notPlanned: 2, open: 6, openEpics: 2 },
    timeToClose: { count: 12, median: 48, p75: 120, mean: 70 },
    timeToCloseByPriority: [
      { priority: "P0", summary: { count: 2, median: 10, p75: 12, mean: 10 } },
      { priority: "P1", summary: { count: 3, median: 30, p75: 50, mean: 35 } },
      { priority: "P2", summary: { count: 4, median: 72, p75: 100, mean: 80 } },
      { priority: "P3", summary: { count: 0, median: null, p75: null, mean: null } },
      { priority: "P4", summary: { count: 0, median: null, p75: null, mean: null } },
      { priority: "none", summary: { count: 3, median: 100, p75: 150, mean: 110 } },
    ],
    weekly: [
      {
        week: "2026-01-05",
        opened: 6,
        closed: 4,
        notPlanned: 1,
        closedByKind: { ...noKinds, bug: 2, feature: 1, maintenance: 1 },
        openAtEnd: 5,
        partial: false,
      },
      {
        week: "2026-01-12",
        opened: 5,
        closed: 5,
        notPlanned: 1,
        closedByKind: { ...noKinds, bug: 1, feature: 3, incident: 1 },
        openAtEnd: 5,
        partial: false,
      },
      {
        week: "2026-01-19",
        opened: 4,
        closed: 3,
        notPlanned: 0,
        closedByKind: { ...noKinds, feature: 2, other: 1 },
        openAtEnd: 6,
        partial: true,
      },
    ],
    openByKind: { bug: 2, feature: 2, maintenance: 1, incident: 0, security: 1, other: 0 },
    openByPriority: { P0: 1, P1: 1, P2: 2, P3: 0, P4: 0, none: 2 },
    ageing: [
      aged(ref(7, "Crash on save", "bug", "P1", "Ann Example"), 480),
      aged(ref(12, "Export is slow", "feature", null, "Zoe Example"), 300),
      aged(ref(15, "Token leaks in logs", "security", "P0", null), 120),
      aged(ref(18, "Upgrade the build image", "maintenance", "P2", "Ann Example"), 96),
      aged(ref(20, "Wrong total on invoice", "bug", "P2", null), 48),
      aged(ref(22, "Tidy the settings page", "other", null, null), 24),
    ],
    ageingTotal: 6,
    ideaToProduction: {
      toFirstPr: { count: 8, median: 20, p75: 40, mean: 25 },
      toProduction: { count: 7, median: 50, p75: 120, mean: 70 },
    },
    linkedShare: { linked: 8, total: 12 },
    // Listed out of the report's own order, so a page has to sort them.
    hygiene: [
      {
        check: "pr_without_issue",
        count: 2,
        of: 10,
        pullRequests: [
          { repo: "acme/widgets", number: 5, title: "Tidy the readme", url: "https://github.com/acme/widgets/pull/5" },
          { repo: "acme/widgets", number: 6, title: "Bump deps", url: "https://github.com/acme/widgets/pull/6" },
        ],
      },
      { check: "unclassified", count: 1, of: 6, items: [ref(22, "Tidy the settings page", "other", null, null)] },
      { check: "stale_urgent", count: 0, of: 3, items: [] },
      { check: "urgent_unassigned", count: 1, of: 2, items: [ref(15, "Token leaks in logs", "security", "P0", null)] },
      { check: "reopened", count: 1, of: null, items: [ref(9, "Login loop", "bug", "P1", "Ann Example")] },
      {
        check: "closed_without_pr",
        count: 3,
        of: 12,
        items: [
          ref(3, "Fix typo", "maintenance", null, "Zoe Example"),
          ref(4, "Retire old flag", "maintenance", null, "Ann Example"),
          ref(5, "Answer a question", "other", null, "Ann Example"),
        ],
      },
    ],
  };
}

/** What `GET /api/issue-labels/defaults` answers: the names the API classifies with and the limits it enforces. */
export function issueLabelDefaults(): IssueLabelDefaults {
  return {
    kinds: {
      bug: ["bug", "defect", "regression"],
      feature: ["feature", "enhancement", "feature request", "story"],
      maintenance: ["chore", "maintenance", "tech-debt"],
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
    limits: { names: 30, length: 100 },
  };
}

const codeHotspot = {
  file: "src/pipeline.ts",
  language: "TypeScript",
  name: "runPipeline",
  startLine: 42,
  ccn: 31,
  nloc: 90,
  params: 3,
};

// 120 source functions. Above 10 there are 12 + 6 = 18 (15%), above 20 there are 6 (5%). 12 functions (10%) are
// over 60 lines. Nine of 36 qualifying pull requests changed tests (25%).
export function codeHealthReport(overrides: Partial<CodeHealthReport> = {}): CodeHealthReport {
  return { ...codeHealthBase, ...overrides };
}

const codeHealthBase: CodeHealthReport = {
  status: "ok",
  commitSha: "abcdef0123456789",
  analysedAt: "2026-03-01T10:00:00Z",
  thresholds: { warn: 10, high: 20 },
  functions: 120,
  nloc: 4500,
  ccn: { mean: 4.2, median: 3, p75: 6, max: 31 },
  shareAboveWarn: 0.15,
  shareAboveHigh: 0.05,
  countAboveWarn: 18,
  countAboveHigh: 6,
  mostComplex: codeHotspot,
  distribution: [
    { label: "1 to 5", min: 1, max: 5, count: 80 },
    { label: "6 to 10", min: 6, max: 10, count: 22 },
    { label: "11 to 20", min: 11, max: 20, count: 12 },
    { label: "21 to 50", min: 21, max: 50, count: 6 },
    { label: "Over 50", min: 51, max: null, count: 0 },
  ],
  languages: [{ language: "TypeScript", functions: 120, nloc: 4500, meanCcn: 4.2 }],
  hotspots: [
    { ...codeHotspot, shape: "dense", lineShare: 0.02, onPath: true },
    {
      ...codeHotspot,
      name: "parse",
      file: "src/util.ts",
      startLine: 7,
      ccn: 22,
      nloc: 40,
      shape: "branching",
      lineShare: 0.01,
      onPath: false,
    },
  ],
  nextBand: {
    from: "medium",
    to: "high",
    functions: [codeHotspot, { ...codeHotspot, name: "parse", file: "src/util.ts", startLine: 7, ccn: 22, nloc: 40 }],
    lines: 130,
  },
  partlyMeasured: [],
  unmeasuredFiles: 0,
  tests: { functions: 35, nloc: 2000 },
  maintainability: { linesAboveWarn: 0.08, linesAboveHigh: 0.04, longFunctions: 0.1, manyParams: 0.01 },
  testing: { testRatio: 0.45, prsWithTests: { share: 0.25, withTests: 9, total: 36 }, ciRunsTests: true, coverageFloor: 40 },
  hygiene: {
    linterConfigured: true,
    formatterConfigured: true,
    ciRunsLinter: false,
    ciChecksFormat: true,
    onlyEditorconfig: false,
    linters: ["eslint"],
    formatters: ["prettier"],
    ciLinters: [],
    ciFormatChecks: ["prettier"],
  },
  tooling: {
    linters: ["eslint"],
    formatters: ["prettier"],
    weakFormatters: ["editorconfig"],
    ciLinters: [],
    ciFormatChecks: ["prettier"],
    ciRunsTests: true,
    coverageFloor: 40,
  },
  longestFunction: { ...codeHotspot, name: "RepoCharts", file: "src/RepoCharts.tsx", startLine: 30, ccn: 12, nloc: 233 },
  grade: {
    overall: { part: "maintainability", band: "low", check: "longFunctions", reason: "unused" },
    maintainability: { band: "low", check: "longFunctions", reason: "unused" },
    testing: { band: "medium", check: "prsWithTests", reason: "unused" },
    hygiene: { band: "high", check: "ciLinter", reason: "unused" },
  },
  checks: [
    { part: "maintainability", check: "linesAboveWarn", value: 0.03, band: "elite", count: 3, limits: false },
    { part: "maintainability", check: "linesAboveHigh", value: 0.04, band: "medium", count: 6, limits: false },
    { part: "maintainability", check: "longFunctions", value: 0.1, band: "low", count: 12, limits: true },
    { part: "maintainability", check: "manyParams", value: 0.005, band: "elite", count: 1, limits: false },
    { part: "testing", check: "testRatio", value: 0.45, band: "high", met: false, limits: false },
    { part: "testing", check: "prsWithTests", value: 0.25, band: "medium", met: false, count: 9, total: 36, limits: true },
    { part: "testing", check: "ciRunsTests", value: true, band: "elite", met: true, limits: false },
    { part: "testing", check: "coverageFloor", value: 40, band: "high", met: false, limits: false },
    { part: "hygiene", check: "linter", value: true, met: true, detail: ["eslint"], limits: false },
    { part: "hygiene", check: "formatter", value: true, met: true, detail: ["prettier"], limits: false },
    { part: "hygiene", check: "ciLinter", value: false, met: false, detail: [], limits: true },
    { part: "hygiene", check: "ciFormat", value: true, met: true, detail: ["prettier"], limits: false },
  ],
};

const detailFunction = {
  file: "apps/api/src/pipeline.ts",
  language: "TypeScript",
  name: "runPipeline",
  startLine: 42,
  endLine: 130,
  ccn: 31,
  nloc: 90,
  params: 3,
};

/**
 * A detailed code analysis of acme/widgets in workspace mode, with two packages, no coverage and no failures.
 * Package apps/api holds 90 of the 130 source lines, so it comes first.
 */
export function codeDetailReport(overrides: Partial<CodeDetailReport> = {}): CodeDetailReport {
  const figures = codeHealthReport();
  return {
    status: "ok",
    commitSha: "abcdef0123456789",
    analysedAt: "2026-03-01T10:00:00Z",
    thresholds: { warn: 10, high: 20 },
    mode: "workspace",
    areas: {
      total: 2,
      items: [
        {
          path: "apps/api",
          kind: "workspace",
          files: 12,
          functions: 40,
          nloc: 90,
          meanCcn: 5.5,
          countAboveWarn: 4,
          countAboveHigh: 1,
          nlocAboveWarn: 41,
          testFunctions: 10,
          testNloc: 300,
          coverage: null,
          maintainabilityBand: "low",
        },
        {
          path: "packages/core",
          kind: "workspace",
          files: 5,
          functions: 20,
          nloc: 40,
          meanCcn: 2.5,
          countAboveWarn: 0,
          countAboveHigh: 0,
          nlocAboveWarn: 0,
          testFunctions: 8,
          testNloc: 200,
          coverage: null,
          maintainabilityBand: "elite",
        },
      ],
    },
    area: null,
    scope: {
      functions: figures.functions,
      nloc: figures.nloc,
      ccn: figures.ccn,
      shareAboveWarn: figures.shareAboveWarn,
      shareAboveHigh: figures.shareAboveHigh,
      countAboveWarn: figures.countAboveWarn,
      countAboveHigh: figures.countAboveHigh,
      mostComplex: detailFunction,
      distribution: figures.distribution,
      languages: figures.languages,
      hotspots: figures.hotspots,
      nextBand: figures.nextBand,
      tests: figures.tests,
      maintainability: figures.maintainability,
      maintainabilityChecks: figures.checks.filter((c) => c.part === "maintainability"),
      maintainabilityBand: "low",
      longestFunction: figures.longestFunction,
      partlyMeasured: [],
    },
    functions: {
      total: 1,
      items: [{ ...detailFunction, area: "apps/api", coverage: null }],
    },
    coverage: { status: "none" },
    ...overrides,
  };
}

/** The `ok` coverage view for acme/widgets, measured on the analysed commit. Override any part of it. */
export function coverageOk(overrides: Record<string, unknown> = {}): CodeDetailReport["coverage"] {
  return {
    status: "ok",
    source: {
      artefacts: ["coverage-api"],
      artefactsInRun: 1,
      runId: 77,
      commitSha: "abcdef0123456789",
      fetchedAt: "2026-03-01T12:00:00Z",
      createdAt: "2026-02-28T16:30:00Z",
      formats: ["lcov"],
      unreadableFiles: 0,
    },
    otherCommit: false,
    lineDetail: true,
    filesInScope: 9,
    lines: { covered: 80, total: 100, share: 0.8 },
    branches: { covered: 15, total: 30, share: 0.5 },
    functions: { covered: 9, total: 10, share: 0.9 },
    files: { inReport: 10, matched: 9, unmatched: 1 },
    leastCovered: {
      total: 1,
      items: [
        {
          path: "apps/api/src/pipeline.ts",
          area: "apps/api",
          lines: { covered: 10, total: 40 },
          uncovered: {
            total: 3,
            items: [
              [12, 30],
              [44, 44],
            ],
          },
        },
      ],
    },
    notInReport: { total: 1, items: [{ path: "apps/api/src/orphan.ts", area: "apps/api", functions: 3, nloc: 25 }] },
    notInReportOtherKinds: 0,
    untestedComplex: {
      total: 1,
      items: [{ ...detailFunction, area: "apps/api", coverage: 0 }],
    },
    ...overrides,
  } as CodeDetailReport["coverage"];
}
