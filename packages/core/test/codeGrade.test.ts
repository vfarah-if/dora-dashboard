import { describe, expect, it } from "vitest";
import {
  GRADE_CHECKS,
  hygieneGrade,
  maintainabilityGrade,
  overallGrade,
  testingGrade,
  type MaintainabilityFigures,
  type TestingFigures,
} from "../src/codeGrade.js";

const clean: MaintainabilityFigures = { linesAboveWarn: 0, linesAboveHigh: 0, longFunctions: 0, manyParams: 0 };

describe("maintainabilityGrade", () => {
  // Each row: check, then the values that sit either side of each limit. Limits are exclusive upper bounds.
  it.each([
    ["linesAboveWarn", 0.0499, 0.05, 0.0999, 0.1, 0.1999, 0.2],
    ["linesAboveHigh", 0.0099, 0.01, 0.0299, 0.03, 0.0799, 0.08],
    ["longFunctions", 0.0099, 0.01, 0.0299, 0.03, 0.0599, 0.06],
    ["manyParams", 0.0099, 0.01, 0.0299, 0.03, 0.0599, 0.06],
  ] as const)("bands %s at each limit", (check, belowElite, atElite, belowHigh, atHigh, belowMedium, atMedium) => {
    const band = (value: number) => maintainabilityGrade({ ...clean, [check]: value }).band;

    expect(band(0)).toBe("elite");
    expect(band(belowElite)).toBe("elite");
    expect(band(atElite)).toBe("high");
    expect(band(belowHigh)).toBe("high");
    expect(band(atHigh)).toBe("medium");
    expect(band(belowMedium)).toBe("medium");
    expect(band(atMedium)).toBe("low");
    expect(band(1)).toBe("low");
  });

  it("is elite with a general reason when every check is clean", () => {
    expect(maintainabilityGrade(clean)).toEqual({
      band: "elite",
      check: "all",
      reason: "Every maintainability check is in the elite band",
    });
  });

  it("takes the worst check and names it", () => {
    const grade = maintainabilityGrade({ linesAboveWarn: 0.15, linesAboveHigh: 0.02, longFunctions: 0.5, manyParams: 0 });

    expect(grade).toEqual({ band: "low", check: "longFunctions", reason: "50.0% of source functions are longer than 60 lines" });
  });

  it("names the first check listed when two share the worst band", () => {
    const grade = maintainabilityGrade({ ...clean, linesAboveHigh: 0.02, manyParams: 0.02 });

    expect(grade).toMatchObject({ band: "high", check: "linesAboveHigh" });
    expect(grade.reason).toBe("2.0% of source lines sit in functions with a complexity above 20");
  });

  it("words each check", () => {
    expect(maintainabilityGrade({ ...clean, linesAboveWarn: 0.123 }).reason).toBe(
      "12.3% of source lines sit in functions with a complexity above 10",
    );
    expect(maintainabilityGrade({ ...clean, manyParams: 0.25 }).reason).toBe(
      "25.0% of source functions take more than 5 parameters",
    );
  });
});

describe("testingGrade", () => {
  const strong: TestingFigures = { testRatio: 0.5, prsWithTests: 0.6, ciRunsTests: true, coverageFloor: 80 };

  it("is elite only when every requirement holds, at the exact limits", () => {
    expect(testingGrade(strong)).toEqual({ band: "elite", check: "all", reason: "Every testing requirement is met" });
  });

  it("ignores pull requests when none has file data", () => {
    expect(testingGrade({ ...strong, prsWithTests: null }).band).toBe("elite");
    expect(testingGrade({ testRatio: 0.3, prsWithTests: null, ciRunsTests: true, coverageFloor: null }).band).toBe("high");
  });

  it("counts a coverage floor only from 60, and says what it is when it is lower", () => {
    expect(testingGrade({ ...strong, coverageFloor: 60 }).band).toBe("elite");
    expect(testingGrade({ ...strong, coverageFloor: 59 })).toEqual({
      band: "high",
      check: "coverageFloor",
      reason: "The coverage floor is 59% , and Elite needs at least 60%".replace("% ,", "%,"),
    });
  });

  it("stops at high, and says so, without a coverage floor", () => {
    expect(testingGrade({ ...strong, coverageFloor: null })).toEqual({
      band: "high",
      check: "coverageFloor",
      reason: "No coverage floor is set",
    });
  });

  it("stops at high below an elite test ratio", () => {
    expect(testingGrade({ ...strong, testRatio: 0.45 })).toEqual({
      band: "high",
      check: "testRatio",
      reason: "Test code is 0.45 of the size of source code, and Elite needs 0.5",
    });
  });

  it("stops at high below 60% of pull requests with tests", () => {
    expect(testingGrade({ ...strong, prsWithTests: 0.59 })).toEqual({
      band: "high",
      check: "prsWithTests",
      reason: "59.0% of merged pull requests that change source also change tests, and Elite needs 60%",
    });
  });

  it("is high at exactly 0.3, 40% and CI", () => {
    expect(testingGrade({ testRatio: 0.3, prsWithTests: 0.4, ciRunsTests: true, coverageFloor: null }).band).toBe("high");
  });

  it.each([
    ["ratio 0.29", { testRatio: 0.29, prsWithTests: 0.4, ciRunsTests: true, coverageFloor: null }, "testRatio"],
    ["39% of pull requests", { testRatio: 0.3, prsWithTests: 0.39, ciRunsTests: true, coverageFloor: null }, "prsWithTests"],
    ["no CI test run", { testRatio: 0.3, prsWithTests: 0.4, ciRunsTests: false, coverageFloor: null }, "ciRunsTests"],
  ] as const)("drops to medium with %s", (_name, figures, check) => {
    expect(testingGrade(figures)).toMatchObject({ band: "medium", check });
  });

  it("says CI does not run the tests", () => {
    expect(testingGrade({ testRatio: 0.5, prsWithTests: 0.6, ciRunsTests: false, coverageFloor: 80 }).reason).toBe(
      "CI does not run the tests",
    );
  });

  it("is medium at exactly 0.1 and 20% with nothing else", () => {
    expect(testingGrade({ testRatio: 0.1, prsWithTests: 0.2, ciRunsTests: false, coverageFloor: null }).band).toBe("medium");
  });

  it("is low just under 0.1, naming the ratio", () => {
    expect(testingGrade({ testRatio: 0.09, prsWithTests: 0.5, ciRunsTests: true, coverageFloor: 80 })).toEqual({
      band: "low",
      check: "testRatio",
      reason: "Test code is 0.09 of the size of source code, and Medium needs 0.1",
    });
  });

  it("is low just under 20% of pull requests", () => {
    expect(testingGrade({ testRatio: 0.5, prsWithTests: 0.19, ciRunsTests: true, coverageFloor: 80 })).toMatchObject({
      band: "low",
      check: "prsWithTests",
      reason: "19.0% of merged pull requests that change source also change tests, and Medium needs 20%",
    });
  });

  it("is low with no tests at all", () => {
    expect(testingGrade({ testRatio: 0, prsWithTests: null, ciRunsTests: false, coverageFloor: null })).toEqual({
      band: "low",
      check: "testRatio",
      reason: "No test code was found",
    });
  });
});

describe("hygieneGrade", () => {
  const all = {
    linterConfigured: true,
    formatterConfigured: true,
    ciRunsLinter: true,
    ciChecksFormat: true,
    onlyEditorconfig: false,
  };

  it("is elite with four checks", () => {
    expect(hygieneGrade(all)).toEqual({ band: "elite", check: "all", reason: "All four hygiene checks pass" });
  });

  it("is high with three, naming the missing one", () => {
    expect(hygieneGrade({ ...all, ciChecksFormat: false })).toEqual({
      band: "high",
      check: "ciFormat",
      reason: "CI does not check formatting",
    });
  });

  it("is medium with two, and names both", () => {
    expect(hygieneGrade({ ...all, linterConfigured: false, ciRunsLinter: false })).toEqual({
      band: "medium",
      check: "linter",
      reason: "No linter is configured, and CI does not run a linter",
    });
  });

  it("is medium with one", () => {
    expect(hygieneGrade({ ...all, linterConfigured: false, formatterConfigured: false, ciRunsLinter: false }).band).toBe(
      "medium",
    );
  });

  it("is low with none, and explains an editorconfig-only formatter", () => {
    const grade = hygieneGrade({
      linterConfigured: false,
      formatterConfigured: false,
      ciRunsLinter: false,
      ciChecksFormat: false,
      onlyEditorconfig: true,
    });

    expect(grade.band).toBe("low");
    expect(grade.reason).toBe(
      "No linter is configured, and no formatter is configured (an editorconfig file only guides editors), and CI does not run a linter, and CI does not check formatting",
    );
  });
});

describe("overallGrade", () => {
  const part = (band: "elite" | "high" | "medium" | "low", check = "x") => ({ band, check, reason: `reason ${band}` });

  it("is the lowest part and names it with its reason", () => {
    expect(overallGrade({ maintainability: part("high"), testing: part("low", "testRatio"), hygiene: part("medium") })).toEqual({
      part: "testing",
      band: "low",
      check: "testRatio",
      reason: "Testing is the lowest part. reason low",
    });
  });

  it("names the earlier part on a tie", () => {
    expect(overallGrade({ maintainability: part("medium"), testing: part("medium"), hygiene: part("medium") }).part).toBe(
      "maintainability",
    );
    expect(overallGrade({ maintainability: part("high"), testing: part("medium"), hygiene: part("medium") }).part).toBe(
      "testing",
    );
  });

  it("finds hygiene when it is alone at the bottom", () => {
    expect(overallGrade({ maintainability: part("elite"), testing: part("high"), hygiene: part("medium") }).part).toBe("hygiene");
  });

  it("has a plain reason when everything is elite", () => {
    expect(overallGrade({ maintainability: part("elite"), testing: part("elite"), hygiene: part("elite") }).reason).toBe(
      "Every part is in the elite band",
    );
  });
});

describe("GRADE_CHECKS", () => {
  it("lists every check identifier a part can report", () => {
    const testing = [
      { testRatio: 0, prsWithTests: null, ciRunsTests: false, coverageFloor: null },
      { testRatio: 0.5, prsWithTests: 0.5, ciRunsTests: true, coverageFloor: null },
      { testRatio: 0.5, prsWithTests: 0.6, ciRunsTests: false, coverageFloor: 80 },
      { testRatio: 0.5, prsWithTests: 0.6, ciRunsTests: true, coverageFloor: null },
      { testRatio: 0.5, prsWithTests: 0.6, ciRunsTests: true, coverageFloor: 80 },
    ].map((f) => testingGrade(f).check);
    const maintainability = (["linesAboveWarn", "linesAboveHigh", "longFunctions", "manyParams"] as const)
      .map((key) => maintainabilityGrade({ ...clean, [key]: 1 }).check)
      .concat(maintainabilityGrade(clean).check);
    const hygiene = [
      { linterConfigured: false, formatterConfigured: true, ciRunsLinter: true, ciChecksFormat: true },
      { linterConfigured: true, formatterConfigured: false, ciRunsLinter: true, ciChecksFormat: true },
      { linterConfigured: true, formatterConfigured: true, ciRunsLinter: false, ciChecksFormat: true },
      { linterConfigured: true, formatterConfigured: true, ciRunsLinter: true, ciChecksFormat: false },
      { linterConfigured: true, formatterConfigured: true, ciRunsLinter: true, ciChecksFormat: true },
    ].map((f) => hygieneGrade({ ...f, onlyEditorconfig: false }).check);

    expect(new Set(maintainability)).toEqual(new Set(GRADE_CHECKS.maintainability));
    expect(new Set(hygiene)).toEqual(new Set(GRADE_CHECKS.hygiene));
    expect(new Set(testing)).toEqual(new Set(GRADE_CHECKS.testing));
  });
});
