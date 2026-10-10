import { describe, expect, it } from "vitest";
import {
  CODE_DETAIL_CAPS,
  codeDetail as detailOf,
  prepareCodeDetail,
  type CodeDetailOptions,
  type CoverageSnapshots,
} from "../src/codeDetail.js";
import type { CodeHealthThresholds } from "../src/codeHealth.js";
import {
  COVERAGE_SNAPSHOT_VERSION,
  type CoverageFileReport,
  type CoverageRead,
  type CoverageReadFailure,
} from "../src/codeCoverage.js";
import { codeHealth, type CodeSnapshot, type FunctionMetrics } from "../src/codeHealth.js";

const fn = (
  file: string,
  name: string,
  ccn: number,
  nloc: number,
  startLine: number,
  endLine: number | undefined,
  language = "TypeScript",
): FunctionMetrics => ({ file, language, name, startLine, ...(endLine === undefined ? {} : { endLine }), ccn, nloc, params: 1 });

const functions = [
  fn("apps/api/src/a.ts", "a1", 12, 8, 1, 10),
  fn("apps/api/src/a.ts", "a2", 2, 4, 20, 25),
  fn("apps/api/src/b.ts", "b1", 1, 3, 1, 5),
  fn("apps/api/src/extra.ts", "e1", 2, 3, 1, 4),
  fn("apps/api/test/a.test.ts", "t1", 1, 6, 1, 8),
  fn("apps/web/src/w.ts", "w1", 25, 20, 1, 30),
  fn("packages/core/src/c.ts", "c1", 3, 5, 1, 4),
  fn("packages/core/src/p.py", "p1", 1, 2, 1, 3, "Python"),
];

const snapshot: CodeSnapshot = {
  commitSha: "abc123",
  analysedAt: "2026-10-01T10:00:00Z",
  functions,
  partlyMeasured: ["apps/web/src/odd.ts", "apps/api/src/odd.ts"],
  snapshotVersion: 6,
  files: [
    "apps/api/src/a.ts",
    "apps/api/src/b.ts",
    "apps/api/src/extra.ts",
    "apps/api/test/a.test.ts",
    "apps/web/src/w.ts",
    "packages/core/src/c.ts",
    "packages/core/src/p.py",
    "scripts/build.js",
  ],
  layout: {
    manifests: ["package.json", "apps/api/package.json", "apps/web/package.json", "packages/core/package.json"],
    workspaces: ["apps/*", "packages/*"],
  },
};

const lcov = (files: CoverageFileReport[], extra: Partial<CoverageRead> = {}): CoverageRead => ({
  fetchedAt: "2026-10-01T11:00:00Z",
  version: COVERAGE_SNAPSHOT_VERSION,
  artefacts: [{ id: 1, name: "coverage", sizeBytes: 10, createdAt: "2026-10-01T10:30:00Z", runId: 9, commitSha: "abc123" }],
  artefactsInRun: 1,
  runId: 9,
  commitSha: "abc123",
  reports: [{ format: "lcov", artefact: "coverage", dir: "coverage", files }],
  unreadableFiles: 0,
  error: null,
  ...extra,
});

const failure = (error: string, extra: Partial<CoverageReadFailure> = {}): CoverageReadFailure => ({
  fetchedAt: "2026-10-02T00:00:00Z",
  version: COVERAGE_SNAPSHOT_VERSION,
  artefacts: [],
  runId: null,
  commitSha: null,
  reports: [],
  error,
  ...extra,
});

/** A file report whose counts come from its ranges, as a parser builds it. */
const ranged = (path: string, covered: [number, number][], uncovered: [number, number][]): CoverageFileReport => {
  const lines = (ranges: [number, number][]) => ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
  return {
    path,
    lines: { covered: lines(covered), total: lines(covered) + lines(uncovered) },
    ranges: { covered, uncovered },
  };
};

const covered: CoverageRead = lcov([
  ranged("apps/api/src/a.ts", [[20, 25]], [[2, 9]]),
  { ...ranged("apps/api/src/b.ts", [[1, 5]], []), branches: { covered: 1, total: 2 } },
  { path: "packages/core/src/c.ts", lines: { covered: 4, total: 4 } },
  { path: "/home/runner/secret-client/x/ghost.ts", lines: { covered: 0, total: 9 } },
]);

/** Prepares and asks in one step; the tests of the two halves together. */
const codeDetail = (
  snap: CodeSnapshot,
  coverage: CoverageSnapshots,
  options: CodeDetailOptions & { thresholds?: CodeHealthThresholds } = {},
) => detailOf(prepareCodeDetail(snap, coverage, options.thresholds), options);

const none: CoverageSnapshots = { latest: null, good: null };
const withCoverage: CoverageSnapshots = { latest: covered, good: covered };

const okView = (report: ReturnType<typeof codeDetail>) => {
  if (report.coverage.status !== "ok") throw new Error(`expected ok coverage, got ${report.coverage.status}`);
  return report.coverage;
};

describe("codeDetail areas", () => {
  const report = codeDetail(snapshot, none);

  it("finds the workspaces and the folders left over, largest first", () => {
    expect(report.mode).toBe("workspace");
    expect(report.areas.items.map((a) => [a.path, a.kind])).toEqual([
      ["apps/web", "workspace"],
      ["apps/api", "workspace"],
      ["packages/core", "workspace"],
      ["scripts", "folder"],
    ]);
    expect(report.areas.total).toBe(4);
  });

  it("summarises one area from its own functions", () => {
    // apps/api source: a1 (CCN 12, 8 lines), a2 (2, 4), b1 (1, 3), e1 (2, 3), so 18 lines and a mean CCN of 17 / 4.
    const api = report.areas.items.find((a) => a.path === "apps/api")!;
    expect(api).toMatchObject({
      files: 3,
      functions: 4,
      nloc: 18,
      countAboveWarn: 1,
      countAboveHigh: 0,
      testFunctions: 1,
      testNloc: 6,
    });
    expect(api.meanCcn).toBeCloseTo(4.25);
    // Only a1 is above the warning limit, so its 8 lines.
    expect(api.nlocAboveWarn).toBe(8);
    expect(api.maintainabilityBand).toBe("low");
  });

  it("gives a clean area an elite band and an area with no functions none", () => {
    expect(report.areas.items.find((a) => a.path === "packages/core")?.maintainabilityBand).toBe("elite");
    expect(report.areas.items.find((a) => a.path === "scripts")).toMatchObject({
      files: 1,
      functions: 0,
      maintainabilityBand: null,
    });
  });

  it("counts a function above both thresholds in both counts", () => {
    expect(report.areas.items.find((a) => a.path === "apps/web")).toMatchObject({ countAboveWarn: 1, countAboveHigh: 1 });
  });

  it("uses the thresholds it is given", () => {
    const strict = codeDetail(snapshot, none, { thresholds: { warn: 2, high: 5 } });
    expect(strict.thresholds).toEqual({ warn: 2, high: 5 });
    expect(strict.areas.items.find((a) => a.path === "apps/api")).toMatchObject({ countAboveWarn: 1, countAboveHigh: 1 });
  });

  it("carries the commit, the time and the last error", () => {
    const failure = { message: "boom", analysedAt: "2026-10-02T00:00:00Z", reason: "failed" as const };
    expect(codeDetail(snapshot, none, { lastError: failure })).toMatchObject({
      commitSha: "abc123",
      analysedAt: snapshot.analysedAt,
      lastError: failure,
    });
    expect(report).not.toHaveProperty("lastError");
  });

  it("caps the areas and says how many there were", () => {
    const many = Array.from({ length: CODE_DETAIL_CAPS.areas + 5 }, (_, i) => `pkg${String(i).padStart(4, "0")}`);
    const big: CodeSnapshot = {
      ...snapshot,
      functions: [],
      files: many.map((d) => `${d}/a.ts`),
      layout: { manifests: many.map((d) => `${d}/package.json`), workspaces: null },
    };
    const capped = codeDetail(big, none).areas;
    expect(capped.items).toHaveLength(CODE_DETAIL_CAPS.areas);
    expect(capped.total).toBe(CODE_DETAIL_CAPS.areas + 5);
  });
});

describe("codeDetail scope", () => {
  it("covers the whole repository by default, most complex function first", () => {
    const report = codeDetail(snapshot, none);
    expect(report.area).toBeNull();
    expect(report.scope.functions).toBe(7);
    expect(report.scope.tests).toEqual({ functions: 1, nloc: 6 });
    expect(report.functions.items.map((f) => f.name)).toEqual(["w1", "a1", "c1", "a2", "e1", "b1", "p1"]);
    expect(report.functions.items[0]).toMatchObject({ area: "apps/web", coverage: null });
  });

  it("narrows to a selected area, with its own partly measured files", () => {
    const report = codeDetail(snapshot, none, { area: "apps/api" });
    expect(report.area).toBe("apps/api");
    expect(report.scope).toMatchObject({ functions: 4, nloc: 18, partlyMeasured: ["apps/api/src/odd.ts"] });
    expect(report.functions.items.map((f) => f.name)).toEqual(["a1", "a2", "e1", "b1"]);
    // The area list is still the whole repository's.
    expect(report.areas.items).toHaveLength(4);
  });

  it("falls back to the whole repository for an unknown area, and says so", () => {
    const report = codeDetail(snapshot, none, { area: "apps/missing" });
    expect(report).toMatchObject({ area: null, missingArea: "apps/missing" });
    expect(report.scope.functions).toBe(7);
  });

  it("treats an empty area as none", () => {
    const report = codeDetail(snapshot, none, { area: "" });
    expect(report.area).toBeNull();
    expect(report).not.toHaveProperty("missingArea");
  });

  it("caps the function list", () => {
    const wide = Array.from({ length: CODE_DETAIL_CAPS.functions + 3 }, (_, i) =>
      fn("apps/api/src/a.ts", `f${i}`, 1, 1, i + 1, i + 1),
    );
    const report = codeDetail({ ...snapshot, functions: wide }, none);
    expect(report.functions.items).toHaveLength(CODE_DETAIL_CAPS.functions);
    expect(report.functions.total).toBe(CODE_DETAIL_CAPS.functions + 3);
  });
});

describe("codeDetail before snapshot version 6", () => {
  const old: CodeSnapshot = {
    commitSha: "abc123",
    analysedAt: "2026-09-01T00:00:00Z",
    functions: [
      fn("api/a.ts", "a", 1, 2, 1, undefined),
      fn("web/w.ts", "w", 1, 2, 1, undefined),
      fn("core/c.ts", "c", 1, 2, 1, undefined),
    ],
    partlyMeasured: ["web/odd.ts"],
  };

  it("guesses areas from the function paths and says the mode is unknown", () => {
    const report = codeDetail(old, none);
    expect(report.mode).toBe("unknown");
    expect(report.areas.items.map((a) => a.path).sort()).toEqual(["api", "core", "web"]);
  });

  it("still scopes to an area", () => {
    expect(codeDetail(old, none, { area: "web" }).scope.functions).toBe(1);
  });

  it("does not trust a layout that arrived without a file list", () => {
    expect(codeDetail({ ...old, layout: snapshot.layout }, none).mode).toBe("unknown");
  });
});

describe("codeDetail coverage", () => {
  it("is none when nothing was ever read", () => {
    expect(codeDetail(snapshot, none).coverage).toEqual({ status: "none" });
  });

  it("is an error when the newest read failed and none ever succeeded", () => {
    const failed = failure("No artefact");
    expect(codeDetail(snapshot, { latest: failed, good: null }).coverage).toEqual({
      status: "error",
      message: "No artefact",
      fetchedAt: failed.fetchedAt,
    });
  });

  it("shows nothing from a read stored in an older shape, which the next crawl reads again", () => {
    const old = { ...covered, version: COVERAGE_SNAPSHOT_VERSION - 1 };
    expect(codeDetail(snapshot, { latest: old, good: old }).coverage).toEqual({ status: "none" });
    expect(codeDetail(snapshot, { latest: old, good: old }).areas.items.every((a) => a.coverage === null)).toBe(true);
  });

  describe("with a report", () => {
    const view = okView(codeDetail(snapshot, withCoverage));

    it("names its source", () => {
      expect(view.source).toEqual({
        artefacts: ["coverage"],
        artefactsInRun: 1,
        runId: 9,
        commitSha: "abc123",
        fetchedAt: covered.fetchedAt,
        createdAt: "2026-10-01T10:30:00Z",
        formats: ["lcov"],
        unreadableFiles: 0,
      });
      expect(view.otherCommit).toBe(false);
      expect(view.lineDetail).toBe(true);
      expect(view.filesInScope).toBe(3);
    });

    it("totals lines, branches and functions over the matched files", () => {
      // a.ts 6 of 14, b.ts 5 of 5, c.ts 4 of 4, so 15 of 23. Only b.ts has branches, 1 of 2. None has functions.
      expect(view.lines).toMatchObject({ covered: 15, total: 23 });
      expect(view.lines!.share).toBeCloseTo(15 / 23);
      expect(view.branches).toMatchObject({ covered: 1, total: 2, share: 0.5 });
      expect(view.functions).toBeNull();
    });

    it("counts what matched, and what did not, without naming it", () => {
      expect(view.files).toEqual({ inReport: 4, matched: 3, unmatched: 1 });
      expect(JSON.stringify(codeDetail(snapshot, withCoverage))).not.toContain("secret-client");
    });

    it("lists files by their uncovered lines, with the ranges", () => {
      expect(view.leastCovered).toEqual({
        total: 1,
        items: [
          {
            path: "apps/api/src/a.ts",
            area: "apps/api",
            lines: { covered: 6, total: 14 },
            uncovered: { items: [[2, 9]], total: 1 },
          },
        ],
      });
    });

    it("caps the ranges of one file", () => {
      const ranges = Array.from({ length: 25 }, (_, i): [number, number] => [i * 3 + 1, i * 3 + 1]);
      const many = lcov([ranged("apps/api/src/a.ts", [], ranges)]);
      const result = okView(codeDetail(snapshot, { latest: many, good: many })).leastCovered.items[0]!;
      expect(result.uncovered!.items).toHaveLength(CODE_DETAIL_CAPS.rangesPerFile);
      expect(result.uncovered!.total).toBe(25);
    });

    it("gives no ranges for a file whose report has none", () => {
      const totals = lcov([{ path: "apps/api/src/a.ts", lines: { covered: 1, total: 4 } }]);
      expect(okView(codeDetail(snapshot, { latest: totals, good: totals })).leastCovered.items[0]!.uncovered).toBeNull();
    });

    it("orders files by uncovered lines, then by path", () => {
      const ordered = lcov([
        ranged("apps/api/src/b.ts", [[1, 1]], [[2, 3]]),
        ranged("apps/api/src/a.ts", [[1, 1]], [[2, 3]]),
        ranged("apps/api/src/extra.ts", [], [[1, 4]]),
      ]);
      const paths = okView(codeDetail(snapshot, { latest: ordered, good: ordered })).leastCovered.items.map((f) => f.path);
      expect(paths).toEqual(["apps/api/src/extra.ts", "apps/api/src/a.ts", "apps/api/src/b.ts"]);
    });

    it("lists source files with functions that the report misses, but only where it plainly covers that kind of code", () => {
      // extra.ts is TypeScript in apps/api, which the report covers. w.ts is in apps/web, which it does not touch.
      // p.py is Python in packages/core, where the report covers only TypeScript.
      expect(view.notInReport).toEqual({
        total: 1,
        items: [{ path: "apps/api/src/extra.ts", area: "apps/api", functions: 1, nloc: 3 }],
      });
      // w.ts and p.py are missing too, but are left off the list as kinds of code the report does not try to cover.
      expect(view.notInReportOtherKinds).toBe(2);
    });

    it("lists complex functions whose instrumented lines never ran", () => {
      // a1 (CCN 12) spans lines 1 to 10 and only lines 2 to 9 are instrumented, none run. w1 is not in the report.
      expect(view.untestedComplex.total).toBe(1);
      expect(view.untestedComplex.items[0]).toMatchObject({ name: "a1", coverage: 0, area: "apps/api" });
    });

    it("gives each function its coverage over its own lines", () => {
      const rows = codeDetail(snapshot, withCoverage).functions.items;
      // a2 spans 20 to 25, all run. b1 spans 1 to 5, all run. a1 never ran. w1 is not in the report.
      expect(rows.find((f) => f.name === "a2")?.coverage).toBe(1);
      expect(rows.find((f) => f.name === "b1")?.coverage).toBe(1);
      expect(rows.find((f) => f.name === "a1")?.coverage).toBe(0);
      expect(rows.find((f) => f.name === "w1")?.coverage).toBeNull();
      // c1 is in the report with totals only, so there is no line detail to read.
      expect(rows.find((f) => f.name === "c1")?.coverage).toBeNull();
    });

    it("leaves coverage unknown for a function with no end line", () => {
      const old = { ...snapshot, functions: functions.map(({ endLine: _end, ...rest }) => rest) };
      const report = codeDetail(old, withCoverage);
      expect(report.functions.items.every((f) => f.coverage === null)).toBe(true);
      expect(okView(report).untestedComplex.total).toBe(0);
    });

    it("puts each area's coverage in its summary", () => {
      const areas = codeDetail(snapshot, withCoverage).areas.items;
      expect(areas.find((a) => a.path === "apps/api")?.coverage).toBeCloseTo(11 / 19);
      expect(areas.find((a) => a.path === "packages/core")?.coverage).toBe(1);
      expect(areas.find((a) => a.path === "apps/web")?.coverage).toBeNull();
    });

    it("scopes the shares and lists to the selected area, and keeps line detail a property of the whole report", () => {
      const core = okView(codeDetail(snapshot, withCoverage, { area: "packages/core" }));
      expect(core.lines).toMatchObject({ covered: 4, total: 4, share: 1 });
      expect(core.branches).toBeNull();
      expect(core.leastCovered.total).toBe(0);
      expect(core.notInReport.total).toBe(0);
      // p.py is the only Python file, so the report plainly does not try to cover it.
      expect(core.notInReportOtherKinds).toBe(1);
      expect(core.filesInScope).toBe(1);
      // c.ts has totals only, but the report itself carries line ranges for other files.
      expect(core.lineDetail).toBe(true);
      expect(core.files).toEqual({ inReport: 4, matched: 3, unmatched: 1 });
    });

    it("says when the report does not reach the selected area, so empty lists are not read as good news", () => {
      const web = okView(codeDetail(snapshot, withCoverage, { area: "apps/web" }));
      expect(web.filesInScope).toBe(0);
      expect(web.lines).toBeNull();
      expect(web.untestedComplex.total).toBe(0);
      // w.ts has a function of CCN 25 and is absent from the report, but nothing in apps/web was matched.
      expect(web.notInReport.total).toBe(0);
      expect(web.notInReportOtherKinds).toBe(1);
    });
  });

  describe("coverage of a function over its own lines", () => {
    const rowsFor = (...files: CoverageFileReport[]) => {
      const read = lcov(files);
      const report = codeDetail(snapshot, { latest: read, good: read });
      return { rows: report.functions.items, view: okView(report) };
    };

    it("counts the lines of its range that ran over the lines of its range that are instrumented", () => {
      // a1 spans lines 1 to 10: lines 1 to 3 ran and 4 to 10 did not, so 3 of 10.
      const { rows, view } = rowsFor(ranged("apps/api/src/a.ts", [[1, 3]], [[4, 10]]));
      expect(rows.find((f) => f.name === "a1")?.coverage).toBeCloseTo(0.3);
      // a1 is complex but partly run, so it is not among the functions with no coverage.
      expect(view.untestedComplex.total).toBe(0);
    });

    it("counts only the part of a range inside the function", () => {
      // b1 spans 1 to 5. Lines 4 to 8 ran, of which 4 and 5 are inside; lines 1 to 3 did not. So 2 of 5.
      const { rows } = rowsFor(ranged("apps/api/src/b.ts", [[4, 8]], [[1, 3]]));
      expect(rows.find((f) => f.name === "b1")?.coverage).toBeCloseTo(0.4);
    });

    it("counts a single-line range as one line", () => {
      // a1 spans 1 to 10 and only line 5 ran, so 1 of 10.
      const { rows } = rowsFor(
        ranged(
          "apps/api/src/a.ts",
          [[5, 5]],
          [
            [1, 4],
            [6, 10],
          ],
        ),
      );
      expect(rows.find((f) => f.name === "a1")?.coverage).toBeCloseTo(0.1);
    });

    it("is unknown for a function none of whose lines is instrumented", () => {
      // a2 spans 20 to 25, and the report instruments lines 1 to 10 only.
      const { rows } = rowsFor(ranged("apps/api/src/a.ts", [[1, 10]], []));
      expect(rows.find((f) => f.name === "a2")?.coverage).toBeNull();
    });
  });

  describe("files that instrument no line", () => {
    const empty = lcov([{ path: "packages/core/src/c.ts", lines: { covered: 0, total: 0 } }]);
    const both = { latest: empty, good: empty };

    it("give no share rather than 0%, for the area and for the scope", () => {
      expect(codeDetail(snapshot, both).areas.items.find((a) => a.path === "packages/core")?.coverage).toBeNull();
      const core = okView(codeDetail(snapshot, both, { area: "packages/core" }));
      expect(core.lines).toBeNull();
      expect(core.filesInScope).toBe(1);
    });
  });

  it("caps the least covered, the missing and the untested lists, and still counts them all", () => {
    // 306 files in one folder, each with one function of CCN 20 on line 1. The report covers the first 103, none of
    // whose lines ran, so 103 are least covered and untested, and the other 203 are missing from the report.
    const paths = Array.from({ length: 306 }, (_, i) => `lib/f${String(i).padStart(3, "0")}.ts`);
    const big: CodeSnapshot = {
      ...snapshot,
      functions: paths.map((path) => fn(path, "f", 20, 1, 1, 1)),
      files: paths,
      layout: { manifests: [], workspaces: null },
      partlyMeasured: [],
    };
    const read = lcov(paths.slice(0, 103).map((path) => ranged(path, [], [[1, 1]])));
    const view = okView(codeDetail(big, { latest: read, good: read }));
    expect([view.leastCovered.items.length, view.leastCovered.total]).toEqual([CODE_DETAIL_CAPS.leastCovered, 103]);
    expect([view.untestedComplex.items.length, view.untestedComplex.total]).toEqual([CODE_DETAIL_CAPS.untestedComplex, 103]);
    expect([view.notInReport.items.length, view.notInReport.total]).toEqual([CODE_DETAIL_CAPS.notInReport, 203]);
  });

  it("says when the coverage was measured on another commit", () => {
    const other = { ...covered, commitSha: "zzz999" };
    expect(okView(codeDetail(snapshot, { latest: other, good: other })).otherCommit).toBe(true);
  });

  it("keeps the last good figures and shows the newer failure", () => {
    const failed = failure("Artefact expired");
    const view = okView(codeDetail(snapshot, { latest: failed, good: covered }));
    expect(view.lastError).toEqual({ message: "Artefact expired", fetchedAt: "2026-10-02T00:00:00Z" });
    expect(view.lines).toMatchObject({ covered: 15, total: 23 });
  });

  it("lists the formats and artefacts of every report", () => {
    const two = lcov([{ path: "apps/api/src/b.ts", lines: { covered: 1, total: 1 } }], {
      reports: [
        {
          format: "lcov",
          artefact: "coverage-api",
          dir: "a",
          files: [{ path: "apps/api/src/b.ts", lines: { covered: 1, total: 1 } }],
        },
        {
          format: "cobertura",
          artefact: "coverage-web",
          dir: "b",
          files: [{ path: "apps/web/src/w.ts", lines: { covered: 1, total: 2 } }],
        },
      ],
      artefacts: [
        { id: 1, name: "coverage-api", sizeBytes: 1, createdAt: "2026-10-01T10:00:00Z", runId: 9, commitSha: "abc123" },
        { id: 2, name: "coverage-web", sizeBytes: 1, createdAt: "2026-10-01T10:00:00Z", runId: 9, commitSha: "abc123" },
      ],
      artefactsInRun: 2,
    });
    expect(okView(codeDetail(snapshot, { latest: two, good: two })).source).toMatchObject({
      artefacts: ["coverage-api", "coverage-web"],
      formats: ["lcov", "cobertura"],
    });
  });
});

describe("coverage never changes a grade", () => {
  const withTooling: CodeSnapshot = {
    ...snapshot,
    tooling: {
      linters: ["eslint"],
      formatters: ["prettier"],
      weakFormatters: [],
      ciLinters: ["eslint"],
      ciFormatChecks: ["prettier"],
      ciRunsTests: true,
      coverageFloor: 80,
    },
  };

  it("leaves the code health report identical whatever coverage is stored", () => {
    const before = codeHealth(withTooling);
    codeDetail(withTooling, withCoverage);
    codeDetail(withTooling, none);
    expect(codeHealth(withTooling)).toEqual(before);
  });

  it("gives the same scope and bands with coverage as without", () => {
    const bare = codeDetail(withTooling, none);
    const full = codeDetail(withTooling, withCoverage);
    expect(full.scope).toEqual(bare.scope);
    expect(full.areas.items.map((a) => [a.path, a.maintainabilityBand, a.nlocAboveWarn])).toEqual(
      bare.areas.items.map((a) => [a.path, a.maintainabilityBand, a.nlocAboveWarn]),
    );
    expect(full.functions.items.map((f) => f.name)).toEqual(bare.functions.items.map((f) => f.name));
  });

  it("carries no overall grade on an area", () => {
    for (const area of codeDetail(withTooling, withCoverage).areas.items) expect(area).not.toHaveProperty("grade");
  });
});

describe("prepareCodeDetail", () => {
  it("answers any area from one preparation, the same as preparing for each", () => {
    const prepared = prepareCodeDetail(snapshot, withCoverage);
    for (const area of ["apps/api", "packages/core", null]) {
      expect(detailOf(prepared, { area })).toEqual(codeDetail(snapshot, withCoverage, { area }));
    }
  });

  it("counts the lines above a stricter warning limit in nlocAboveWarn", () => {
    // With a limit of 2, packages/core has c1 (CCN 3, 5 lines) above it and p1 (CCN 1) not.
    const strict = prepareCodeDetail(snapshot, none, { warn: 2, high: 5 });
    expect(strict.areas.items.find((a) => a.path === "packages/core")!.nlocAboveWarn).toBe(5);
  });

  it("is zero for an area with no function above the limit", () => {
    expect(codeDetail(snapshot, none).areas.items.find((a) => a.path === "scripts")!.nlocAboveWarn).toBe(0);
  });

  it("dates the coverage by its newest artefact", () => {
    const older = { id: 2, name: "coverage-web", sizeBytes: 1, createdAt: "2026-09-01T00:00:00Z", runId: 9, commitSha: "abc123" };
    const two = lcov(covered.reports[0]!.files, { artefacts: [older, covered.artefacts[0]!] });
    expect(okView(codeDetail(snapshot, { latest: two, good: two })).source.createdAt).toBe("2026-10-01T10:30:00Z");
  });

  it("says how many artefacts the run had and how many coverage files could not be read", () => {
    const partial = lcov(covered.reports[0]!.files, { artefactsInRun: 8, unreadableFiles: 2 });
    expect(okView(codeDetail(snapshot, { latest: partial, good: partial })).source).toMatchObject({
      artefacts: ["coverage"],
      artefactsInRun: 8,
      unreadableFiles: 2,
    });
  });

  it("gives an area with no source function, and so a scope with none, no maintainability band", () => {
    expect(codeDetail(snapshot, none, { area: "scripts" }).scope.maintainabilityBand).toBeNull();
  });

  it("keeps the most complex functions when it caps the list, and still counts them all", () => {
    // 600 functions in one file, CCN 1 to 600, so the cap keeps CCN 600 down to 101.
    const many: CodeSnapshot = {
      ...snapshot,
      functions: Array.from({ length: 600 }, (_, i) =>
        fn("scripts/build.js", `f${i}`, i + 1, 2, i * 3 + 1, i * 3 + 2, "JavaScript"),
      ),
      partlyMeasured: [],
    };
    const report = codeDetail(many, none, { area: "scripts" });
    expect(report.functions.total).toBe(600);
    expect(report.functions.items).toHaveLength(CODE_DETAIL_CAPS.functions);
    expect(report.functions.items[0]!.ccn).toBe(600);
    expect(report.functions.items.at(-1)!.ccn).toBe(101);
  });
});
