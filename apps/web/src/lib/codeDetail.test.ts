import { describe, expect, it } from "vitest";
import { codeHealthReport } from "../test/fixtures";
import { copy } from "../copy";
import { areaChartRows, areaLabel, maintainabilityLines, rangesLabel, searchWithArea } from "./codeDetail";

describe("rangesLabel", () => {
  it("writes a span as 'first to last' and a single line on its own", () => {
    expect(
      rangesLabel({
        items: [
          [12, 30],
          [44, 44],
        ],
        total: 2,
      }),
    ).toBe("12 to 30, 44");
  });

  it("says how many more there were when the list was cut short", () => {
    expect(
      rangesLabel({
        items: [
          [1, 2],
          [5, 5],
        ],
        total: 6,
      }),
    ).toBe("1 to 2, 5 and 4 more");
  });

  it("is empty when there are no ranges", () => {
    expect(rangesLabel({ items: [], total: 0 })).toBe("");
  });
});

describe("areaLabel", () => {
  it("gives the files at the root a readable name", () => {
    expect(areaLabel(".")).toBe(copy.codeAnalysis.areas.root);
  });

  it("leaves a folder path as it is", () => {
    expect(areaLabel("apps/api")).toBe("apps/api");
  });

  it("names a missing area", () => {
    expect(areaLabel(null)).toBe(copy.codeAnalysis.areas.none);
    expect(areaLabel(undefined)).toBe(copy.codeAnalysis.areas.none);
  });
});

describe("areaChartRows", () => {
  const areas = [
    { path: "packages/core", nlocAboveWarn: 50 },
    { path: "apps/web", nlocAboveWarn: 50 },
    { path: ".", nlocAboveWarn: 60 },
  ];

  it("orders by complex lines, then by path, and names the root area", () => {
    const { all } = areaChartRows(areas);
    expect(all.map((r) => [r.label, r.lines])).toEqual([
      [copy.codeAnalysis.areas.root, 60],
      ["apps/web", 50],
      ["packages/core", 50],
    ]);
  });

  it("draws only the first rows and keeps every row for the table", () => {
    const { bars, all } = areaChartRows(areas, 2);
    expect(bars).toHaveLength(2);
    expect(all).toHaveLength(3);
  });

  it("takes the lines straight from core without arithmetic", () => {
    expect(areaChartRows([{ path: "a", nlocAboveWarn: 3 }]).all[0]!.lines).toBe(3);
  });
});

describe("searchWithArea", () => {
  it("sets the area and keeps the range", () => {
    expect(searchWithArea("?from=2026-01-01&bots=1", "apps/api")).toBe("?from=2026-01-01&bots=1&area=apps%2Fapi");
  });

  it("replaces an earlier area", () => {
    expect(searchWithArea("?area=a", "b")).toBe("?area=b");
  });

  it("removes the area, and the question mark when nothing is left", () => {
    expect(searchWithArea("?area=a&to=2026-02-01", null)).toBe("?to=2026-02-01");
    expect(searchWithArea("?area=a", null)).toBe("");
  });
});

describe("maintainabilityLines", () => {
  const checks = codeHealthReport().checks.filter((c) => c.part === "maintainability");
  const longest = codeHealthReport().longestFunction;

  it("writes one sentence for each maintainability check, with the band it allows", () => {
    const lines = maintainabilityLines({ maintainabilityChecks: checks, longestFunction: longest });
    expect(lines.map((l) => [l.check, l.band, l.text])).toEqual([
      ["linesAboveWarn", "elite", "Only 3.0% of source lines are in functions above complexity 10"],
      ["linesAboveHigh", "medium", "4.0% of source lines are in functions above complexity 20"],
      ["longFunctions", "low", "12 functions are longer than 60 lines, the longest being RepoCharts at 233 lines"],
      ["manyParams", "elite", "Only 0.5% of functions take more than 5 parameters"],
    ]);
  });

  it("skips a check with no figure, and any check that is not about maintainability", () => {
    const lines = maintainabilityLines({
      maintainabilityChecks: [
        { part: "maintainability", check: "manyParams", value: null, limits: false },
        { part: "testing", check: "testRatio", value: 0.4, band: "high", limits: false },
      ],
      longestFunction: null,
    });
    expect(lines).toEqual([]);
  });
});
