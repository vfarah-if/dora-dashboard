import { describe, expect, it } from "vitest";
import {
  completeWeeks,
  cumulative,
  endLabelOffsets,
  lastValueIndex,
  meanStages,
  mergeWeekly,
  overlappingRange,
  positiveOnly,
  shortestHistory,
  stageShares,
  throughput,
  type WeeklySeries,
} from "./compare";
import { week } from "../test/fixtures";

const long: WeeklySeries = {
  key: "a",
  weekly: [0, 1, 2, 3].map((i) => week({ week: `2026-01-${String(5 + i * 7).padStart(2, "0")}`, weekIndex: i, merged: i + 1 })),
};
const short: WeeklySeries = {
  key: "b",
  weekly: [0, 1].map((i) => week({ week: `2026-02-${String(2 + i * 7).padStart(2, "0")}`, weekIndex: i, merged: 10 + i })),
};

describe("mergeWeekly in calendar mode", () => {
  it("unions calendar weeks and leaves weeks a repository has no row for as null", () => {
    const { rows, clippedTo } = mergeWeekly([long, short], { aligned: false, value: (w) => w.merged });
    expect(clippedTo).toBeNull();
    expect(rows.map((r) => r.x)).toEqual(["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02", "2026-02-09"]);
    expect(rows[0]).toEqual({ x: "2026-01-05", a: 1, b: null });
    expect(rows[4]).toEqual({ x: "2026-02-02", a: null, b: 10 });
  });
});

describe("mergeWeekly aligned to project start", () => {
  it("uses the week index as x and clips every repository to the shortest history", () => {
    const { rows, clippedTo } = mergeWeekly([long, short], { aligned: true, value: (w) => w.merged });
    expect(clippedTo).toBe(2);
    expect(rows).toEqual([
      { x: 0, a: 1, b: 10 },
      { x: 1, a: 2, b: 11 },
    ]);
  });

  it("ignores rows from before a project's first pull request", () => {
    const early: WeeklySeries = { key: "c", weekly: [week({ week: "2025-12-29", weekIndex: -1 }), ...short.weekly] };
    expect(shortestHistory([early])).toBe(2);
    const { rows } = mergeWeekly([early], { aligned: true, value: (w) => w.merged });
    expect(rows.map((r) => r.x)).toEqual([0, 1]);
  });

  it("returns no rows when a repository has no history", () => {
    const empty: WeeklySeries = { key: "d", weekly: [] };
    expect(shortestHistory([])).toBe(0);
    expect(mergeWeekly([long, empty], { aligned: true, value: (w) => w.merged }).rows).toEqual([]);
  });
});

describe("throughput", () => {
  it("returns merged count, or merged per active author when per contributor is on", () => {
    const row = week({ week: "2026-01-05", weekIndex: 0, merged: 6, activeAuthors: 3 });
    expect(throughput(row, false)).toBe(6);
    expect(throughput(row, true)).toBe(2);
  });

  it("returns null per contributor when nobody was active rather than dividing by zero", () => {
    const idle = week({ week: "2026-01-05", weekIndex: 0, merged: 0, activeAuthors: 0 });
    expect(throughput(idle, true)).toBeNull();
    expect(throughput(idle, false)).toBe(0);
  });
});

describe("cumulative", () => {
  it("keeps running totals, starts each series at its first value and carries totals over gaps", () => {
    const rows = [
      { x: "w1", a: 1, b: null },
      { x: "w2", a: null, b: 2 },
      { x: "w3", a: 3, b: 1 },
    ];
    expect(cumulative(rows, ["a", "b"])).toEqual([
      { x: "w1", a: 1, b: null },
      { x: "w2", a: 1, b: 2 },
      { x: "w3", a: 4, b: 3 },
    ]);
  });
});

describe("positiveOnly and lastValueIndex", () => {
  it("drops zero values for a log scale and finds the last plotted point", () => {
    const rows = positiveOnly(
      [
        { x: 1, a: 0, b: 2 },
        { x: 2, a: 3, b: null },
      ],
      ["a", "b"],
    );
    expect(rows).toEqual([
      { x: 1, a: null, b: 2 },
      { x: 2, a: 3, b: null },
    ]);
    expect(lastValueIndex(rows, "a")).toBe(1);
    expect(lastValueIndex(rows, "b")).toBe(0);
    expect(lastValueIndex(rows, "c")).toBe(-1);
  });
});

describe("stages", () => {
  it("averages the weekly stage means and turns them into shares", () => {
    const weekly = [
      week({ week: "w1", weekIndex: 0, stages: { coding: 2, waitingForReview: 4, inReview: 2, toMerge: 0 } }),
      week({ week: "w2", weekIndex: 1, stages: null }),
      week({ week: "w3", weekIndex: 2, stages: { coding: 0, waitingForReview: 0, inReview: 2, toMerge: 4 } }),
    ];
    const means = meanStages(weekly);
    expect(means).toEqual({ coding: 1, waitingForReview: 2, inReview: 2, toMerge: 2 });
    expect(stageShares(means)).toEqual({ coding: 1 / 7, waitingForReview: 2 / 7, inReview: 2 / 7, toMerge: 2 / 7 });
  });

  it("returns null without stage data or with an all zero total", () => {
    expect(meanStages([week({ week: "w1", weekIndex: 0, stages: null })])).toBeNull();
    expect(stageShares(null)).toBeNull();
    expect(stageShares({ coding: 0, waitingForReview: 0, inReview: 0, toMerge: 0 })).toBeNull();
  });
});

describe("overlappingRange", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("runs from the latest project start to today", () => {
    expect(overlappingRange([{ projectStart: "2025-01-10T09:00:00Z" }, { projectStart: "2026-02-03T18:00:00Z" }], now)).toEqual({
      from: "2026-02-03",
      to: "2026-06-15",
    });
  });

  it("returns null when any report has no project start, or there are no reports", () => {
    expect(overlappingRange([{ projectStart: "2025-01-10T09:00:00Z" }, { projectStart: null }], now)).toBeNull();
    expect(overlappingRange([], now)).toBeNull();
  });
});

describe("completeWeeks", () => {
  it("drops part-finished weeks and leaves the rest untouched", () => {
    const series = [
      {
        key: "a",
        weekly: [week({ week: "2026-09-21", weekIndex: 0 }), week({ week: "2026-09-28", weekIndex: 1, partial: true })],
      },
    ];
    expect(completeWeeks(series)[0]!.weekly.map((w) => w.week)).toEqual(["2026-09-21"]);
    expect(series[0]!.weekly).toHaveLength(2);
  });
});

describe("endLabelOffsets", () => {
  it("pushes the lower of two close line ends down until the labels clear each other", () => {
    // Ends at 100 and 98 on a 200px chart sit 4px apart, so the lower one moves 10px to make a 14px gap.
    const rows = [{ x: 1, a: 100, b: 98 }];
    expect(endLabelOffsets(rows, ["a", "b"], 200)).toEqual({ a: 0, b: 10 });
  });

  it("leaves well separated ends alone and ignores a series with no values", () => {
    const rows = [
      { x: 1, a: 100, b: 10, c: null },
      { x: 2, a: null, b: 20, c: null },
    ];
    expect(endLabelOffsets(rows, ["a", "b", "c"], 200)).toEqual({ a: 0, b: 0, c: 0 });
  });

  it("measures against the tallest value in the chart, not the tallest end", () => {
    // The axis runs to 100, so ends at 52 and 51 on a 200px chart sit 2px apart and the lower moves 12px.
    // Measured against the higher end alone the gap would be about 4px and move the label by the wrong amount.
    const rows = [
      { x: 1, a: 100, b: 50 },
      { x: 2, a: 52, b: 51 },
    ];
    expect(endLabelOffsets(rows, ["a", "b"], 200)).toEqual({ a: 0, b: 12 });
  });

  it("moves the stack up rather than pushing a label below the axis", () => {
    // Both ends are 0 on a 200px chart, so both sit at 200px; the higher-sorted label moves up 14px.
    const rows = [
      { x: 1, a: 10, b: 10 },
      { x: 2, a: 0, b: 0 },
    ];
    expect(endLabelOffsets(rows, ["a", "b"], 200)).toEqual({ a: -14, b: 0 });
  });

  it("does nothing for a single series", () => {
    expect(endLabelOffsets([{ x: 1, a: 5 }], ["a"], 200)).toEqual({ a: 0 });
  });
});
