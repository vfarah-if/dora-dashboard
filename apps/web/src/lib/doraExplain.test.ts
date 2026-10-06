import { describe, expect, it } from "vitest";
import type { Band, BandPosition, DoraDrivers, DoraMeasure, RepoReport } from "@dora-dashboard/core";
import { copy } from "../copy";
import { report } from "../test/fixtures";
import { explainDora } from "./doraExplain";

const base = report();
const summary = (median: number | null) => ({ count: median === null ? 0 : 3, median, p75: median, mean: median });

/** The fixture report with drivers changed. */
function withDrivers(patch: Partial<DoraDrivers>): RepoReport {
  return report({ doraDrivers: { ...base.doraDrivers, ...patch } });
}

/** The fixture report with one measure's figure and position changed. */
function withMeasure(measure: DoraMeasure, figure: Partial<RepoReport["dora"]>, position: BandPosition): RepoReport {
  return report({
    dora: { ...base.dora, ...figure },
    doraDrivers: { ...base.doraDrivers, position: { ...base.doraDrivers.position, [measure]: position } },
  });
}

const parts = (...shares: [DoraDrivers["leadTime"]["parts"][number]["part"], number][]) =>
  shares.map(([part, meanHours]) => ({ part, meanHours, share: meanHours / 36 }));

describe("explainDora gap sentences", () => {
  const freq = (perWeek: number, band: Band, position: BandPosition) =>
    explainDora(withMeasure("deploymentFrequency", { deploymentFrequency: { perWeek, total: 3, weeks: 3, band } }, position))
      .deploymentFrequency!.gap;
  const lead = (medianHours: number, band: Band, position: BandPosition) =>
    explainDora(withMeasure("leadTime", { leadTime: { medianHours, count: 4, band } }, position)).leadTime!.gap;
  const failure = (rate: number, band: Band, position: BandPosition) =>
    explainDora(
      withMeasure("changeFailure", { changeFailure: { rate, failed: 1, total: 4, band, revertPrs: 0, rework: null } }, position),
    ).changeFailure!.gap;
  const restore = (medianHours: number, band: Band, position: BandPosition) =>
    explainDora(withMeasure("timeToRestore", { timeToRestore: { medianHours, count: 1, band } }, position)).timeToRestore!.gap;

  it.each([
    [
      0.1,
      "low",
      { band: "low", next: "medium", threshold: 0.25, gap: 0.15 },
      // A gap of 0.15 is written to one place, as the value is.
      "Deployments run at 0.1 per week. The Medium band needs at least 0.25 per week, which is 0.2 per week more than now.",
    ],
    [
      1.83,
      "high",
      { band: "high", next: "elite", threshold: 7, gap: 5.17 },
      // 1.8 shown, so 5.2 more reads back to 7.
      "Deployments run at 1.8 per week. The Elite band needs at least 7 per week, which is 5.2 per week more than now.",
    ],
    [
      0.98,
      "medium",
      { band: "medium", next: "high", threshold: 1, gap: 0.02 },
      // A gap of 0.02 would show as 0 to one place, so the value and the gap both take two.
      "Deployments run at 0.98 per week. The High band needs at least 1 per week, which is 0.02 per week more than now.",
    ],
    [
      0.5,
      "medium",
      { band: "medium", next: "high", threshold: 1, gap: 0.5 },
      "Deployments run at 0.5 per week. The High band needs at least 1 per week, which is 0.5 per week more than now.",
    ],
    [
      3,
      "high",
      { band: "high", next: "elite", threshold: 7, gap: 4 },
      "Deployments run at 3 per week. The Elite band needs at least 7 per week, which is 4 per week more than now.",
    ],
    [
      10,
      "elite",
      { band: "elite", next: null, threshold: null, gap: null },
      "At 10 per week the figure is 3 per week inside the elite requirement of at least 7 per week, which keeps it in the elite band.",
    ],
    [
      7,
      "elite",
      { band: "elite", next: null, threshold: null, gap: null },
      "At 7 per week the figure sits exactly on the elite requirement of at least 7 per week, and that limit itself counts, so it stays in the elite band.",
    ],
  ] as [number, Band, BandPosition, string][])(
    "states the deployment frequency gap at %s a week (%s)",
    (value, band, position, expected) => {
      expect(freq(value, band, position)).toBe(expected);
    },
  );

  it.each([
    [
      800,
      "low",
      { band: "low", next: "medium", threshold: 720, gap: 80 },
      "The median is 33.3 days. The Medium band needs under 30 days, which is 3.3 days shorter than now.",
    ],
    [
      300,
      "medium",
      { band: "medium", next: "high", threshold: 168, gap: 132 },
      "The median is 12.5 days. The High band needs under 7 days, which is 5.5 days shorter than now.",
    ],
    [
      30,
      "high",
      { band: "high", next: "elite", threshold: 24, gap: 6 },
      "The median is 30 h. The Elite band needs under 24 h, which is 6 h shorter than now.",
    ],
    [
      12,
      "elite",
      { band: "elite", next: null, threshold: null, gap: null },
      "At 12 h the figure is 12 h inside the elite requirement of under 24 h, which keeps it in the elite band.",
    ],
    [
      30.5,
      "high",
      { band: "high", next: "elite", threshold: 24, gap: 6.5 },
      "The median is 30.5 h. The Elite band needs under 24 h, which is 6.5 h shorter than now.",
    ],
    [
      24.02,
      "high",
      { band: "high", next: "elite", threshold: 24, gap: 0.02 },
      // 0.02 h would show as 0 h, so the gap falls back to its own unit: 1.2 minutes is 1 min.
      "The median is 24 h. The Elite band needs under 24 h, which is 1 min shorter than now.",
    ],
  ] as [number, Band, BandPosition, string][])("states the lead time gap at %s hours (%s)", (value, band, position, expected) => {
    expect(lead(value, band, position)).toBe(expected);
  });

  it("says a lead time exactly on a threshold must fall below it", () => {
    expect(lead(24, "high", { band: "high", next: "elite", threshold: 24, gap: 0 })).toBe(
      "The median is 24 h, which sits exactly on the limit for the Elite band. That band needs under 24 h, so the figure must fall below the limit to qualify.",
    );
  });

  it.each([
    [
      0.25,
      "low",
      { band: "low", next: "medium", threshold: 0.15, gap: 0.1 },
      "25% of deploys failed. The Medium band needs 15% or less, which is 10 percentage points lower than now.",
    ],
    [
      0.12,
      "medium",
      { band: "medium", next: "high", threshold: 0.1, gap: 0.02 },
      "12% of deploys failed. The High band needs 10% or less, which is 2 percentage points lower than now.",
    ],
    [
      0.07,
      "high",
      { band: "high", next: "elite", threshold: 0.05, gap: 0.02 },
      "7% of deploys failed. The Elite band needs 5% or less, which is 2 percentage points lower than now.",
    ],
    [
      0.244,
      "low",
      { band: "low", next: "medium", threshold: 0.15, gap: 0.094 },
      // The tile shows 24%, but a gap of 9.4 points needs the decimal, so the value takes one too.
      "24.4% of deploys failed. The Medium band needs 15% or less, which is 9.4 percentage points lower than now.",
    ],
    [
      0.16,
      "low",
      { band: "low", next: "medium", threshold: 0.15, gap: 0.01 },
      "16% of deploys failed. The Medium band needs 15% or less, which is 1 percentage point lower than now.",
    ],
    [
      0.023,
      "elite",
      { band: "elite", next: null, threshold: null, gap: null },
      "At 2.3% the figure is 2.7 percentage points inside the elite requirement of 5% or less, which keeps it in the elite band.",
    ],
    [
      0.02,
      "elite",
      { band: "elite", next: null, threshold: null, gap: null },
      "At 2% the figure is 3 percentage points inside the elite requirement of 5% or less, which keeps it in the elite band.",
    ],
    [
      0.05,
      "elite",
      { band: "elite", next: null, threshold: null, gap: null },
      "At 5% the figure sits exactly on the elite requirement of 5% or less, and that limit itself counts, so it stays in the elite band.",
    ],
  ] as [number, Band, BandPosition, string][])(
    "states the change failure gap at a rate of %s (%s)",
    (value, band, position, expected) => {
      expect(failure(value, band, position)).toBe(expected);
    },
  );

  it.each([
    [
      200,
      "low",
      { band: "low", next: "medium", threshold: 168, gap: 32 },
      "The median is 8.3 days. The Medium band needs under 7 days, which is 1.3 days shorter than now.",
    ],
    [
      100,
      "medium",
      { band: "medium", next: "high", threshold: 24, gap: 76 },
      "The median is 4.2 days. The High band needs under 24 h, which is 3.2 days shorter than now.",
    ],
    [
      2,
      "high",
      { band: "high", next: "elite", threshold: 1, gap: 1 },
      "The median is 2 h. The Elite band needs under 1 h, which is 1 h shorter than now.",
    ],
    [
      0.5,
      "elite",
      { band: "elite", next: null, threshold: null, gap: null },
      "At 30 min the figure is 30 min inside the elite requirement of under 1 h, which keeps it in the elite band.",
    ],
  ] as [number, Band, BandPosition, string][])(
    "states the time to restore gap at %s hours (%s)",
    (value, band, position, expected) => {
      expect(restore(value, band, position)).toBe(expected);
    },
  );
});

describe("explainDora meaning", () => {
  const MEASURES: DoraMeasure[] = ["deploymentFrequency", "leadTime", "changeFailure", "timeToRestore"];
  const BANDS: Band[] = ["elite", "high", "medium", "low"];
  const NEXT: Record<Band, Band | null> = { low: "medium", medium: "high", high: "elite", elite: null };

  it.each(MEASURES.flatMap((m) => BANDS.map((b) => [m, b] as const)))("gives the %s meaning for the %s band", (measure, band) => {
    const figures: Record<DoraMeasure, Partial<RepoReport["dora"]>> = {
      deploymentFrequency: { deploymentFrequency: { perWeek: 1, total: 3, weeks: 3, band } },
      leadTime: { leadTime: { medianHours: 30, count: 4, band } },
      changeFailure: { changeFailure: { rate: 0.2, failed: 1, total: 5, band, revertPrs: 0, rework: null } },
      timeToRestore: { timeToRestore: { medianHours: 5, count: 1, band } },
    };
    const next = NEXT[band];
    const position: BandPosition =
      next === null ? { band, next, threshold: null, gap: null } : { band, next, threshold: 1, gap: 1 };
    const result = explainDora(withMeasure(measure, figures[measure], position))[measure]!;
    expect(result.meaning).toBe(copy.dora.explain.meaning[measure][band]);
    expect(result.source.href).toContain("dora.dev");
  });

  it("gives every band of every measure its own sentence", () => {
    const all = MEASURES.flatMap((m) => BANDS.map((b) => copy.dora.explain.meaning[m][b]));
    expect(new Set(all).size).toBe(16);
  });
});

describe("explainDora lead time", () => {
  const lead = (patch: Partial<DoraDrivers["leadTime"]>, position?: BandPosition) =>
    explainDora(
      withDrivers({
        leadTime: { ...base.doraDrivers.leadTime, ...patch },
        ...(position ? { position: { ...base.doraDrivers.position, leadTime: position } } : {}),
      }),
    ).leadTime!;

  it("lists the largest part, the next and the spread, with the mean explained", () => {
    const result = lead({});
    // Coding 18 of the 36 hour mean is half; waiting for review 9 is a quarter; p75 of 48 hours is 2 days.
    expect(result.findings).toEqual([
      "Coding is the largest part of lead time, averaging 18 h, or 50% of the 36 h mean. The tile shows the median, so the parts add up to the mean rather than to the tile.",
      "Waiting for review comes next, averaging 9 h, or 25% of the mean.",
      "One in four changes took 2 days or longer from first commit to deploy, and the median change was 40 lines.",
    ]);
  });

  it("answers coding time with small batches then trunk-based development, and no review quote", () => {
    const result = lead({});
    expect(result.practices.map((p) => p.name)).toEqual(["Working in small batches", "Trunk-based development"]);
    expect(result.quote).toBeNull();
  });

  it.each(["waitingForReview", "inReview", "toMerge"] as const)(
    "treats %s as the largest part as waiting for review and quotes the 2023 report",
    (part) => {
      const result = lead({ parts: parts([part, 20], ["coding", 10], ["toDeploy", 6]) });
      expect(result.practices.map((p) => p.name)).toEqual([
        "Streamlining change approval",
        "Working in small batches",
        "Trunk-based development",
      ]);
      expect(result.quote?.text).toContain("Teams with faster code reviews have 50% higher software delivery performance.");
      expect(result.quote?.href).toBe(
        "https://dora.dev/research/2023/dora-report/2023-dora-accelerate-state-of-devops-report.pdf#page=5",
      );
    },
  );

  it("answers merge to deploy with deployment automation and continuous delivery", () => {
    const result = lead({ parts: parts(["toDeploy", 20], ["coding", 10]) });
    expect(result.findings[0]).toContain("Merge to deploy is the largest part");
    expect(result.practices.map((p) => p.name)).toEqual(["Deployment automation", "Continuous delivery"]);
    expect(result.quote).toBeNull();
  });

  it("goes to the earlier stage on a tie, as core orders the parts", () => {
    const result = lead({ parts: parts(["coding", 10], ["waitingForReview", 10]) });
    expect(result.findings[0]).toContain("Coding is the largest part");
    expect(result.quote).toBeNull();
  });

  it("leaves out a next part that took no time", () => {
    const result = lead({ parts: parts(["coding", 36], ["toDeploy", 0]) });
    expect(result.findings).toHaveLength(2);
  });

  it("shows the size but never chooses a practice from it", () => {
    const small = lead({ size: summary(5) });
    const large = lead({ size: summary(5000) });
    expect(small.practices).toEqual(large.practices);
    expect(large.findings[2]).toContain("5,000 lines");
  });

  it("leaves out the size and the percentile when core has none", () => {
    const result = lead({ size: summary(null), p75Hours: null });
    expect(result.findings).toHaveLength(2);
    const noSize = lead({ size: summary(null) });
    expect(noSize.findings[2]).toBe("One in four changes took 2 days or longer from first commit to deploy.");
  });

  it("offers no findings or practices when nothing shipped", () => {
    const result = lead({ count: 0, meanHours: null, p75Hours: null, parts: [] });
    expect(result.findings).toEqual([]);
    expect(result.practices).toEqual([]);
    expect(result.gap).not.toBe("");
  });

  it("still explains an elite figure through its drivers, with no practices or review quote", () => {
    const result = lead(
      { parts: parts(["waitingForReview", 20], ["coding", 10]) },
      { band: "elite", next: null, threshold: null, gap: null },
    );
    expect(result.findings[0]).toContain("Waiting for review is the largest part");
    expect(result.findings).toHaveLength(3);
    expect(result.practices).toEqual([]);
    expect(result.quote).toBeNull();
  });
});

describe("explainDora deployment frequency", () => {
  /** The tile's own figure, 3 deploys over 4 weeks, beside drivers patched as given. */
  const freq = (patch: Partial<DoraDrivers["deploymentFrequency"]>, elite = false) =>
    explainDora(
      report({
        dora: { ...base.dora, deploymentFrequency: { perWeek: 0.75, total: 3, weeks: 4, band: elite ? "elite" : "medium" } },
        doraDrivers: {
          ...base.doraDrivers,
          deploymentFrequency: { ...base.doraDrivers.deploymentFrequency, ...patch },
          position: {
            ...base.doraDrivers.position,
            deploymentFrequency: elite
              ? { band: "elite", next: null, threshold: null, gap: null }
              : { band: "medium", next: "high", threshold: 1, gap: 0.25 },
          },
        },
      }),
    ).deploymentFrequency!;

  it("states the tile's own deploys and weeks, then the complete weeks with none, so the tile can be reproduced", () => {
    // The range touches 4 weeks, the first and last partial: 3 deploys over 4 weeks is the tile's 0.75 a week.
    const result = freq({ deploys: 3, weeks: 2, weeksWithoutDeploy: 1, prsPerDeploy: summary(1) });
    expect(result.findings).toEqual([
      "The tile divides 3 successful deploys by 4 weeks, counting every week the range touches, partial ones included. Of the 2 complete weeks, 1 had no deploy.",
    ]);
    expect(result.practices.map((p) => p.name)).toEqual(["Deployment automation", "Continuous delivery"]);
  });

  it("uses the singular for one deploy, one week and one complete week", () => {
    const one = explainDora(
      report({
        dora: { ...base.dora, deploymentFrequency: { perWeek: 1, total: 1, weeks: 1, band: "high" } },
        doraDrivers: {
          ...base.doraDrivers,
          deploymentFrequency: { deploys: 1, weeks: 1, weeksWithoutDeploy: 0, prsPerDeploy: summary(1) },
        },
      }),
    ).deploymentFrequency!;
    expect(one.findings[0]).toBe(
      "The tile divides 1 successful deploy by 1 week, counting every week the range touches, partial ones included. Of the 1 complete week, 0 had no deploy.",
    );
  });

  it("adds large batches above one pull request per deploy, and caps the practices at three", () => {
    const result = freq({ prsPerDeploy: summary(2) });
    expect(result.findings[1]).toBe("The median deploy shipped 2 pull requests, so changes are released in batches.");
    expect(result.practices.map((p) => p.name)).toEqual([
      "Deployment automation",
      "Continuous delivery",
      "Working in small batches",
    ]);
  });

  it("does not call exactly one pull request per deploy a large batch", () => {
    expect(freq({ prsPerDeploy: summary(1) }).findings).toHaveLength(1);
  });

  it("does not call an unknown batch size large", () => {
    expect(freq({ prsPerDeploy: summary(null) }).findings).toHaveLength(1);
  });

  it("says so when the range holds no complete week", () => {
    expect(freq({ deploys: 3, weeks: 0, weeksWithoutDeploy: 0 }).findings[0]).toBe(
      "The tile divides 3 successful deploys by 4 weeks, counting every week the range touches, partial ones included. None of those weeks was complete, so none is counted as a week without a deploy.",
    );
  });

  it("still states the deploys and batches at elite, with no practices", () => {
    const result = freq({ prsPerDeploy: summary(2) }, true);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toContain("The tile divides 3 successful deploys by 4 weeks");
    expect(result.practices).toEqual([]);
  });
});

describe("explainDora change failure", () => {
  const failure = (patch: Partial<DoraDrivers["changeFailure"]>, band: "elite" | "low" = "low") =>
    explainDora(
      withDrivers({
        changeFailure: { ...base.doraDrivers.changeFailure, ...patch },
        position: {
          ...base.doraDrivers.position,
          changeFailure:
            band === "elite"
              ? { band: "elite", next: null, threshold: null, gap: null }
              : { band: "low", next: "medium", threshold: 0.15, gap: 0.1 },
        },
      }),
    ).changeFailure!;

  it("states the failed runs, the worst workflow and the rework", () => {
    const result = failure({
      failed: 3,
      total: 8,
      byWorkflow: [
        { workflow: "release.yml", failed: 2, total: 3 },
        { workflow: "deploy.yml", failed: 1, total: 5 },
      ],
      rework: { deploys: 2, total: 5 },
    });
    // 3 of 8 is 37.5 percent, which rounds to 38.
    expect(result.findings).toEqual([
      "3 of 8 production deploys failed, which is 38%.",
      "Most failures came from the release.yml workflow, 2 of its 3 runs.",
      "2 of 5 successful deploys shipped a revert or hotfix pull request.",
    ]);
    expect(result.practices.map((p) => p.name)).toEqual(["Test automation", "Continuous integration", "Code maintainability"]);
  });

  it("leaves out the workflow when none failed and the rework when core has none", () => {
    const result = failure({ failed: 0, total: 4, byWorkflow: [{ workflow: "deploy.yml", failed: 0, total: 4 }], rework: null });
    expect(result.findings).toEqual(["0 of 4 production deploys failed, which is 0%."]);
  });

  it("has nothing to say with no runs", () => {
    const result = failure({ failed: 0, total: 0, byWorkflow: [], rework: null });
    expect(result.findings).toEqual([]);
    expect(result.practices).toEqual([]);
  });

  it("still states the failures at elite, with no practices", () => {
    const result = failure({ failed: 1, total: 25, byWorkflow: [{ workflow: "deploy.yml", failed: 1, total: 25 }] }, "elite");
    expect(result.findings[0]).toBe("1 of 25 production deploys failed, which is 4%.");
    expect(result.practices).toEqual([]);
  });
});

describe("explainDora time to restore", () => {
  const restore = (patch: Partial<DoraDrivers["timeToRestore"]>, band: "elite" | "high" = "high") =>
    explainDora(
      withDrivers({
        timeToRestore: { ...base.doraDrivers.timeToRestore, ...patch },
        position: {
          ...base.doraDrivers.position,
          timeToRestore:
            band === "elite"
              ? { band: "elite", next: null, threshold: null, gap: null }
              : { band: "high", next: "elite", threshold: 1, gap: 1 },
        },
      }),
    ).timeToRestore!;

  it("states the streaks, the failed runs in each and the longest restore", () => {
    const result = restore({ streaks: 2, failedRunsPerStreak: summary(1.5), longestHours: 30 });
    expect(result.findings).toEqual([
      "2 failure streaks were put right, with a median of 1.5 failed runs per streak, and the longest took 30 h.",
    ]);
    expect(result.practices.map((p) => p.name)).toEqual([
      "Monitoring and observability",
      "Proactive failure notification",
      "Deployment automation",
    ]);
  });

  it("uses the singular for one streak of one failed run", () => {
    expect(restore({}).findings).toEqual([
      "1 failure streak was put right, with a median of 1 failed run per streak, and the longest took 2 h.",
    ]);
  });

  it("leaves out the median and the longest when core has none", () => {
    expect(restore({ failedRunsPerStreak: summary(null), longestHours: null }).findings).toEqual([
      "1 failure streak was put right.",
    ]);
  });

  it("reports a streak that has not recovered, ahead of the recovered ones", () => {
    const result = restore({ unrecovered: { since: "2026-01-20T10:00:00Z", failedRuns: 2 } });
    expect(result.findings[0]).toBe("2 failed runs have had no successful deploy after them since 20 Jan 2026.");
    expect(result.findings).toHaveLength(2);
  });

  it("uses the singular for one unrecovered run", () => {
    const result = restore({ unrecovered: { since: "2026-01-20T10:00:00Z", failedRuns: 1 } });
    expect(result.findings[0]).toBe("1 failed run has had no successful deploy after it since 20 Jan 2026.");
  });

  it("still reports an unrecovered streak at elite, with no practices", () => {
    const result = restore({ unrecovered: { since: "2026-01-20T10:00:00Z", failedRuns: 3 } }, "elite");
    expect(result.findings[0]).toBe("3 failed runs have had no successful deploy after them since 20 Jan 2026.");
    expect(result.practices).toEqual([]);
  });

  it("states the recovered streaks at elite too, so an elite figure says why it holds", () => {
    expect(restore({ longestHours: 0.5 }, "elite").findings).toEqual([
      "1 failure streak was put right, with a median of 1 failed run per streak, and the longest took 30 min.",
    ]);
  });

  it("quotes the monitoring page's own words about time to restore", () => {
    const monitoring = restore({}).practices.find((p) => p.name === "Monitoring and observability")!;
    expect(monitoring.why).toContain('time to restore "the key metric in the event of an outage or service degradation".');
  });

  it("explains that DORA calls the measure failed deployment recovery time", () => {
    expect(restore({}).note).toContain("failed deployment recovery time");
  });

  it("carries the rename note on this measure only", () => {
    const all = explainDora(base);
    expect(all.leadTime!.note).toBeNull();
    expect(all.deploymentFrequency!.note).toBeNull();
    expect(all.changeFailure!.note).toBeNull();
  });
});

describe("explainDora when a measure is missing", () => {
  it("gives no explanation for a measure that was not measured", () => {
    const result = explainDora(report({ dora: { ...base.dora, leadTime: null, timeToRestore: null } }));
    expect(result.leadTime).toBeNull();
    expect(result.timeToRestore).toBeNull();
    expect(result.deploymentFrequency).not.toBeNull();
    expect(result.changeFailure).not.toBeNull();
  });

  it("gives no explanation when core has no position, even if the figure exists", () => {
    const result = explainDora(withDrivers({ position: { ...base.doraDrivers.position, changeFailure: null } }));
    expect(result.changeFailure).toBeNull();
  });

  it("explains all four measures of a fully measured report", () => {
    const result = explainDora(base);
    expect(Object.values(result).every((e) => e !== null)).toBe(true);
  });
});

describe("explainDora never names a person", () => {
  it("leaves every author in the fixture out of every sentence", () => {
    const result = explainDora(base);
    const all = JSON.stringify(result).toLowerCase();
    for (const { author } of base.authors) expect(all).not.toMatch(new RegExp(`\\b${author}\\b`));
  });
});
