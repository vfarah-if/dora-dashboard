import type { RepoReport, WeekRow } from "@dora-dashboard/core";
import type { RepoWithCounts } from "../api/hooks";

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

export function repo(overrides: Partial<RepoWithCounts> = {}): RepoWithCounts {
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
      deploymentFrequency: { perWeek: 1, total: 3, weeks: 3, band: "high" },
      leadTime: { medianHours: 30, count: 4, band: "high" },
      changeFailure: { rate: 0.25, failed: 1, total: 4, band: "low", revertPrs: 0 },
      timeToRestore: { medianHours: 2, count: 1, band: "high" },
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
