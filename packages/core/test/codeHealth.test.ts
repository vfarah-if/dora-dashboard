import { describe, expect, it } from "vitest";
import { codeHealth, type CodeSnapshot, type FunctionMetrics } from "../src/codeHealth.js";

const fn = (name: string, file: string, ccn: number, nloc: number, language = "TypeScript"): FunctionMetrics => ({
  file,
  language,
  name,
  startLine: 1,
  ccn,
  nloc,
  params: 1,
});

const snapshot = (functions: FunctionMetrics[]): CodeSnapshot => ({
  commitSha: "abc123",
  analysedAt: "2026-09-29T10:00:00Z",
  functions,
});

// Sorted CCNs: 2, 4, 10, 10, 11, 20, 21, 60 (eight functions, 262 lines in all).
const sample = snapshot([
  fn("f1", "a.ts", 2, 5),
  fn("f2", "a.ts", 4, 10),
  fn("f3", "b.ts", 10, 20),
  fn("f4", "b.ts", 11, 30),
  fn("f5", "c.py", 20, 40, "Python"),
  fn("f6", "c.py", 21, 50, "Python"),
  fn("f7", "c.py", 60, 100, "Python"),
  fn("f8", "d.ts", 10, 7),
]);

describe("codeHealth", () => {
  const report = codeHealth(sample);

  it("carries the commit and time of the snapshot", () => {
    expect(report).toMatchObject({ status: "ok", commitSha: "abc123", analysedAt: "2026-09-29T10:00:00Z" });
  });

  it("counts functions and lines", () => {
    expect(report.functions).toBe(8);
    expect(report.nloc).toBe(262);
  });

  it("summarises CCN", () => {
    // mean 138 / 8 = 17.25; median is the midpoint of 10 and 11; p75 sits a quarter of the way from 20 to 21.
    expect(report.ccn).toEqual({ mean: 17.25, median: 10.5, p75: 20.25, max: 60 });
  });

  it("measures the share above each threshold as strictly greater", () => {
    expect(report.shareAboveWarn).toBe(0.5); // 11, 20, 21, 60
    expect(report.shareAboveHigh).toBe(0.25); // 21, 60
  });

  it("honours custom thresholds", () => {
    const custom = codeHealth(sample, [], {}, { warn: 4, high: 10 });
    expect(custom.shareAboveWarn).toBe(0.75); // everything but 2 and 4
    expect(custom.shareAboveHigh).toBe(0.5);
  });

  it("buckets the distribution with inclusive edges", () => {
    expect(report.distribution).toEqual([
      { label: "1 to 5", min: 1, max: 5, count: 2 },
      { label: "6 to 10", min: 6, max: 10, count: 2 },
      { label: "11 to 20", min: 11, max: 20, count: 2 },
      { label: "21 to 50", min: 21, max: 50, count: 1 },
      { label: "Over 50", min: 51, max: null, count: 1 },
    ]);
  });

  it("breaks down by language, most functions first", () => {
    expect(report.languages).toEqual([
      { language: "TypeScript", functions: 5, nloc: 72, meanCcn: 7.4 }, // (2+4+10+11+10) / 5
      { language: "Python", functions: 3, nloc: 190, meanCcn: 101 / 3 },
    ]);
  });

  it("lists hotspots by CCN, then size", () => {
    expect(report.hotspots.map((h) => h.name)).toEqual(["f7", "f6", "f5", "f4", "f3", "f8", "f2", "f1"]);
  });

  it("keeps only the ten worst hotspots, breaking full ties by file then name", () => {
    const many = Array.from({ length: 12 }, (_, i) => fn(`n${String(i).padStart(2, "0")}`, i % 2 ? "z.ts" : "y.ts", 7, 9));
    const names = codeHealth(snapshot(many)).hotspots.map((h) => `${h.file}:${h.name}`);
    expect(names).toHaveLength(10);
    expect(names.slice(0, 3)).toEqual(["y.ts:n00", "y.ts:n02", "y.ts:n04"]);
  });

  it("returns zeros rather than NaN when there are no functions", () => {
    const empty = codeHealth(snapshot([]));
    expect(empty).toMatchObject({
      functions: 0,
      nloc: 0,
      ccn: { mean: 0, median: 0, p75: 0, max: 0 },
      shareAboveWarn: 0,
      shareAboveHigh: 0,
      languages: [],
      hotspots: [],
    });
    expect(empty.distribution.every((b) => b.count === 0)).toBe(true);
  });

  it("copes with hundreds of thousands of functions", () => {
    const many = Array.from({ length: 200_000 }, (_, i) => fn(`f${i}`, "big.ts", (i % 40) + 1, 1));
    const big = codeHealth(snapshot(many));
    expect(big.functions).toBe(200_000);
    expect(big.ccn.max).toBe(40);
  });
});

import { CODE_SNAPSHOT_VERSION, prsWithTests } from "../src/codeHealth.js";
import type { ToolingFacts } from "../src/codeTooling.js";
import type { PullRequest } from "../src/types.js";

const pr = (
  number: number,
  mergedAt: string | null,
  files: string[] | undefined,
  overrides: Partial<PullRequest> = {},
): PullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://example.test/acme/widgets/pull/${number}`,
  author: "alice",
  authorIsBot: false,
  state: "MERGED",
  createdAt: "2026-08-01T00:00:00Z",
  publishedAt: "2026-08-01T00:00:00Z",
  mergedAt,
  closedAt: mergedAt,
  updatedAt: mergedAt ?? "2026-08-01T00:00:00Z",
  mergedBy: "alice",
  additions: 1,
  deletions: 1,
  firstCommitAt: null,
  baseRef: "main",
  reviews: [],
  ...(files ? { files } : {}),
  ...overrides,
});

describe("prsWithTests", () => {
  const range = { from: "2026-09-01", to: "2026-09-30" };
  const prs = [
    pr(1, "2026-09-05T10:00:00Z", ["src/a.ts", "src/a.test.ts"]), // counts, with tests
    pr(2, "2026-09-06T10:00:00Z", ["src/b.ts"]), // counts, without tests
    pr(3, "2026-09-07T10:00:00Z", ["README.md"]), // no source file
    pr(4, "2026-08-01T10:00:00Z", ["src/c.ts"]), // before the range
    pr(5, "2026-09-08T10:00:00Z", undefined), // no file data
    pr(6, "2026-09-08T10:00:00Z", ["src/d.ts"], { author: "dependabot[bot]", authorIsBot: true }), // a bot
    pr(7, "2026-09-30T20:00:00Z", ["src/z.ts", "tests/z.py"]), // last day, counts, with tests
    pr(8, "2026-10-01T00:00:00Z", ["src/e.ts"]), // after the range
    pr(9, "2026-09-10T10:00:00Z", ["src/q.test.ts"]), // only tests, so not source-changing
    pr(10, null, ["src/f.ts"]), // never merged
  ];

  it("counts merged source-changing pull requests in the range and how many touch tests", () => {
    expect(prsWithTests(prs, range)).toEqual({ share: 2 / 3, withTests: 2, total: 3 });
  });

  it("uses every merged pull request when no range is given", () => {
    // Adds PR 4 (source only), PR 8 (source only): 2 of 5.
    expect(prsWithTests(prs)).toEqual({ share: 2 / 5, withTests: 2, total: 5 });
  });

  it("is null when no pull request has file data", () => {
    expect(prsWithTests([pr(1, "2026-09-05T10:00:00Z", undefined)], range)).toBeNull();
    expect(prsWithTests([], range)).toBeNull();
  });
});

describe("codeHealth grading", () => {
  const p = (name: string, file: string, ccn: number, nloc: number, params: number): FunctionMetrics => ({
    file,
    language: "TypeScript",
    name,
    startLine: 1,
    ccn,
    nloc,
    params,
  });
  const tooling: ToolingFacts = {
    linters: [],
    formatters: ["prettier"],
    weakFormatters: [],
    ciLinters: [],
    ciFormatChecks: ["prettier"],
    ciRunsTests: true,
    coverageFloor: 80,
  };
  const graded: CodeSnapshot = {
    commitSha: "abc123",
    analysedAt: "2026-09-29T10:00:00Z",
    snapshotVersion: CODE_SNAPSHOT_VERSION,
    tooling,
    functions: [
      p("s1", "src/a.ts", 25, 10, 1),
      p("s2", "src/a.ts", 12, 90, 6), // long, and many parameters
      p("s3", "src/b.ts", 3, 100, 0), // long
      p("t1", "src/a.test.ts", 40, 100, 9),
      p("t2", "tests/helper.ts", 2, 20, 0),
    ],
  };
  const prs = [
    pr(1, "2026-09-05T10:00:00Z", ["src/a.ts", "src/a.test.ts"]),
    pr(2, "2026-09-06T10:00:00Z", ["src/b.ts", "tests/b.ts"]),
  ];
  const report = codeHealth(graded, prs, { from: "2026-09-01", to: "2026-09-30" });

  it("leaves test functions out of the source figures and counts them apart", () => {
    expect(report.functions).toBe(3);
    expect(report.nloc).toBe(200); // 10 + 90 + 100
    expect(report.tests).toEqual({ functions: 2, nloc: 120 });
    expect(report.hotspots.map((h) => h.name)).toEqual(["s1", "s2", "s3"]);
    expect(report.mostComplex?.name).toBe("s1");
    expect(report.languages).toEqual([{ language: "TypeScript", functions: 3, nloc: 200, meanCcn: 40 / 3 }]);
  });

  it("counts functions above each threshold", () => {
    expect(report.countAboveWarn).toBe(2); // 25 and 12
    expect(report.countAboveHigh).toBe(1); // 25
    expect(report.shareAboveWarn).toBe(2 / 3);
    expect(report.shareAboveHigh).toBe(1 / 3);
    expect(report.ccn).toMatchObject({ median: 12, p75: 18.5, max: 25 }); // p75: 12 + 0.5 * (25 - 12)
  });

  it("measures the maintainability shares by lines and by count", () => {
    expect(report.maintainability).toEqual({
      linesAboveWarn: 0.5, // (10 + 90) / 200
      linesAboveHigh: 0.05, // 10 / 200
      longFunctions: 2 / 3, // s2 and s3 exceed 60 lines
      manyParams: 1 / 3, // s2 has 6 parameters
    });
  });

  it("measures testing", () => {
    expect(report.testing).toEqual({
      testRatio: 0.6, // 120 / 200
      prsWithTests: { share: 1, withTests: 2, total: 2 },
      ciRunsTests: true,
      coverageFloor: 80,
    });
  });

  it("grades each part and takes the lowest overall", () => {
    expect(report.grade?.maintainability).toEqual({
      band: "low",
      check: "linesAboveWarn",
      reason: "50.0% of source lines sit in functions with a complexity above 10",
    });
    expect(report.grade?.testing).toMatchObject({ band: "elite", check: "all" });
    expect(report.grade?.hygiene).toMatchObject({ band: "medium", check: "linter" }); // formatter and CI format check only
    expect(report.grade?.overall).toEqual({
      part: "maintainability",
      band: "low",
      check: "linesAboveWarn",
      reason: "Maintainability is the lowest part. 50.0% of source lines sit in functions with a complexity above 10",
    });
    expect(report.hygiene).toMatchObject({
      linterConfigured: false,
      formatterConfigured: true,
      ciRunsLinter: false,
      ciChecksFormat: true,
    });
  });

  it("gives no grade without tooling facts, but keeps the figures", () => {
    const old = codeHealth({ ...graded, tooling: undefined, snapshotVersion: undefined });

    expect(old.grade).toBeNull();
    expect(old.hygiene).toBeNull();
    expect(old.tooling).toBeNull();
    expect(old.testing).toMatchObject({ ciRunsTests: null, coverageFloor: null, testRatio: 0.6 });
    expect(old.functions).toBe(3);
  });

  it("gives no grade when there is no source function", () => {
    const onlyTests = codeHealth({ ...graded, functions: [p("t1", "src/a.test.ts", 4, 10, 1)] });

    expect(onlyTests.grade).toBeNull();
    expect(onlyTests.functions).toBe(0);
    expect(onlyTests.testing.testRatio).toBe(0);
    expect(onlyTests.mostComplex).toBeNull();
    expect(onlyTests.tests).toEqual({ functions: 1, nloc: 10 });
  });

  it("notes an editorconfig-only repository in the hygiene figures", () => {
    const weak = codeHealth({ ...graded, tooling: { ...tooling, formatters: [], weakFormatters: ["editorconfig"] } });

    expect(weak.hygiene?.onlyEditorconfig).toBe(true);
    expect(weak.hygiene?.formatterConfigured).toBe(false);
  });

  it("is on snapshot version 6", () => {
    expect(CODE_SNAPSHOT_VERSION).toBe(6);
  });
});

describe("prsWithTests boundaries", () => {
  const range = { from: "2026-09-01", to: "2026-09-30" };
  const at = (n: number, mergedAt: string, overrides: Partial<PullRequest> = {}) => pr(n, mergedAt, ["src/a.ts"], overrides);

  it("includes a merge at the start of the first day and at the last second of the last day", () => {
    expect(prsWithTests([at(1, "2026-09-01T00:00:00Z"), at(2, "2026-09-30T23:59:59Z")], range)).toMatchObject({ total: 2 });
  });

  it("excludes a merge one second before the range and one second after it", () => {
    expect(prsWithTests([at(1, "2026-08-31T23:59:59Z"), at(2, "2026-10-01T00:00:00Z")], range)).toBeNull();
  });

  it("leaves out a pull request whose file list was cut short whose listed files show no test, since a later file could be one", () => {
    const truncated = at(3, "2026-09-10T00:00:00Z", { filesTruncated: true });

    expect(prsWithTests([truncated], range)).toBeNull();
    expect(prsWithTests([truncated, at(4, "2026-09-11T00:00:00Z")], range)).toEqual({ share: 0, withTests: 0, total: 1 });
  });

  it("counts a pull request whose file list was cut short whose listed files already show source and tests", () => {
    const truncated = pr(3, "2026-09-10T00:00:00Z", ["src/a.ts", "src/a.test.ts"], { filesTruncated: true });

    // The files left off can add a test but cannot take one away, so this is 1 of 1 with tests.
    expect(prsWithTests([truncated], range)).toEqual({ share: 1, withTests: 1, total: 1 });
  });

  it("leaves out a pull request whose file list was cut short whose listed files show no source", () => {
    const truncated = pr(3, "2026-09-10T00:00:00Z", ["src/a.test.ts", "README.md"], { filesTruncated: true });

    expect(prsWithTests([truncated], range)).toBeNull();
  });
});

describe("grade bands at the exact limits, through real shares", () => {
  const tooling: ToolingFacts = {
    linters: ["eslint"],
    formatters: ["prettier"],
    weakFormatters: [],
    ciLinters: ["eslint"],
    ciFormatChecks: ["prettier"],
    ciRunsTests: true,
    coverageFloor: 80,
  };
  // 100 source lines in all: `complex` of them in one function with CCN 11, the rest in one-line functions.
  const gradeWith = (complex: number, testNloc = 50) =>
    codeHealth({
      commitSha: "c",
      analysedAt: "2026-09-29T10:00:00Z",
      tooling,
      functions: [
        ...(complex > 0 ? [fn("complex", "src/a.ts", 11, complex)] : []),
        ...Array.from({ length: 100 - complex }, (_, i) => fn(`simple${i}`, "src/b.ts", 1, 1)),
        fn("t", "src/a.test.ts", 1, testNloc),
      ],
    }).grade!;

  it.each([
    [4, "elite"],
    [5, "high"], // 5 / 100 = 5%
    [9, "high"],
    [10, "medium"], // 10%
    [19, "medium"],
    [20, "low"], // 20%
  ] as const)("puts %i of 100 lines in complex functions in the %s band", (complex, band) => {
    expect(gradeWith(complex).maintainability.band).toBe(band);
  });

  it.each([
    [9, "low"],
    [10, "medium"], // 10 / 100 = 0.1
    [29, "medium"],
    [30, "high"], // 0.3
    [49, "high"],
    [50, "elite"], // 0.5
  ] as const)("puts %i test lines against 100 source lines in the %s band", (testNloc, band) => {
    expect(gradeWith(0, testNloc).testing.band).toBe(band);
  });
});

describe("codeHealth checks", () => {
  const p = (name: string, file: string, ccn: number, nloc: number, params: number): FunctionMetrics => ({
    file,
    language: "TypeScript",
    name,
    startLine: 1,
    ccn,
    nloc,
    params,
  });
  const tooling: ToolingFacts = {
    linters: [],
    formatters: ["prettier"],
    weakFormatters: [],
    ciLinters: [],
    ciFormatChecks: ["prettier"],
    ciRunsTests: true,
    coverageFloor: 80,
  };
  const snapshot: CodeSnapshot = {
    commitSha: "abc123",
    analysedAt: "2026-09-29T10:00:00Z",
    tooling,
    functions: [
      p("s1", "src/a.ts", 25, 10, 1),
      p("s2", "src/a.ts", 12, 90, 6),
      p("s3", "src/b.ts", 3, 100, 0),
      p("t1", "src/a.test.ts", 40, 100, 9),
      p("t2", "tests/helper.ts", 2, 20, 0),
    ],
  };
  const prs = [
    pr(1, "2026-09-05T10:00:00Z", ["src/a.ts", "src/a.test.ts"]),
    pr(2, "2026-09-06T10:00:00Z", ["src/b.ts", "tests/b.ts"]),
  ];
  const report = codeHealth(snapshot, prs, { from: "2026-09-01", to: "2026-09-30" });
  const named = (r: typeof report, check: string) => r.checks.find((c) => c.check === check)!;

  it("lists the maintainability checks with bands, counts and the limiting check", () => {
    // Shares: 100/200 lines above 10, 10/200 above 20, 2 of 3 functions long, 1 of 3 with many parameters.
    expect(report.checks.filter((c) => c.part === "maintainability")).toEqual([
      { part: "maintainability", check: "linesAboveWarn", value: 0.5, band: "low", count: 2, limits: true },
      { part: "maintainability", check: "linesAboveHigh", value: 0.05, band: "medium", count: 1, limits: false },
      { part: "maintainability", check: "longFunctions", value: 2 / 3, band: "low", count: 2, limits: false },
      { part: "maintainability", check: "manyParams", value: 1 / 3, band: "low", count: 1, limits: false },
    ]);
  });

  it("lists the testing checks with what each allows", () => {
    expect(report.checks.filter((c) => c.part === "testing")).toEqual([
      { part: "testing", check: "testRatio", value: 0.6, band: "elite", met: true, limits: false },
      { part: "testing", check: "prsWithTests", value: 1, band: "elite", met: true, count: 2, total: 2, limits: false },
      { part: "testing", check: "ciRunsTests", value: true, band: "elite", met: true, limits: false },
      { part: "testing", check: "coverageFloor", value: 80, band: "elite", met: true, limits: false },
    ]);
  });

  it("lists the hygiene checks with their tools, and marks the first one missing", () => {
    expect(report.checks.filter((c) => c.part === "hygiene")).toEqual([
      { part: "hygiene", check: "linter", value: false, met: false, detail: [], limits: true },
      { part: "hygiene", check: "formatter", value: true, met: true, detail: ["prettier"], limits: false },
      { part: "hygiene", check: "ciLinter", value: false, met: false, detail: [], limits: false },
      { part: "hygiene", check: "ciFormat", value: true, met: true, detail: ["prettier"], limits: false },
    ]);
  });

  it("marks exactly one limiting check per part that is not elite", () => {
    expect(report.checks.filter((c) => c.limits).map((c) => `${c.part}:${c.check}`)).toEqual([
      "maintainability:linesAboveWarn",
      "hygiene:linter",
    ]);
  });

  it("flags a floor below 60 as not enough for elite, and still reports it", () => {
    const weak = codeHealth({ ...snapshot, tooling: { ...tooling, coverageFloor: 59 } }, prs);

    expect(named(weak, "coverageFloor")).toMatchObject({ value: 59, band: "high", met: false, limits: true });
    expect(weak.grade?.testing).toEqual({
      band: "high",
      check: "coverageFloor",
      reason: "The coverage floor is 59%, and Elite needs at least 60%",
    });
    expect(codeHealth({ ...snapshot, tooling: { ...tooling, coverageFloor: 60 } }, prs).grade?.testing.band).toBe("elite");
    expect(weak.testing.coverageFloor).toBe(59);
  });

  it("leaves out the tooling checks, and the grade, when the tooling is unknown", () => {
    const unknown = codeHealth({ ...snapshot, tooling: undefined }, prs);

    expect(unknown.grade).toBeNull();
    expect(unknown.checks.map((c) => c.check)).toEqual([
      "linesAboveWarn",
      "linesAboveHigh",
      "longFunctions",
      "manyParams",
      "testRatio",
      "prsWithTests",
    ]);
    expect(unknown.checks.some((c) => c.limits)).toBe(false);
  });

  it("has no checks when there is no source function", () => {
    expect(codeHealth({ ...snapshot, functions: [p("t", "a.test.ts", 1, 1, 0)] }).checks).toEqual([]);
  });

  it("gives the band of a prsWithTests check as absent when no pull request has file data", () => {
    const none = codeHealth(snapshot, []);

    expect(named(none, "prsWithTests")).toEqual({ part: "testing", check: "prsWithTests", value: null, limits: false });
    expect(none.grade?.testing.band).toBe("elite");
  });

  it("names the source function with the most lines, breaking ties by complexity", () => {
    expect(report.longestFunction).toMatchObject({ name: "s3", nloc: 100 });
    const tie = codeHealth({
      ...snapshot,
      functions: [p("low", "src/x.ts", 2, 50, 0), p("high", "src/y.ts", 9, 50, 0), p("test", "a.test.ts", 1, 500, 0)],
    });

    expect(tie.longestFunction?.name).toBe("high");
    expect(codeHealth({ ...snapshot, functions: [] }).longestFunction).toBeNull();
  });
});

describe("prsWithTests and tool configuration", () => {
  const range = { from: "2026-09-01", to: "2026-09-30" };
  const merged = (n: number, files: string[]) => pr(n, "2026-09-10T00:00:00Z", files);

  it("does not count a pull request that changes only a tool's configuration as changing source", () => {
    const prs = [merged(1, [".ncurc.mjs"]), merged(2, ["vite.config.ts", "README.md"]), merged(3, ["apps/web/eslint.config.js"])];

    expect(prsWithTests(prs, range)).toBeNull();
  });

  it("still judges the source changed beside a configuration file", () => {
    // PR 1 changes source without tests and PR 2 source with tests, whatever else they change: 1 of 2.
    const prs = [merged(1, [".ncurc.mjs", "src/a.ts"]), merged(2, ["vite.config.ts", "src/b.ts", "src/b.test.ts"])];

    expect(prsWithTests(prs, range)).toEqual({ share: 0.5, withTests: 1, total: 2 });
  });

  it("needs source beyond configuration before a pull request whose file list was cut short can count", () => {
    const cut = (n: number, files: string[]) => pr(n, "2026-09-10T00:00:00Z", files, { filesTruncated: true });

    // PR 1 shows only configuration and a test, so it is left out; PR 2 also shows source, so it counts with tests.
    const prs = [cut(1, [".ncurc.mjs", "src/a.test.ts"]), cut(2, [".ncurc.mjs", "src/b.ts", "src/b.test.ts"])];

    expect(prsWithTests(prs, range)).toEqual({ share: 1, withTests: 1, total: 1 });
  });

  it("keeps a module that is merely named config as source", () => {
    expect(prsWithTests([merged(1, ["src/core/config.ts"])], range)).toEqual({ share: 0, withTests: 0, total: 1 });
  });
});
