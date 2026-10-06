import { describe, expect, it } from "vitest";
import { doraSummary, leadTimes } from "../src/dora.js";
import { doraBandPosition, doraDrivers, type DoraMeasure } from "../src/doraDrivers.js";
import { DEFAULT_DORA_PROFILE, doraProfile, type DoraProfile } from "../src/doraProfiles.js";
import { buildReport } from "../src/report.js";
import { mean } from "../src/stats.js";
import type { DeployRun, PullRequest, Repo } from "../src/types.js";

function pr(overrides: Partial<PullRequest> & { number: number }): PullRequest {
  return {
    title: `PR ${overrides.number}`,
    url: `https://github.com/acme/widgets/pull/${overrides.number}`,
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

/** A run that completes ten minutes after it starts. */
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

const widgets: Repo = {
  id: 1,
  owner: "acme",
  name: "widgets",
  deployWorkflows: ["deploy.yml"],
  deployBranch: "main",
  addedAt: "2026-09-01T00:00:00Z",
  lastCrawledAt: null,
  crawlStatus: "idle",
  crawlError: null,
  crawlProgress: null,
};

const profile = doraProfile(DEFAULT_DORA_PROFILE);

describe("doraBandPosition", () => {
  // DORA 2023: frequency [7, 1, 0.25] per week (>=), lead time [24, 168, 720] hours (<),
  // change failure [0.05, 0.1, 0.15] (<=), restore [1, 24, 168] hours (<).
  it.each<[DoraMeasure, number, string, string | null, number | null, number | null]>([
    // Lead time exactly 24 hours is not under a day, so it is high and must fall below 24 by any amount.
    ["leadTime", 24, "high", "elite", 24, 0],
    ["leadTime", 23.9, "elite", null, null, null],
    ["leadTime", 200, "medium", "high", 168, 32], // 200 - 168
    ["leadTime", 720, "low", "medium", 720, 0],
    ["timeToRestore", 1, "high", "elite", 1, 0],
    ["timeToRestore", 0.5, "elite", null, null, null],
    ["timeToRestore", 30, "medium", "high", 24, 6], // 30 - 24
    ["deploymentFrequency", 7, "elite", null, null, null],
    ["deploymentFrequency", 3, "high", "elite", 7, 4], // 7 - 3
    ["deploymentFrequency", 0.5, "medium", "high", 1, 0.5], // 1 - 0.5
    ["deploymentFrequency", 0, "low", "medium", 0.25, 0.25], // 0.25 - 0
    ["changeFailure", 0.05, "elite", null, null, null],
  ])("places %s at %s in the %s band", (measure, value, band, next, threshold, gap) => {
    expect(doraBandPosition(measure, value, profile)).toEqual({ band, next, threshold, gap });
  });

  it("needs a change failure rate just over 5% to come down by the excess to reach elite", () => {
    const position = doraBandPosition("changeFailure", 0.0501, profile);
    expect(position).toMatchObject({ band: "high", next: "elite", threshold: 0.05 });
    expect(position.gap).toBeCloseTo(0.0001, 10); // 0.0501 - 0.05
  });

  it("points a low change failure rate at the medium threshold", () => {
    const position = doraBandPosition("changeFailure", 0.2, profile);
    expect(position).toMatchObject({ band: "low", next: "medium", threshold: 0.15 });
    expect(position.gap).toBeCloseTo(0.05, 10); // 0.2 - 0.15
  });

  it("reads thresholds from the profile it is given", () => {
    const custom: DoraProfile = { ...profile, id: "custom", leadTimeHours: [10, 20, 30] };
    expect(doraBandPosition("leadTime", 15, custom)).toEqual({ band: "high", next: "elite", threshold: 10, gap: 5 });
  });
});

describe("doraDrivers", () => {
  // 2026-09-07 and 2026-09-14 are Mondays. The range ends on Wednesday 2026-09-23, so the week of the 21st is partial.
  const range = { from: "2026-09-07T00:00:00Z", to: "2026-09-23T23:59:59Z" };

  const prs = [
    // Coding 08:00 to 10:00 = 2; waiting 10:00 to 12:00 = 2; in review 12:00 to 13:00 = 1; to merge 13:00 to 14:00 = 1.
    // Shipped by run 2, completed 16:10: to deploy 14:00 to 16:10 = 13/6. Lead time 08:00 to 16:10 = 49/6.
    pr({
      number: 1,
      firstCommitAt: "2026-09-08T08:00:00Z",
      createdAt: "2026-09-08T10:00:00Z",
      publishedAt: "2026-09-08T10:00:00Z",
      mergedAt: "2026-09-08T14:00:00Z",
      additions: 100,
      deletions: 20,
      reviews: [
        { author: "bob", state: "COMMENTED", submittedAt: "2026-09-08T12:00:00Z" },
        { author: "bob", state: "APPROVED", submittedAt: "2026-09-08T13:00:00Z" },
      ],
    }),
    // Coding 00:00 to 10:00 = 10; waiting 10:00 to merge 15:00 = 5 (never reviewed); to deploy 15:00 to 16:10 = 7/6.
    // Lead time 00:00 to 16:10 = 97/6.
    pr({
      number: 2,
      firstCommitAt: "2026-09-08T00:00:00Z",
      createdAt: "2026-09-08T10:00:00Z",
      publishedAt: "2026-09-08T10:00:00Z",
      mergedAt: "2026-09-08T15:00:00Z",
      additions: 30,
      deletions: 0,
    }),
    // Coding 06:00 to 07:00 = 1; waiting 07:00 to 08:00 = 1. Runs 3 and 4 fail, so run 5 (completed 12:10) ships it:
    // to deploy 08:00 to 12:10 = 25/6. Lead time 06:00 to 12:10 = 37/6.
    pr({
      number: 3,
      title: "Revert the widget cache",
      firstCommitAt: "2026-09-09T06:00:00Z",
      createdAt: "2026-09-09T07:00:00Z",
      publishedAt: "2026-09-09T07:00:00Z",
      mergedAt: "2026-09-09T08:00:00Z",
      additions: 50,
      deletions: 0,
    }),
    // Merged after the last successful deploy, so not shipped and left out of every lead time figure.
    pr({ number: 4, createdAt: "2026-09-09T12:00:00Z", mergedAt: "2026-09-09T12:30:00Z", additions: 999 }),
  ];

  const runs = [
    run({ runId: 1, createdAt: "2026-09-07T09:00:00Z" }), // opens the observed window, ships nothing
    run({ runId: 2, createdAt: "2026-09-08T16:00:00Z" }), // ships PRs 1 and 2
    run({ runId: 3, createdAt: "2026-09-09T09:00:00Z", conclusion: "failure" }),
    run({ runId: 4, createdAt: "2026-09-09T10:00:00Z", conclusion: "failure", workflow: "smoke.yml" }),
    run({ runId: 5, createdAt: "2026-09-09T12:00:00Z" }), // ships PR 3, restores 09:10 to 12:10 = 3 hours
    run({ runId: 6, createdAt: "2026-09-15T09:00:00Z", conclusion: "failure" }), // still failing at the end
  ];

  const drivers = doraDrivers(prs, runs, "main", range, profile);

  describe("lead time", () => {
    it("measures only shipped pull requests", () => {
      expect(drivers.leadTime.count).toBe(3); // PRs 1, 2 and 3; PR 4 has not shipped
    });

    it("splits the mean into parts, largest first, that add up to the mean lead time", () => {
      // Means over three PRs: coding (2 + 10 + 1) / 3 = 13/3; waiting (2 + 5 + 1) / 3 = 8/3;
      // in review 1/3; to merge 1/3; to deploy (13/6 + 7/6 + 25/6) / 3 = 5/2. Sum 61/6.
      // In review and to merge tie, so they keep the order of the stages.
      expect(drivers.leadTime.parts.map((p) => p.part)).toEqual([
        "coding",
        "waitingForReview",
        "toDeploy",
        "inReview",
        "toMerge",
      ]);
      const expected = [13 / 3, 8 / 3, 5 / 2, 1 / 3, 1 / 3];
      drivers.leadTime.parts.forEach((p, i) => expect(p.meanHours).toBeCloseTo(expected[i]!, 10));
      // Shares over 61/6: 26/61, 16/61, 15/61, 2/61, 2/61.
      const shares = [26 / 61, 16 / 61, 15 / 61, 2 / 61, 2 / 61];
      drivers.leadTime.parts.forEach((p, i) => expect(p.share).toBeCloseTo(shares[i]!, 10));

      // Mean lead time (49/6 + 97/6 + 37/6) / 3 = 61/6, the same as the sum of the parts.
      expect(drivers.leadTime.meanHours).toBeCloseTo(61 / 6, 10);
      const sumOfParts = drivers.leadTime.parts.reduce((sum, p) => sum + p.meanHours, 0);
      expect(sumOfParts).toBeCloseTo(drivers.leadTime.meanHours!, 10);
      expect(sumOfParts).toBeCloseTo(mean(leadTimes(prs, runs, "main").map((l) => l.hours))!, 10);
    });

    it("counts draft time as coding, not as waiting for review, so a long draft does not blame review", () => {
      // Coding 08:00 to 09:00 = 1, then a draft from 09:00 on the 8th to 09:00 on the 10th = 48, so coding is 49.
      // Waiting from publishing 09:00 to the first review 10:00 = 1; in review 10:00 to approval 11:00 = 1; to merge
      // 11:00 to 12:00 = 1. Shipped by run 2 (13:00, completed 13:10): to deploy 1 h 10 min = 7/6. Lead time 08:00 on
      // the 8th to 13:10 on the 10th = 53 + 1/6 = 319/6.
      const drafted = pr({
        number: 1,
        firstCommitAt: "2026-09-08T08:00:00Z",
        createdAt: "2026-09-08T09:00:00Z",
        publishedAt: "2026-09-10T09:00:00Z",
        mergedAt: "2026-09-10T12:00:00Z",
        reviews: [
          { author: "bob", state: "COMMENTED", submittedAt: "2026-09-10T10:00:00Z" },
          { author: "bob", state: "APPROVED", submittedAt: "2026-09-10T11:00:00Z" },
        ],
      });
      const deploys = [
        run({ runId: 1, createdAt: "2026-09-08T07:00:00Z" }),
        run({ runId: 2, createdAt: "2026-09-10T13:00:00Z" }),
      ];
      const { leadTime } = doraDrivers([drafted], deploys, "main", range, profile);
      const hours = Object.fromEntries(leadTime.parts.map((p) => [p.part, p.meanHours]));
      expect(leadTime.parts[0]?.part).toBe("coding");
      expect(hours.coding).toBeCloseTo(49, 10);
      expect(hours.waitingForReview).toBeCloseTo(1, 10);
      expect(hours.inReview).toBeCloseTo(1, 10);
      expect(hours.toMerge).toBeCloseTo(1, 10);
      expect(hours.toDeploy).toBeCloseTo(7 / 6, 10);
      expect(leadTime.meanHours).toBeCloseTo(319 / 6, 10);
      expect(leadTimes([drafted], deploys, "main")[0]?.hours).toBeCloseTo(319 / 6, 10);
    });

    it("gives the 75th percentile of lead time and the size of the shipped pull requests", () => {
      // Lead times sorted 37/6, 49/6, 97/6: rank 2 x 0.75 = 1.5, so 49/6 + 0.5 x 48/6 = 73/6.
      expect(drivers.leadTime.p75Hours).toBeCloseTo(73 / 6, 10);
      // Sizes 120, 30, 50 (PR 4's 999 lines never shipped): median 50, p75 50 + 0.5 x 70 = 85, mean 200/3.
      expect(drivers.leadTime.size).toEqual({ count: 3, median: 50, p75: 85, mean: 200 / 3 });
    });
  });

  describe("deployment frequency", () => {
    it("counts complete weeks, leaving out the partial week at the end", () => {
      // Successful runs 1, 2 and 5. Weeks of the 7th and 14th are complete; only the 7th had a deploy.
      expect(drivers.deploymentFrequency).toMatchObject({ deploys: 3, completeWeeks: 2, weeksWithoutDeploy: 1 });
    });

    it("treats a week the range only partly covers at either end as incomplete", () => {
      // Wednesday 9 September to Wednesday 30 September touches the weeks of the 7th, 14th, 21st and 28th. The 7th
      // starts before the range and the 28th ends after it, so only the 14th and 21st are complete.
      const midWeek = { from: "2026-09-09T00:00:00Z", to: "2026-09-30T23:59:59Z" };
      const deploys = [
        run({ runId: 1, createdAt: "2026-09-15T09:00:00Z" }), // week of the 14th, complete
        run({ runId: 2, createdAt: "2026-09-29T09:00:00Z" }), // week of the 28th, partial at the end
      ];
      const result = doraDrivers([], deploys, "main", midWeek, profile);
      // Of the two complete weeks only the 21st had no deploy; the empty partial week of the 7th is not counted.
      expect(result.deploymentFrequency).toMatchObject({ deploys: 2, completeWeeks: 2, weeksWithoutDeploy: 1 });
      // The tile still divides by every week the range touches: 2 deploys over 4 weeks.
      expect(doraSummary([], deploys, "main", 4, profile).deploymentFrequency).toMatchObject({ total: 2, weeks: 4 });
    });

    it("counts pull requests per deploy, over deploys that shipped any", () => {
      // Run 2 shipped 2, run 5 shipped 1, run 1 shipped none and is left out: median 1.5, p75 1 + 0.75 x 1 = 1.75.
      expect(drivers.deploymentFrequency.prsPerDeploy).toEqual({ count: 2, median: 1.5, p75: 1.75, mean: 1.5 });
    });
  });

  describe("change failure", () => {
    it("counts failures and totals by workflow, most failures first", () => {
      expect(drivers.changeFailure).toMatchObject({ failed: 3, total: 6 });
      expect(drivers.changeFailure.byWorkflow).toEqual([
        { workflow: "deploy.yml", failed: 2, total: 5 },
        { workflow: "smoke.yml", failed: 1, total: 1 },
      ]);
    });

    it("counts deploys that shipped a revert or hotfix out of successful deploys", () => {
      expect(drivers.changeFailure.rework).toEqual({ deploys: 1, total: 3 }); // run 5 shipped the revert
    });

    it("breaks a tie in failures by workflow name", () => {
      const tied = [
        run({ runId: 1, createdAt: "2026-09-08T09:00:00Z", workflow: "d.yml" }),
        run({ runId: 2, createdAt: "2026-09-08T10:00:00Z", workflow: "b.yml", conclusion: "failure" }),
        run({ runId: 3, createdAt: "2026-09-08T11:00:00Z", workflow: "a.yml", conclusion: "failure" }),
        run({ runId: 4, createdAt: "2026-09-08T12:00:00Z", workflow: "c.yml", conclusion: "failure" }),
        run({ runId: 5, createdAt: "2026-09-08T13:00:00Z", workflow: "c.yml", conclusion: "failure" }),
      ];
      const { byWorkflow } = doraDrivers([], tied, "main", range, profile).changeFailure;
      expect(byWorkflow.map((w) => w.workflow)).toEqual(["c.yml", "a.yml", "b.yml", "d.yml"]);
    });
  });

  describe("time to restore", () => {
    it("reports recovered streaks and a failure still unrecovered at the end of the range", () => {
      expect(drivers.timeToRestore).toEqual({
        streaks: 1,
        failedRunsPerStreak: { count: 1, median: 2, p75: 2, mean: 2 }, // runs 3 and 4
        longestHours: 3,
        unrecovered: { since: "2026-09-15T09:00:00Z", failedRuns: 1 },
      });
    });

    it("summarises several streaks and gives the longest restore", () => {
      const streaky = [
        run({ runId: 1, createdAt: "2026-09-08T00:00:00Z", conclusion: "failure" }), // completes 00:10
        run({ runId: 2, createdAt: "2026-09-08T01:00:00Z" }), // completes 01:10: 1 hour
        run({ runId: 3, createdAt: "2026-09-08T02:00:00Z", conclusion: "failure" }), // completes 02:10
        run({ runId: 4, createdAt: "2026-09-08T03:00:00Z", conclusion: "failure" }),
        run({ runId: 5, createdAt: "2026-09-08T04:00:00Z", conclusion: "failure" }),
        run({ runId: 6, createdAt: "2026-09-08T06:00:00Z" }), // completes 06:10: 4 hours
      ];
      const restore = doraDrivers([], streaky, "main", range, profile).timeToRestore;
      // Streaks of 1 and 3 runs: median 2, p75 1 + 0.75 x 2 = 2.5.
      expect(restore).toEqual({
        streaks: 2,
        failedRunsPerStreak: { count: 2, median: 2, p75: 2.5, mean: 2 },
        longestHours: 4,
        unrecovered: null,
      });
    });
  });

  describe("position", () => {
    it("places each measure from the same figures the summary bands", () => {
      // Median lead time 49/6 hours: elite. 3 deploys over 3 weeks (the summary counts the partial week): 1 a week,
      // high, 6 short of 7. 3 failures in 6 runs: 0.5, low, 0.35 above 0.15. One restore of 3 hours: high, 2 above 1.
      expect(drivers.position.leadTime).toEqual({ band: "elite", next: null, threshold: null, gap: null });
      expect(drivers.position.deploymentFrequency).toEqual({ band: "high", next: "elite", threshold: 7, gap: 6 });
      expect(drivers.position.changeFailure).toMatchObject({ band: "low", next: "medium", threshold: 0.15 });
      expect(drivers.position.changeFailure?.gap).toBeCloseTo(0.35, 10);
      expect(drivers.position.timeToRestore).toEqual({ band: "high", next: "elite", threshold: 1, gap: 2 });

      const summary = doraSummary(prs, runs, "main", 3, profile);
      expect(drivers.position.leadTime?.band).toBe(summary.leadTime?.band);
      expect(drivers.position.deploymentFrequency?.band).toBe(summary.deploymentFrequency?.band);
      expect(drivers.position.changeFailure?.band).toBe(summary.changeFailure?.band);
      expect(drivers.position.timeToRestore?.band).toBe(summary.timeToRestore?.band);
    });
  });

  it("returns nulls and zero counts when there is nothing to measure", () => {
    const empty = doraDrivers([], [], "main", range, profile);
    const nothing = { count: 0, median: null, p75: null, mean: null };
    expect(empty).toEqual({
      position: { deploymentFrequency: null, leadTime: null, changeFailure: null, timeToRestore: null },
      leadTime: { count: 0, meanHours: null, p75Hours: null, parts: [], size: nothing },
      deploymentFrequency: { deploys: 0, completeWeeks: 2, weeksWithoutDeploy: 2, prsPerDeploy: nothing },
      changeFailure: { failed: 0, total: 0, byWorkflow: [], rework: null },
      timeToRestore: { streaks: 0, failedRunsPerStreak: nothing, longestHours: null, unrecovered: null },
    });
  });

  it("gives every part a share of zero rather than dividing by zero when shipping took no time", () => {
    const instant = pr({
      number: 1,
      firstCommitAt: "2026-09-08T10:00:00Z",
      createdAt: "2026-09-08T10:00:00Z",
      publishedAt: "2026-09-08T10:00:00Z",
      mergedAt: "2026-09-08T10:00:00Z",
    });
    const deploy = run({ runId: 1, createdAt: "2026-09-08T10:00:00Z", completedAt: "2026-09-08T10:00:00Z" });
    const { leadTime } = doraDrivers([instant], [deploy], "main", range, profile);
    expect(leadTime.meanHours).toBe(0);
    expect(leadTime.parts.map((p) => [p.meanHours, p.share])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it("leaves out pull requests and runs outside the range, as the report does", () => {
    const before = run({ runId: 0, createdAt: "2026-09-01T09:00:00Z", conclusion: "failure" });
    const mergedBefore = pr({ number: 9, mergedAt: "2026-09-06T23:00:00Z" });
    const scoped = doraDrivers([...prs, mergedBefore], [before, ...runs], "main", range, profile);
    expect(scoped).toEqual(drivers);
  });

  it("leaves out a shipped pull request whose deploy has no readable completion time, as lead time does", () => {
    const shipped = pr({ number: 1, createdAt: "2026-09-08T10:00:00Z", mergedAt: "2026-09-08T11:00:00Z" });
    const unreadable = [
      run({ runId: 1, createdAt: "2026-09-08T09:00:00Z" }),
      run({ runId: 2, createdAt: "2026-09-08T12:00:00Z", completedAt: "not a date" }),
    ];
    const { leadTime, deploymentFrequency } = doraDrivers([shipped], unreadable, "main", range, profile);
    expect(leadTime.count).toBe(0);
    expect(deploymentFrequency.prsPerDeploy.count).toBe(0);
    expect(leadTimes([shipped], unreadable, "main")).toEqual([]);
  });

  it("counts nothing after the merge when the merge time cannot be read, rather than a part that is not a number", () => {
    // The trailing character keeps the string in range but makes it unreadable as an instant. Coding 08:00 to 10:00
    // is still 2 hours; every stage that ends or starts at the merge clamps to zero.
    const garbled = pr({
      number: 1,
      firstCommitAt: "2026-09-08T08:00:00Z",
      createdAt: "2026-09-08T10:00:00Z",
      mergedAt: "2026-09-08T11:00:00Z?",
    });
    const deploys = [run({ runId: 1, createdAt: "2026-09-08T09:00:00Z" }), run({ runId: 2, createdAt: "2026-09-08T12:00:00Z" })];
    const { leadTime } = doraDrivers([garbled], deploys, "main", range, profile);
    expect(leadTime.count).toBe(1);
    expect(leadTime.parts.find((p) => p.part === "toDeploy")?.meanHours).toBe(0);
    expect(leadTime.meanHours).toBe(2);
  });
});

describe("buildReport doraDrivers", () => {
  const prs = [
    pr({ number: 1, createdAt: "2026-09-08T10:00:00Z", mergedAt: "2026-09-08T14:00:00Z", firstCommitAt: "2026-09-08T08:00:00Z" }),
    // A bot's pull request and an excluded author's, both shipped by run 2, are left out of every figure.
    pr({
      number: 2,
      author: "dependabot[bot]",
      authorIsBot: true,
      createdAt: "2026-09-08T10:00:00Z",
      mergedAt: "2026-09-08T15:00:00Z",
    }),
    pr({ number: 3, author: "carol", createdAt: "2026-09-08T10:00:00Z", mergedAt: "2026-09-08T15:30:00Z" }),
  ];
  const runs = [
    run({ runId: 1, createdAt: "2026-09-07T09:00:00Z" }),
    run({ runId: 2, createdAt: "2026-09-08T16:00:00Z" }),
    run({ runId: 3, createdAt: "2026-09-09T09:00:00Z", conclusion: "failure" }),
    run({ runId: 4, createdAt: "2026-09-09T10:00:00Z" }),
  ];

  it("carries drivers that agree with the DORA tiles", () => {
    const report = buildReport(widgets, prs, runs, { from: "2026-09-07", to: "2026-09-16", excludeAuthors: ["carol"] });
    const { dora, doraDrivers: drivers } = report;

    expect(drivers.leadTime.count).toBe(1); // only PR 1
    expect(drivers.leadTime.count).toBe(dora.leadTime?.count);
    expect(drivers.deploymentFrequency.deploys).toBe(dora.deploymentFrequency?.total);
    expect(drivers.changeFailure).toMatchObject({ failed: dora.changeFailure?.failed, total: dora.changeFailure?.total });
    expect(drivers.changeFailure.rework).toEqual({
      deploys: dora.changeFailure?.rework?.deploys,
      total: dora.changeFailure?.rework?.total,
    });
    expect(drivers.timeToRestore.streaks).toBe(dora.timeToRestore?.count);
    expect(drivers.position.leadTime?.band).toBe(dora.leadTime?.band);
    expect(drivers.position.deploymentFrequency?.band).toBe(dora.deploymentFrequency?.band);
    expect(drivers.position.changeFailure?.band).toBe(dora.changeFailure?.band);
    expect(drivers.position.timeToRestore?.band).toBe(dora.timeToRestore?.band);

    // The weeks of the 7th (complete) and the 14th (partial, the range ends on Wednesday the 16th).
    expect(report.weekly.map((w) => w.partial)).toEqual([false, true]);
    expect(drivers.deploymentFrequency).toMatchObject({ deploys: 3, completeWeeks: 1, weeksWithoutDeploy: 0 });
  });

  it("counts a bot's pull request when bots are included", () => {
    const report = buildReport(widgets, prs, runs, { from: "2026-09-07", to: "2026-09-16", includeBots: true });
    expect(report.doraDrivers.leadTime.count).toBe(3);
    expect(report.doraDrivers.leadTime.count).toBe(report.dora.leadTime?.count);
  });
});
