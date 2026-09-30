import { describe, expect, it } from "vitest";
import type { CodeHealthReport, GradeCheck } from "@dora-dashboard/core";
import { checkOf, findings, goodAndImprove, limitingSentence, shareLabel, toolName, verdictSentence } from "./codeVerdict";

type Check = Partial<GradeCheck> & Pick<GradeCheck, "part" | "check">;
const check = (c: Check): GradeCheck => ({ value: null, limits: false, ...c });

function report(checks: GradeCheck[], extra: Partial<CodeHealthReport> = {}): CodeHealthReport {
  return {
    status: "ok",
    checks,
    functions: 100,
    longestFunction: { file: "a.ts", language: "TypeScript", name: "big", startLine: 1, ccn: 3, nloc: 233, params: 1 },
    hygiene: null,
    grade: null,
    ...extra,
  } as unknown as CodeHealthReport;
}

const grade = (over: Partial<Record<"maintainability" | "testing" | "hygiene", "elite" | "high" | "medium" | "low">> = {}) => {
  const part = (band: "elite" | "high" | "medium" | "low") => ({ band, check: "all", reason: "" });
  return {
    overall: { part: "maintainability", band: "low", check: "all", reason: "" },
    maintainability: part(over.maintainability ?? "elite"),
    testing: part(over.testing ?? "elite"),
    hygiene: part(over.hygiene ?? "elite"),
  } as unknown as CodeHealthReport["grade"];
};

describe("goodAndImprove", () => {
  it("lists elite and met checks as good and everything else to improve", () => {
    const { good, improve } = goodAndImprove(
      report([
        check({ part: "maintainability", check: "manyParams", value: 0, band: "elite" }),
        check({ part: "maintainability", check: "linesAboveWarn", value: 0.15, band: "medium" }),
        check({ part: "hygiene", check: "linter", value: true, met: true, detail: ["eslint"] }),
        check({ part: "hygiene", check: "ciLinter", value: false, met: false, detail: [] }),
      ]),
    );
    expect(good.map((f) => f.check)).toEqual(["manyParams", "linter"]);
    expect(improve.map((f) => f.check)).toEqual(["linesAboveWarn", "ciLinter"]);
  });

  it("orders to improve by band, lowest first, keeping core's order for equals", () => {
    const { improve } = goodAndImprove(
      report([
        check({ part: "maintainability", check: "linesAboveWarn", value: 0.07, band: "high" }),
        check({ part: "maintainability", check: "manyParams", value: 0.5, band: "low" }),
        check({ part: "maintainability", check: "longFunctions", value: 0.04, band: "medium" }),
        check({ part: "maintainability", check: "linesAboveHigh", value: 0.04, band: "medium" }),
      ]),
    );
    expect(improve.map((f) => f.check)).toEqual(["manyParams", "longFunctions", "linesAboveHigh", "linesAboveWarn"]);
  });

  it("puts the limiting check first when bands tie", () => {
    const { improve } = goodAndImprove(
      report([
        check({ part: "maintainability", check: "linesAboveWarn", value: 0.15, band: "medium" }),
        check({ part: "maintainability", check: "manyParams", value: 0.04, band: "medium", limits: true }),
      ]),
    );
    expect(improve.map((f) => f.check)).toEqual(["manyParams", "linesAboveWarn"]);
  });

  it("ranks an unmet yes or no check by its part's band", () => {
    const { improve } = goodAndImprove(
      report(
        [
          check({ part: "hygiene", check: "ciFormat", value: false, met: false }),
          check({ part: "maintainability", check: "linesAboveWarn", value: 0.15, band: "medium" }),
        ],
        { grade: grade({ hygiene: "low" }) },
      ),
    );
    expect(improve.map((f) => f.check)).toEqual(["ciFormat", "linesAboveWarn"]);
  });

  it("skips a check with no figure and no band, but keeps a missing coverage floor", () => {
    const all = findings(
      report([
        check({ part: "testing", check: "prsWithTests", value: null }),
        check({ part: "testing", check: "coverageFloor", value: null, band: "high", met: false }),
      ]),
    );
    expect(all.map((f) => f.check)).toEqual(["coverageFloor"]);
    expect(all[0]!.text).toBe("No coverage floor is set");
  });

  it("leaves a report with no checks empty", () => {
    expect(goodAndImprove(report([]))).toEqual({ good: [], improve: [] });
  });
});

describe("sentences", () => {
  it("names the longest function and takes the count from core", () => {
    const { improve } = goodAndImprove(
      report([check({ part: "maintainability", check: "longFunctions", value: 0.07, band: "low", count: 7 })]),
    );
    expect(improve[0]!.text).toBe("7 functions are longer than 60 lines, the longest being big at 233 lines");
  });

  it("uses the singular for one function and omits the name when there is no longest function", () => {
    const { improve } = goodAndImprove(
      report([check({ part: "maintainability", check: "longFunctions", value: 0.01, band: "high", count: 1 })], {
        longestFunction: null,
      }),
    );
    expect(improve[0]!.text).toBe("1 function is longer than 60 lines");
  });

  it("falls back to the share when core sends no count", () => {
    const { improve } = goodAndImprove(
      report([
        check({ part: "maintainability", check: "longFunctions", value: 0.07, band: "low" }),
        check({ part: "maintainability", check: "manyParams", value: 0.07, band: "low" }),
      ]),
    );
    expect(improve.map((f) => f.text)).toEqual([
      "7.0% of functions are longer than 60 lines",
      "7.0% of functions take more than 5 parameters",
    ]);
  });

  it("counts functions with many parameters", () => {
    const { improve, good } = goodAndImprove(
      report([
        check({ part: "maintainability", check: "manyParams", value: 0.04, band: "medium", count: 4 }),
        check({ part: "maintainability", check: "linesAboveHigh", value: 0.005, band: "elite" }),
      ]),
    );
    expect(improve[0]!.text).toBe("4 functions take more than 5 parameters");
    expect(good[0]!.text).toBe("Only 0.5% of source lines are in functions above complexity 20");
  });

  it("words the testing checks by band", () => {
    const texts = goodAndImprove(
      report([
        check({ part: "testing", check: "testRatio", value: 0, band: "low", met: false }),
        check({ part: "testing", check: "prsWithTests", value: 0.18, band: "low", met: false, count: 9, total: 50 }),
        check({ part: "testing", check: "ciRunsTests", value: false, band: "medium", met: false }),
        check({ part: "testing", check: "coverageFloor", value: 80, band: "elite", met: true }),
      ]),
    );
    expect(texts.improve.map((f) => f.text)).toEqual([
      "No test code was found",
      "Only 18% of merged pull requests changed tests alongside code (9 of 50)",
      "CI does not run the tests",
    ]);
    expect(texts.good[0]!.text).toBe("A coverage floor of 80% is configured");
  });

  it("says a floor below the elite requirement is configured but too low", () => {
    const [f] = findings(report([check({ part: "testing", check: "coverageFloor", value: 40, band: "high", met: false })]));
    expect(f!.text).toBe("A coverage floor of 40% is configured but below the 60% needed for elite");
  });

  it("words a middling ratio and pull request share without 'only'", () => {
    const texts = findings(
      report([
        check({ part: "testing", check: "testRatio", value: 0.35, band: "high", met: false }),
        check({ part: "testing", check: "prsWithTests", value: 0.45, band: "high", met: false, count: 9, total: 20 }),
      ]),
    ).map((f) => f.text);
    expect(texts).toEqual([
      "Test code is 0.35 of the size of source code",
      "45% of merged pull requests that changed source also changed tests (9 of 20)",
    ]);
  });

  it("names hygiene tools, and explains an editorconfig-only formatter", () => {
    const texts = findings(
      report(
        [
          check({ part: "hygiene", check: "linter", value: false, met: false, detail: [] }),
          check({ part: "hygiene", check: "formatter", value: false, met: false, detail: [] }),
          check({ part: "hygiene", check: "ciLinter", value: true, met: true, detail: ["eslint", "custom"] }),
          check({ part: "hygiene", check: "ciFormat", value: true, met: true, detail: ["prettier"] }),
        ],
        { hygiene: { onlyEditorconfig: true } as CodeHealthReport["hygiene"] },
      ),
    ).map((f) => f.text);
    expect(texts).toEqual([
      "No linter is configured",
      "No formatter is configured, because an editorconfig file only guides editors",
      "The linter runs in CI (ESLint, custom)",
      "Formatting is checked in CI with Prettier",
    ]);
  });

  it("says a formatter is configured, or missing with no editorconfig", () => {
    const texts = findings(
      report([
        check({ part: "hygiene", check: "formatter", value: true, met: true, detail: ["prettier"] }),
        check({ part: "hygiene", check: "ciFormat", value: false, met: false, detail: [] }),
      ]),
    ).map((f) => f.text);
    expect(texts).toEqual(["A formatter is configured (Prettier)", "CI does not check formatting"]);
    const [missing] = findings(report([check({ part: "hygiene", check: "formatter", value: false, met: false })]));
    expect(missing!.text).toBe("No formatter is configured");
  });
});

describe("verdict", () => {
  const limited = report(
    [check({ part: "testing", check: "prsWithTests", value: 0.18, band: "low", met: false, count: 9, total: 50, limits: true })],
    { grade: { ...grade({ testing: "low" })!, overall: { part: "testing", band: "low", check: "prsWithTests", reason: "" } } },
  );

  it("names the lowest part and its limiting check without 'Only'", () => {
    expect(verdictSentence(limited)).toBe(
      "Testing is the lowest part. 18% of merged pull requests changed tests alongside code (9 of 50).",
    );
    expect(limitingSentence(limited, "testing")).toBe("18% of merged pull requests changed tests alongside code (9 of 50)");
  });

  it("says every check passes when nothing limits the part", () => {
    const all = report([check({ part: "maintainability", check: "manyParams", value: 0, band: "elite" })], { grade: grade() });
    expect(limitingSentence(all, "maintainability")).toBeNull();
    expect(verdictSentence(all)).toBe("All checks pass in every part.");
  });

  it("has no sentence without a grade", () => {
    expect(verdictSentence(report([]))).toBeNull();
  });
});

describe("helpers", () => {
  it("finds a check by name", () => {
    const r = report([check({ part: "testing", check: "ciRunsTests", value: true })]);
    expect(checkOf(r, "ciRunsTests")?.value).toBe(true);
    expect(checkOf(r, "linter")).toBeUndefined();
  });

  it("formats a share to one decimal and names known tools", () => {
    expect(shareLabel(0.0625)).toBe("6.3%");
    expect(toolName("eslint")).toBe("ESLint");
    expect(toolName("mystery")).toBe("mystery");
  });
});
