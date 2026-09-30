import { describe, expect, it } from "vitest";
import {
  changeFailureBand,
  deployFrequencyBand,
  doraSummary,
  leadTimeBand,
  leadTimes,
  restoreBand,
  restoreTimes,
} from "../src/dora.js";
import { aiAssistance, aiCohorts, DEFAULT_AI_SIGNALS, type AiAssistance } from "../src/aiAssisted.js";
import { DEFAULT_DORA_PROFILE, DORA_PROFILE_IDS, doraProfile, type DoraProfile } from "../src/doraProfiles.js";
import { isBot, mergeDistribution, prTimings } from "../src/pullRequests.js";
import { buildReport } from "../src/report.js";
import { hoursBetween, median, percentile, weekRange, weekStart } from "../src/stats.js";
import type { DeployRun, PullRequest, Repo } from "../src/types.js";

function pr(overrides: Partial<PullRequest> & { number: number }): PullRequest {
  return {
    title: `PR ${overrides.number}`,
    url: `https://github.com/o/r/pull/${overrides.number}`,
    author: "alice",
    authorIsBot: false,
    state: "MERGED",
    createdAt: "2026-09-01T10:00:00Z",
    publishedAt: "2026-09-01T10:00:00Z",
    mergedAt: "2026-09-01T14:00:00Z",
    closedAt: "2026-09-01T14:00:00Z",
    updatedAt: "2026-09-01T14:00:00Z",
    mergedBy: "alice",
    additions: 10,
    deletions: 5,
    firstCommitAt: "2026-09-01T08:00:00Z",
    baseRef: "main",
    reviews: [],
    ...overrides,
  };
}

function run(overrides: Partial<DeployRun> & { runId: number; createdAt: string }): DeployRun {
  return {
    workflow: "deploy.yml",
    branch: "main",
    status: "completed",
    conclusion: "success",
    completedAt: new Date(Date.parse(overrides.createdAt) + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

const repo: Repo = {
  id: 1,
  owner: "o",
  name: "r",
  deployWorkflows: ["deploy.yml"],
  deployBranch: "main",
  addedAt: "2026-09-01T00:00:00Z",
  lastCrawledAt: null,
  crawlStatus: "idle",
  crawlError: null,
  crawlProgress: null,
};

describe("stats", () => {
  it("interpolates percentiles and medians", () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([0, 10, 20, 30, 40], 0.75)).toBe(30);
    expect(median([])).toBeNull();
  });

  it("measures hours and tolerates missing ends", () => {
    expect(hoursBetween("2026-09-01T10:00:00Z", "2026-09-01T13:30:00Z")).toBe(3.5);
    expect(hoursBetween(null, "2026-09-01T13:30:00Z")).toBeNull();
  });

  it("buckets into Monday-starting UTC weeks and fills empty weeks", () => {
    expect(weekStart("2026-09-06T23:59:00Z")).toBe("2026-08-31"); // Sunday belongs to the previous Monday
    expect(weekStart("2026-09-07T00:00:00Z")).toBe("2026-09-07");
    expect(weekRange("2026-08-31", "2026-09-14")).toEqual(["2026-08-31", "2026-09-07", "2026-09-14"]);
  });
});

describe("prTimings", () => {
  it("splits cycle time into coding, waiting, review and merge stages", () => {
    const t = prTimings(
      pr({
        number: 1,
        createdAt: "2026-09-01T10:00:00Z",
        mergedAt: "2026-09-02T10:00:00Z",
        firstCommitAt: "2026-09-01T06:00:00Z",
        reviews: [
          { author: "bob", state: "COMMENTED", submittedAt: "2026-09-01T16:00:00Z" },
          { author: "bob", state: "APPROVED", submittedAt: "2026-09-01T20:00:00Z" },
        ],
      }),
    );
    expect(t.codingHours).toBe(4);
    expect(t.firstReviewHours).toBe(6);
    expect(t.approvalHours).toBe(10);
    expect(t.openToMergeHours).toBe(24);
    expect(t.cycleHours).toBe(28);
    expect(t.stages).toEqual({ coding: 4, waitingForReview: 6, inReview: 4, toMerge: 14 });
    expect(t.reviewed).toBe(true);
    expect(t.reviewerCount).toBe(1);
    expect(t.size).toBe(15);
  });

  it("ignores the author reviewing their own PR", () => {
    const t = prTimings(
      pr({ number: 2, reviews: [{ author: "alice", state: "COMMENTED", submittedAt: "2026-09-01T11:00:00Z" }] }),
    );
    expect(t.reviewed).toBe(false);
    expect(t.firstReviewHours).toBeNull();
    expect(t.stages).toEqual({ coding: 2, waitingForReview: 4, inReview: 0, toMerge: 0 });
  });

  it("measures review wait from leaving draft, not from opening", () => {
    const t = prTimings(
      pr({
        number: 3,
        createdAt: "2026-09-01T10:00:00Z",
        publishedAt: "2026-09-01T12:00:00Z",
        reviews: [{ author: "bob", state: "APPROVED", submittedAt: "2026-09-01T13:00:00Z" }],
      }),
    );
    expect(t.firstReviewHours).toBe(1);
  });

  it("treats a rebased first commit dated after opening as no coding time", () => {
    const t = prTimings(pr({ number: 4, firstCommitAt: "2026-09-01T12:00:00Z" }));
    expect(t.codingHours).toBe(0);
  });

  it("counts change requests as extra review rounds", () => {
    const t = prTimings(
      pr({
        number: 5,
        reviews: [
          { author: "bob", state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T11:00:00Z" },
          { author: "carol", state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T12:00:00Z" },
          { author: "bob", state: "APPROVED", submittedAt: "2026-09-01T13:00:00Z" },
        ],
      }),
    );
    expect(t.reviewRounds).toBe(3);
    expect(t.reviewerCount).toBe(2);
  });

  it("leaves unmerged PRs without merge timings", () => {
    const t = prTimings(pr({ number: 6, state: "OPEN", mergedAt: null, closedAt: null }));
    expect(t.openToMergeHours).toBeNull();
    expect(t.stages).toBeNull();
  });
});

describe("isBot", () => {
  it("recognises bot accounts by type and by login", () => {
    expect(isBot({ author: "dependabot[bot]", authorIsBot: false })).toBe(true);
    expect(isBot({ author: "renovate", authorIsBot: false })).toBe(true);
    expect(isBot({ author: "github-actions", authorIsBot: true })).toBe(true);
    expect(isBot({ author: "alice", authorIsBot: false })).toBe(false);
  });
});

describe("mergeDistribution", () => {
  it("places each duration in exactly one bucket", () => {
    const d = mergeDistribution([0.5, 1, 3.9, 30, 200, 1000]);
    expect(d.map((b) => b.count)).toEqual([1, 2, 0, 1, 0, 1, 1]);
    expect(d.map((b) => b.short)).toEqual(["< 1h", "1 to 4h", "4 to 24h", "1 to 3d", "3 to 7d", "1 to 4w", "> 4w"]);
    expect(d.reduce((s, b) => s + b.count, 0)).toBe(6);
  });
});

describe("DORA", () => {
  const prs = [
    pr({ number: 1, firstCommitAt: "2026-09-01T08:00:00Z", mergedAt: "2026-09-01T14:00:00Z" }),
    pr({ number: 2, firstCommitAt: "2026-09-02T08:00:00Z", createdAt: "2026-09-02T09:00:00Z", mergedAt: "2026-09-02T10:00:00Z" }),
    pr({ number: 3, baseRef: "develop", mergedAt: "2026-09-02T10:00:00Z" }),
  ];
  const runs = [
    run({ runId: 1, createdAt: "2026-09-01T15:00:00Z" }), // ships PR 1
    run({ runId: 2, createdAt: "2026-09-02T11:00:00Z", conclusion: "failure" }),
    run({ runId: 3, createdAt: "2026-09-02T13:00:00Z", conclusion: "failure" }),
    run({ runId: 4, createdAt: "2026-09-02T15:00:00Z" }), // ships PR 2, restores after the failure streak
    run({ runId: 5, createdAt: "2026-09-02T16:00:00Z", conclusion: "cancelled" }),
    run({ runId: 6, createdAt: "2026-09-02T17:00:00Z", branch: "feature" }),
  ];

  it("ships each merged PR on the first successful deploy after its merge", () => {
    // PR 1 merged before the first recorded deploy, so it is outside the observed window.
    const lead = leadTimes(prs, runs, "main");
    expect(lead.map((l) => [l.number, l.hours])).toEqual([[2, 7 + 10 / 60]]);
  });

  it("does not measure lead time for PRs merged before deploys were first observed", () => {
    const early = pr({
      number: 9,
      mergedAt: "2026-08-01T10:00:00Z",
      createdAt: "2026-08-01T09:00:00Z",
      firstCommitAt: "2026-08-01T08:00:00Z",
    });
    const withEarlierDeploy = [run({ runId: 0, createdAt: "2026-09-01T09:00:00Z" }), ...runs];
    expect(leadTimes([early, ...prs], withEarlierDeploy, "main").map((l) => [l.number, l.hours])).toEqual([
      [1, 7 + 10 / 60],
      [2, 7 + 10 / 60],
    ]);
  });

  it("measures restore from the first failure of a streak to the next success", () => {
    const restore = restoreTimes(runs, "main");
    expect(restore).toHaveLength(1);
    expect(restore[0]!.hours).toBe(4);
  });

  it("ignores cancelled runs and other branches, and bands the results", () => {
    const summary = doraSummary(prs, runs, "main", 1);
    expect(summary.deploymentFrequency).toMatchObject({ total: 2, perWeek: 2, band: "high" });
    expect(summary.changeFailure).toMatchObject({ failed: 2, total: 4, rate: 0.5, band: "low" });
    expect(summary.leadTime?.band).toBe("elite");
    expect(summary.timeToRestore).toMatchObject({ medianHours: 4, band: "high" });
  });

  it("reports nothing rather than zero when no deploy workflow is configured", () => {
    const summary = doraSummary(prs, [], "main", 4);
    expect(summary.deploymentFrequency).toBeNull();
    expect(summary.changeFailure).toBeNull();
  });
});

describe("buildReport", () => {
  it("aggregates totals, weeks and authors, excluding bots by default", () => {
    const prs = [
      pr({ number: 1, author: "alice", mergedBy: "alice" }),
      pr({
        number: 2,
        author: "bob",
        mergedBy: "alice",
        createdAt: "2026-09-08T10:00:00Z",
        mergedAt: "2026-09-08T12:00:00Z",
        reviews: [{ author: "alice", state: "APPROVED", submittedAt: "2026-09-08T11:00:00Z" }],
      }),
      pr({ number: 3, author: "carol", state: "OPEN", mergedAt: null, closedAt: null, createdAt: "2026-09-09T10:00:00Z" }),
      pr({ number: 4, author: "dependabot[bot]", createdAt: "2026-09-09T10:00:00Z", mergedAt: "2026-09-09T10:05:00Z" }),
    ];
    const report = buildReport(repo, prs, [], { to: "2026-09-13" });
    expect(report.totals).toMatchObject({
      opened: 3,
      merged: 2,
      stillOpen: 1,
      authors: 3,
      reviewedShare: 0.5,
      selfMergedShare: 0.5,
    });
    expect(report.weekly.map((w) => [w.week, w.weekIndex, w.opened, w.merged])).toEqual([
      ["2026-08-31", 0, 1, 1],
      ["2026-09-07", 1, 2, 1],
    ]);
    expect(report.summary.openToMergeHours.median).toBe(3);
    expect(report.authors.find((a) => a.author === "alice")?.reviewsGiven).toBe(1);
    expect(buildReport(repo, prs, [], { to: "2026-09-13", includeBots: true }).totals.opened).toBe(4);
  });

  it("leaves excluded authors out of every figure but still offers them as choices", () => {
    const prs = [
      pr({ number: 1, author: "alice", createdAt: "2026-09-01T10:00:00Z", mergedAt: "2026-09-01T14:00:00Z" }),
      pr({
        number: 2,
        author: "bob",
        mergedBy: "bob",
        createdAt: "2026-08-25T10:00:00Z",
        mergedAt: "2026-09-02T10:00:00Z",
        reviews: [{ author: "alice", state: "APPROVED", submittedAt: "2026-09-01T12:00:00Z" }],
      }),
      pr({ number: 3, author: "bob", createdAt: "2026-09-08T10:00:00Z", mergedAt: "2026-09-08T11:00:00Z" }),
      pr({ number: 4, author: null, createdAt: "2026-09-09T10:00:00Z", mergedAt: "2026-09-09T12:00:00Z" }),
    ];
    const everyone = buildReport(repo, prs, [], { to: "2026-09-13" });
    const withoutBob = buildReport(repo, prs, [], { to: "2026-09-13", excludeAuthors: ["bob", "unknown"] });

    // Bob opened first, but leaving him out keeps the range and week alignment from his first PR.
    expect(withoutBob.projectStart).toBe(everyone.projectStart);
    expect(withoutBob.range).toEqual(everyone.range);
    expect(withoutBob.weekly.map((w) => w.weekIndex)).toEqual([0, 1, 2]);
    // Only alice's PR 1 remains: opened and merged in the week of 31 August after 4 hours.
    expect(withoutBob.totals).toMatchObject({ opened: 1, merged: 1, authors: 1, reviewedShare: 0, authorWeeks: 1 });
    expect(withoutBob.summary.openToMergeHours.median).toBe(4);
    expect(withoutBob.weekly.map((w) => w.merged)).toEqual([0, 1, 0]);
    expect(withoutBob.authors.map((a) => a.author)).toEqual(["alice"]);
    expect(withoutBob.prs.map((p) => p.number)).toEqual([1]);
    expect(withoutBob.authorChoices).toEqual([
      { author: "bob", opened: 2, excluded: true },
      { author: "alice", opened: 1, excluded: false },
      { author: "unknown", opened: 1, excluded: true },
    ]);
    expect(everyone.authorChoices.every((c) => !c.excluded)).toBe(true);
    expect(everyone.totals.opened).toBe(4);
  });

  it("offers only authors who opened a PR in the range, and no bots unless they are included", () => {
    const prs = [
      pr({ number: 1, author: "alice", createdAt: "2026-08-01T10:00:00Z", mergedAt: "2026-08-01T12:00:00Z" }),
      pr({ number: 2, author: "bob", createdAt: "2026-09-02T10:00:00Z", mergedAt: "2026-09-02T12:00:00Z" }),
      pr({ number: 3, author: "renovate", createdAt: "2026-09-03T10:00:00Z", mergedAt: "2026-09-03T12:00:00Z" }),
    ];
    const range = { from: "2026-09-01", to: "2026-09-06" };
    expect(buildReport(repo, prs, [], range).authorChoices.map((c) => c.author)).toEqual(["bob"]);
    expect(buildReport(repo, prs, [], { ...range, includeBots: true }).authorChoices.map((c) => c.author)).toEqual([
      "bob",
      "renovate",
    ]);
  });
});

describe("DORA bands", () => {
  it.each([
    [deployFrequencyBand, [7, 1, 0.25, 0.2]],
    [leadTimeBand, [23, 100, 700, 800]],
    [changeFailureBand, [0.05, 0.1, 0.15, 0.2]],
    [restoreBand, [0.5, 23, 100, 200]],
  ] as const)("%o maps each boundary to one band, best first", (band, values) => {
    expect(values.map((v) => band(v))).toEqual(["elite", "high", "medium", "low"]);
  });
});

describe("buildReport edges", () => {
  it("returns empty summaries rather than zeros for a repository with no pull requests", () => {
    const report = buildReport(repo, [], [], { from: "2026-09-01", to: "2026-09-07" });
    expect(report.projectStart).toBeNull();
    expect(report.totals).toMatchObject({ opened: 0, merged: 0, reviewedShare: null, mergedPerAuthorWeek: null });
    expect(report.summary.openToMergeHours.median).toBeNull();
    expect(report.weekly).toHaveLength(2);
    expect(report.weekly[0]).toMatchObject({ opened: 0, mergedPerAuthor: null, stages: null });
  });

  it("counts deploys and failures per week and lines merged per author-week", () => {
    const prs = [pr({ number: 1, additions: 90, deletions: 10 })];
    const runs = [
      run({ runId: 1, createdAt: "2026-09-01T15:00:00Z" }),
      run({ runId: 2, createdAt: "2026-09-02T15:00:00Z", conclusion: "failure" }),
    ];
    const report = buildReport(repo, prs, runs, { to: "2026-09-06" });
    expect(report.weekly[0]).toMatchObject({ deploys: 1, deployFailures: 1, linesMerged: 100 });
    expect(report.totals).toMatchObject({ authorWeeks: 1, linesMerged: 100, linesPerAuthorWeek: 100, mergedPerAuthorWeek: 1 });
  });

  it("marks a week that had not ended by the end of the range as partial", () => {
    // 2026-09-07 is a Monday. Ending on Sunday the 13th completes that week; ending on Wednesday the 9th does not.
    const complete = buildReport(repo, [pr({ number: 1 })], [], { from: "2026-09-07", to: "2026-09-13" });
    const midWeek = buildReport(repo, [pr({ number: 1 })], [], { from: "2026-09-07", to: "2026-09-09" });
    expect(complete.weekly.map((w) => w.partial)).toEqual([false]);
    expect(midWeek.weekly.map((w) => w.partial)).toEqual([true]);
  });

  it("files a PR with no author under unknown", () => {
    const report = buildReport(repo, [pr({ number: 1, author: null })], [], { to: "2026-09-06" });
    expect(report.authors[0]?.author).toBe("unknown");
  });
});

const widgets: Repo = { ...repo, owner: "acme", name: "widgets" };

describe("DORA profiles", () => {
  it("ships the 2023 report as the default and only profile", () => {
    expect(DEFAULT_DORA_PROFILE).toBe("dora-2023");
    expect(DORA_PROFILE_IDS).toEqual(["dora-2023"]);
    const profile = doraProfile("dora-2023");
    expect(profile.name).toBe("DORA 2023");
    expect(profile.source).toEqual({
      title: "2023 Accelerate State of DevOps Report",
      year: 2023,
      url: "https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf",
    });
    expect(profile.deployFrequency).toEqual([7, 1, 0.25]);
    expect(profile.leadTimeHours).toEqual([24, 168, 720]);
    expect(profile.changeFailure).toEqual([0.05, 0.1, 0.15]);
    expect(profile.restoreHours).toEqual([1, 24, 168]);
  });

  it("throws for an unknown profile rather than grading against a default", () => {
    expect(() => doraProfile("nope")).toThrow('Unknown DORA profile "nope"');
  });

  it.each([
    [24, "high"],
    [168, "medium"],
    [720, "low"],
  ] as const)("puts a lead time of exactly %s hours in the lower band", (hours, band) => {
    expect(leadTimeBand(hours)).toBe(band);
    expect(leadTimeBand(hours - 0.01)).not.toBe(band);
  });

  it.each([
    [1, "high"],
    [24, "medium"],
    [168, "low"],
  ] as const)("puts a restore time of exactly %s hours in the lower band", (hours, band) => {
    expect(restoreBand(hours)).toBe(band);
    expect(restoreBand(hours - 0.01)).not.toBe(band);
  });

  it("keeps the inclusive edges for frequency and failure rate", () => {
    expect(deployFrequencyBand(0.25)).toBe("medium");
    expect(deployFrequencyBand(0.24)).toBe("low");
    expect(changeFailureBand(0.15)).toBe("medium");
    expect(changeFailureBand(0.16)).toBe("low");
  });

  it("grades against a profile passed in", () => {
    const strict: DoraProfile = {
      ...doraProfile("dora-2023"),
      id: "test-strict",
      name: "Test strict",
      deployFrequency: [14, 7, 1],
      leadTimeHours: [4, 24, 168],
      changeFailure: [0.01, 0.02, 0.03],
      restoreHours: [0.5, 1, 24],
    };
    expect(deployFrequencyBand(7)).toBe("elite");
    expect(deployFrequencyBand(7, strict)).toBe("high");
    expect(leadTimeBand(10)).toBe("elite");
    expect(leadTimeBand(10, strict)).toBe("high");
    expect(changeFailureBand(0.05)).toBe("elite");
    expect(changeFailureBand(0.05, strict)).toBe("low");
    expect(restoreBand(0.75)).toBe("elite");
    expect(restoreBand(0.75, strict)).toBe("high");

    // One success in one week is 1 a week: high by default, medium against the strict profile.
    const summary = doraSummary([], [run({ runId: 1, createdAt: "2026-09-01T12:00:00Z" })], "main", 1, strict);
    expect(summary.deploymentFrequency?.band).toBe("medium");
    expect(summary.profile.id).toBe("test-strict");
  });

  it("names the profile in every summary, even one with nothing to grade", () => {
    const summary = doraSummary([], [], "main", 4);
    expect(summary.profile).toEqual({
      id: "dora-2023",
      name: "DORA 2023",
      source: doraProfile("dora-2023").source,
    });
    expect(Object.keys(summary.profile).sort()).toEqual(["id", "name", "source"]);
  });
});

describe("rework rate", () => {
  // A failed run opens the observed window at 12:00, then three successful deploys follow.
  const runs = [
    run({ runId: 10, createdAt: "2026-09-01T12:00:00Z", conclusion: "failure" }),
    run({ runId: 11, createdAt: "2026-09-01T15:00:00Z" }),
    run({ runId: 12, createdAt: "2026-09-02T15:00:00Z" }),
    run({ runId: 13, createdAt: "2026-09-03T15:00:00Z" }),
  ];

  it("counts successful deploys that shipped a revert or hotfix, once per deploy", () => {
    const prs = [
      pr({ number: 1, mergedAt: "2026-09-01T14:00:00Z" }), // ships in run 11
      pr({ number: 2, title: "Hotfix: broken login", mergedAt: "2026-09-02T10:00:00Z" }), // ships in run 12
      pr({ number: 3, title: "Revert PR 2", mergedAt: "2026-09-02T11:00:00Z" }), // also run 12
      pr({ number: 4, mergedAt: "2026-09-03T10:00:00Z" }), // ships in run 13
    ];
    const failure = doraSummary(prs, runs, "main", 1).changeFailure;
    // Runs 11, 12 and 13 succeeded; only run 12 shipped rework, so 1 of 3.
    expect(failure?.rework).toEqual({ rate: 1 / 3, deploys: 1, total: 3 });
    // The existing figures are unchanged: 1 failure in 4 runs, and two revert PRs.
    expect(failure?.rate).toBe(0.25);
    expect(failure?.revertPrs).toBe(2);
  });

  it("ignores a hotfix that has not shipped yet", () => {
    const prs = [pr({ number: 1, title: "hotfix typo", mergedAt: "2026-09-04T10:00:00Z" })];
    expect(doraSummary(prs, runs, "main", 1).changeFailure?.rework).toEqual({ rate: 0, deploys: 0, total: 3 });
  });

  it("is null when there were no successful deploys, and absent with no deploys at all", () => {
    const onlyFailures = [run({ runId: 1, createdAt: "2026-09-01T12:00:00Z", conclusion: "failure" })];
    expect(doraSummary([], onlyFailures, "main", 1).changeFailure?.rework).toBeNull();
    expect(doraSummary([], [], "main", 1).changeFailure).toBeNull();
  });
});

describe("aiAssistance", () => {
  it.each<[string, Partial<PullRequest>, AiAssistance]>([
    ["a matching label", { labels: ["ai-assisted"] }, "assisted"],
    ["a label in another case", { labels: ["AI-Assisted"] }, "assisted"],
    ["a bare ai label, which is a product area", { labels: ["ai"] }, "unassisted"],
    ["a matching co-author", { labels: [], coAuthors: ["Claude"] }, "assisted"],
    ["a co-author naming a model", { labels: [], coAuthors: ["Claude Opus 5.5"] }, "assisted"],
    ["a co-author with only trailers recorded", { coAuthors: ["GitHub Copilot"] }, "assisted"],
    ["a co-author signing as an agent", { coAuthors: ["Cursor Agent"] }, "assisted"],
    ["a person who shares a first name", { labels: [], coAuthors: ["Claude Martin", "Devin Patel"] }, "unassisted"],
    ["neither signal", { labels: ["bug"], coAuthors: ["Bob"] }, "unassisted"],
    ["empty lists", { labels: [], coAuthors: null }, "unassisted"],
    ["both fields absent", {}, "unknown"],
    ["both fields null", { labels: null, coAuthors: null }, "unknown"],
  ])("classes a PR with %s", (_, fields, expected) => {
    expect(aiAssistance(pr({ number: 1, ...fields }))).toBe(expected);
  });

  it("classes a bot author whose login matches a co-author pattern as assisted", () => {
    expect(aiAssistance(pr({ number: 1, author: "copilot-swe-agent[bot]", authorIsBot: true }))).toBe("assisted");
    // A matching login on a human account is not the bot rule.
    expect(aiAssistance(pr({ number: 2, author: "copilot-fan" }))).toBe("unknown");
    // A bot that matches no pattern falls through to the recorded fields.
    expect(aiAssistance(pr({ number: 3, author: "dependabot[bot]", authorIsBot: true }))).toBe("unknown");
    expect(aiAssistance(pr({ number: 4, author: "dependabot[bot]", authorIsBot: true, labels: [] }))).toBe("unassisted");
  });

  it("uses the signals passed in", () => {
    const signals = { labels: ["robot"], coAuthors: [/tabnine/i] };
    expect(aiAssistance(pr({ number: 1, labels: ["Robot"] }), signals)).toBe("assisted");
    expect(aiAssistance(pr({ number: 2, coAuthors: ["Tabnine"] }), signals)).toBe("assisted");
    expect(aiAssistance(pr({ number: 3, labels: ["ai"], coAuthors: ["Claude"] }), signals)).toBe("unassisted");
    expect(DEFAULT_AI_SIGNALS.labels).toEqual(["ai-assisted"]);
  });
});

describe("aiCohorts", () => {
  const approvedByBob = [{ author: "bob", state: "APPROVED" as const, submittedAt: "2026-09-01T12:00:00Z" }];
  // Every PR opens at 10:00 and merges at 14:00; cycle time runs from the first commit (default 08:00) to merge.
  const prs = [
    pr({
      number: 1,
      labels: ["ai-assisted"],
      firstCommitAt: "2026-09-01T04:00:00Z",
      additions: 100,
      deletions: 0,
      reviews: approvedByBob,
    }), // 10h, 100
    pr({ number: 2, title: "Revert PR 5", coAuthors: ["GitHub Copilot"] }), // 6h, 15
    pr({ number: 3, labels: ["ai-assisted"], firstCommitAt: "2026-09-01T10:00:00Z", additions: 20, deletions: 10 }), // 4h, 30
    pr({ number: 4, labels: [], coAuthors: [] }), // 6h, 15
    pr({ number: 5, labels: ["bug"], firstCommitAt: "2026-09-01T00:00:00Z", reviews: approvedByBob }), // 14h, 15
    pr({ number: 6 }), // unknown
  ];

  it("summarises each cohort", () => {
    const cohorts = aiCohorts(prs);
    // Assisted cycles [4, 6, 10]: median 6; p75 rank 1.5 gives 6 + 0.5 * 4 = 8. Sizes [15, 30, 100]: median 30.
    expect(cohorts.assisted).toEqual({
      prs: 3,
      medianCycleHours: 6,
      p75CycleHours: 8,
      medianSize: 30,
      reviewedShare: 1 / 3,
      revertShare: 1 / 3,
    });
    // Unassisted cycles [6, 14]: median 10; p75 rank 0.75 gives 6 + 0.75 * 8 = 12.
    expect(cohorts.unassisted).toEqual({
      prs: 2,
      medianCycleHours: 10,
      p75CycleHours: 12,
      medianSize: 15,
      reviewedShare: 0.5,
      revertShare: 0,
    });
    expect(cohorts.unknown).toBe(1);
  });

  it("returns empty cohorts with nulls rather than zeros", () => {
    const empty = {
      prs: 0,
      medianCycleHours: null,
      p75CycleHours: null,
      medianSize: null,
      reviewedShare: null,
      revertShare: null,
    };
    expect(aiCohorts([])).toEqual({ assisted: empty, unassisted: empty, unknown: 0 });
  });
});

describe("buildReport with profiles and cohorts", () => {
  const prs = [
    pr({ number: 1, labels: ["ai-assisted"] }),
    pr({ number: 2, labels: [] }),
    pr({ number: 3 }),
    pr({ number: 4, labels: ["ai-assisted"], state: "OPEN", mergedAt: null, closedAt: null }), // opened, not merged: not counted
  ];

  it("grades against the default profile and splits merged PRs into cohorts", () => {
    const report = buildReport(widgets, prs, [], { to: "2026-09-13" });
    expect(report.dora.profile.id).toBe("dora-2023");
    expect(report.aiCohorts.assisted.prs).toBe(1);
    expect(report.aiCohorts.unassisted.prs).toBe(1);
    expect(report.aiCohorts.unknown).toBe(1);
  });

  it("accepts a known profile id and throws for an unknown one", () => {
    expect(buildReport(widgets, prs, [], { to: "2026-09-13", profile: "dora-2023" }).dora.profile.name).toBe("DORA 2023");
    expect(() => buildReport(widgets, prs, [], { to: "2026-09-13", profile: "nope" })).toThrow('Unknown DORA profile "nope"');
  });
});
