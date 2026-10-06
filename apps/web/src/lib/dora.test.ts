import { describe, expect, it } from "vitest";
import { doraFigures, reworkFigure, repoDoraHref } from "./dora";
import { rangeQuery } from "../api/hooks";
import { report } from "../test/fixtures";

describe("reworkFigure", () => {
  it("formats the rate and counts the deploys, with no band", () => {
    const base = report();
    const figure = reworkFigure({
      ...base,
      dora: { ...base.dora, changeFailure: { ...base.dora.changeFailure!, rework: { rate: 1 / 3, deploys: 1, total: 3 } } },
    });
    expect(figure.value).toBe("33%");
    expect(figure.detail).toBe("1 of 3 deploys shipped a revert or hotfix");
    expect(figure.band).toBeNull();
  });

  it("has no value when change failure is missing", () => {
    const base = report();
    expect(reworkFigure({ ...base, dora: { ...base.dora, changeFailure: null } }).value).toBeNull();
  });
});

describe("rangeQuery", () => {
  const range = { from: null, to: null, includeBots: false };
  it("sends the profile only when one is set", () => {
    expect(rangeQuery(range)).toBe("");
    expect(rangeQuery({ ...range, profile: null })).toBe("");
    expect(rangeQuery({ ...range, profile: "dora-2023" })).toBe("profile=dora-2023");
  });
});

describe("doraFigures", () => {
  it("attaches an explanation to every measured figure", () => {
    const figures = doraFigures(report());
    expect(figures.map((f) => f.explanation !== null && f.explanation !== undefined)).toEqual([true, true, true, true]);
    expect(figures[2]!.explanation!.gap).toContain("25% of deploys failed");
  });

  it("attaches none to a figure that is missing", () => {
    const base = report();
    const figures = doraFigures({ ...base, dora: { ...base.dora, leadTime: null, timeToRestore: null } });
    expect(figures.map((f) => f.explanation ?? null).map((e) => e !== null)).toEqual([true, false, true, false]);
  });

  it("says since when failures have gone unrecovered when time to restore has nothing to measure", () => {
    const base = report();
    const figures = doraFigures({
      ...base,
      dora: { ...base.dora, timeToRestore: null },
      doraDrivers: {
        ...base.doraDrivers,
        timeToRestore: {
          ...base.doraDrivers.timeToRestore,
          streaks: 0,
          unrecovered: { since: "2026-01-20T10:00:00Z", failedRuns: 2 },
        },
      },
    });
    expect(figures[3]!.value).toBeNull();
    expect(figures[3]!.reason).toBe(
      "Failures have not been put right since 20 Jan 2026. 2 failed runs have had no successful deploy after them.",
    );
  });

  it("uses the singular for one unrecovered failed run", () => {
    const base = report();
    const figures = doraFigures({
      ...base,
      dora: { ...base.dora, timeToRestore: null },
      doraDrivers: {
        ...base.doraDrivers,
        timeToRestore: { ...base.doraDrivers.timeToRestore, unrecovered: { since: "2026-01-20T10:00:00Z", failedRuns: 1 } },
      },
    });
    expect(figures[3]!.reason).toBe(
      "Failures have not been put right since 20 Jan 2026. 1 failed run has had no successful deploy after it.",
    );
  });

  it("says no failure has recovered yet when none is left open either", () => {
    const base = report();
    const figures = doraFigures({ ...base, dora: { ...base.dora, timeToRestore: null } });
    expect(figures[3]!.reason).toBe("No failed deploy has been followed by a successful one yet.");
  });

  it("gives the rework figure no explanation", () => {
    expect(reworkFigure(report()).explanation).toBeUndefined();
  });
});

describe("repoDoraHref", () => {
  it("anchors at the DORA section and carries the range", () => {
    expect(repoDoraHref(4, { from: "2026-01-01", to: "2026-02-01", includeBots: true, profile: "dora-2023" })).toBe(
      "/repos/4?from=2026-01-01&to=2026-02-01&bots=1&profile=dora-2023#dora-title",
    );
  });

  it("leaves the query off when nothing is set", () => {
    expect(repoDoraHref(4, { from: null, to: null })).toBe("/repos/4#dora-title");
  });
});
