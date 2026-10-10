import { describe, expect, it } from "vitest";
import { DEFAULT_CODE_THRESHOLDS, codeFigures, codeHealth, type CodeSnapshot, type FunctionMetrics } from "../src/codeHealth.js";

const fn = (name: string, file: string, ccn: number, nloc: number, params = 1): FunctionMetrics => ({
  file,
  language: "TypeScript",
  name,
  startLine: 1,
  ccn,
  nloc,
  params,
});

// Source CCNs 2, 12, 25 over 10, 20 and 30 lines, and one test function of 8 lines.
const functions = [
  fn("a", "src/a.ts", 2, 10),
  fn("b", "src/b.ts", 12, 20),
  fn("c", "src/c.ts", 25, 30),
  fn("t", "test/a.test.ts", 1, 8),
];
const snapshot: CodeSnapshot = { commitSha: "abc123", analysedAt: "2026-09-29T10:00:00Z", functions };

describe("codeFigures", () => {
  const figures = codeFigures(functions);

  it("counts source functions and lines, and sets tests apart", () => {
    expect(figures).toMatchObject({ functions: 3, nloc: 60, tests: { functions: 1, nloc: 8 } });
  });

  it("counts functions above each threshold", () => {
    // CCN above 10: b and c. Above 20: c.
    expect(figures).toMatchObject({ countAboveWarn: 2, countAboveHigh: 1 });
    expect(figures.shareAboveWarn).toBeCloseTo(2 / 3);
  });

  it("measures the share of lines above the warning limit", () => {
    // (20 + 30) / 60 lines.
    expect(figures.maintainability.linesAboveWarn).toBeCloseTo(50 / 60);
    expect(figures.maintainabilityBand).toBe("low");
  });

  it("lists one maintainability check per figure, with the function counts", () => {
    expect(figures.maintainabilityChecks.map((c) => [c.check, c.count])).toEqual([
      ["linesAboveWarn", 2],
      ["linesAboveHigh", 1],
      ["longFunctions", 0],
      ["manyParams", 0],
    ]);
  });

  it("names the most complex and the longest function", () => {
    expect(figures.mostComplex?.name).toBe("c");
    expect(figures.longestFunction?.name).toBe("c");
  });

  it("honours thresholds passed in", () => {
    expect(codeFigures(functions, { warn: 1, high: 11 })).toMatchObject({ countAboveWarn: 3, countAboveHigh: 2 });
  });

  it("describes no functions as an empty set with no band, since there is nothing to judge", () => {
    expect(codeFigures([])).toMatchObject({
      functions: 0,
      nloc: 0,
      mostComplex: null,
      longestFunction: null,
      nextBand: null,
      maintainabilityBand: null,
    });
    // Test functions alone are still nothing to judge.
    expect(
      codeFigures([{ file: "src/a.test.ts", language: "TypeScript", name: "t", startLine: 1, ccn: 1, nloc: 1, params: 0 }])
        .maintainabilityBand,
    ).toBeNull();
  });
});

describe("codeHealth thresholds", () => {
  it("reports the thresholds its counts were taken at", () => {
    expect(codeHealth(snapshot).thresholds).toEqual(DEFAULT_CODE_THRESHOLDS);
    expect(codeHealth(snapshot, [], {}, { warn: 3, high: 30 }).thresholds).toEqual({ warn: 3, high: 30 });
    expect(codeHealth(snapshot, [], {}, { warn: 3, high: 30 })).toMatchObject({ countAboveWarn: 2, countAboveHigh: 0 });
  });

  it("agrees with codeFigures on the figures they share", () => {
    const report = codeHealth(snapshot);
    const figures = codeFigures(functions);
    expect(report.maintainability).toEqual(figures.maintainability);
    expect(report.hotspots).toEqual(figures.hotspots);
    expect(report.distribution).toEqual(figures.distribution);
    expect(report.nextBand).toEqual(figures.nextBand);
  });

  it("does not carry the maintainability band or checks of codeFigures as extra fields", () => {
    expect(codeHealth(snapshot)).not.toHaveProperty("maintainabilityBand");
    expect(codeHealth(snapshot)).not.toHaveProperty("maintainabilityChecks");
  });
});
