import { describe, expect, it } from "vitest";
import {
  alignCoverage,
  chooseCoverageRun,
  coverageCount,
  isCoverageArtefactName,
  joinRanges,
  lineCount,
  type CoverageArtefact,
  type CoverageFileReport,
  type CoverageFormat,
  type CoverageReport,
} from "../src/codeCoverage.js";

const artefact = (id: number, name: string, createdAt: string, runId: number, commitSha: string): CoverageArtefact => ({
  id,
  name,
  sizeBytes: 100,
  createdAt,
  runId,
  commitSha,
});

describe("isCoverageArtefactName", () => {
  it.each(["coverage", "Code-Coverage-report", "api_COVERAGE_lcov"])("accepts %s", (name) => {
    expect(isCoverageArtefactName(name)).toBe(true);
  });
  it.each(["dist", "test-results", "cover"])("refuses %s", (name) => {
    expect(isCoverageArtefactName(name)).toBe(false);
  });
});

describe("chooseCoverageRun", () => {
  const found = [
    artefact(1, "coverage-api", "2026-10-01T10:00:00Z", 100, "aaa"),
    artefact(2, "coverage-web", "2026-10-01T10:01:00Z", 100, "aaa"),
    artefact(3, "coverage", "2026-10-02T10:00:00Z", 200, "bbb"),
    artefact(4, "coverage", "2026-10-03T10:00:00Z", 300, "ccc"),
  ];

  const ids = (run: ReturnType<typeof chooseCoverageRun>) => run?.artefacts.map((a) => a.id);

  it("prefers the newest run that built the analysed commit, whatever newer runs exist", () => {
    expect(chooseCoverageRun(found, "aaa")).toEqual({
      runId: 100,
      commitSha: "aaa",
      artefacts: [found[1], found[0]],
      artefactsInRun: 2,
    });
  });

  it("takes the newest run when none built the analysed commit", () => {
    expect(ids(chooseCoverageRun(found, "zzz"))).toEqual([4]);
    expect(chooseCoverageRun(found, null)).toMatchObject({ runId: 300, commitSha: "ccc", artefactsInRun: 1 });
  });

  it("keeps at most the limit from the chosen run, never fewer than one, and says how many the run had", () => {
    expect(chooseCoverageRun(found, "aaa", 1)).toMatchObject({ artefacts: [found[1]], artefactsInRun: 2 });
    expect(ids(chooseCoverageRun(found, "aaa", 0))).toEqual([2]);
  });

  it("is null when nothing was found", () => {
    expect(chooseCoverageRun([], "aaa")).toBeNull();
  });

  it("breaks a tie on time by the higher artefact id", () => {
    const same = [
      artefact(7, "coverage", "2026-10-01T10:00:00Z", 1, "x"),
      artefact(8, "coverage-b", "2026-10-01T10:00:00Z", 2, "y"),
    ];
    expect(ids(chooseCoverageRun(same, null))).toEqual([8]);
  });
});

describe("coverageCount", () => {
  it("keeps whole, non-negative counts with no more covered than there are", () => {
    expect(coverageCount(0, 0)).toEqual({ covered: 0, total: 0 });
    expect(coverageCount(3, 10)).toEqual({ covered: 3, total: 10 });
    expect(coverageCount(10, 10)).toEqual({ covered: 10, total: 10 });
  });

  it.each([
    [12, 10],
    [-3, 4],
    [1, -1],
    [1.5, 4],
    [1, Number.NaN],
    [1, Number.POSITIVE_INFINITY],
    ["1", 4],
    [null, 4],
  ])("refuses %s of %s", (covered, total) => {
    expect(coverageCount(covered, total)).toBeNull();
  });
});

describe("line ranges", () => {
  it("joins ranges that overlap or touch, in line order", () => {
    expect(
      joinRanges([
        [8, 9],
        [1, 3],
        [4, 4],
        [2, 6],
        [11, 11],
      ]),
    ).toEqual([
      [1, 6],
      [8, 9],
      [11, 11],
    ]);
  });

  it("counts each line once, so a single-line range is one line", () => {
    // [1,3] and [2,4] share lines 2 and 3, so together they are lines 1 to 4; [9,9] adds one.
    expect(
      lineCount([
        [1, 3],
        [2, 4],
        [9, 9],
      ]),
    ).toBe(5);
    expect(lineCount([])).toBe(0);
  });
});

const file = (path: string, covered: number, total: number, extra: Partial<CoverageFileReport> = {}): CoverageFileReport => ({
  path,
  lines: { covered, total },
  ...extra,
});

const report = (files: CoverageFileReport[], extra: Partial<CoverageReport> = {}): CoverageReport => ({
  format: "lcov",
  artefact: "coverage",
  dir: "coverage",
  files,
  ...extra,
});

const pathsOf = (reports: CoverageReport[], known: string[]) => [...alignCoverage(reports, known).files.keys()].sort();

describe("alignCoverage", () => {
  it("adds the package prefix that most paths agree on", () => {
    // `src/a.ts` could be in either package, but `src/b.ts` exists only in core, so core has two votes against one.
    const known = ["packages/core/src/a.ts", "packages/core/src/b.ts", "apps/web/src/a.ts"];
    expect(pathsOf([report([file("src/a.ts", 1, 2), file("src/b.ts", 2, 2)])], known)).toEqual([
      "packages/core/src/a.ts",
      "packages/core/src/b.ts",
    ]);
  });

  it("strips an absolute runner prefix", () => {
    const known = ["src/a.ts", "src/deep/b.ts"];
    const runner = "/home/runner/work/widgets/widgets";
    expect(pathsOf([report([file(`${runner}/src/a.ts`, 1, 1), file(`${runner}/src/deep/b.ts`, 1, 1)])], known)).toEqual([
      "src/a.ts",
      "src/deep/b.ts",
    ]);
  });

  it("reads Windows paths, drive letters and file URLs", () => {
    const known = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const result = pathsOf(
      [
        report([
          file("C:\\work\\widgets\\src\\a.ts", 1, 1),
          file("file:///C:/work/widgets/src/b.ts", 1, 1),
          file("./src/../src/c.ts", 1, 1),
        ]),
      ],
      known,
    );
    expect(result).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("joins a Cobertura source root to a relative file name", () => {
    const known = ["packages/core/src/a.ts", "apps/web/src/a.ts"];
    const cobertura = report([file("src/a.ts", 1, 2)], {
      format: "cobertura",
      sourceRoots: ["/home/runner/work/widgets/widgets/packages/core"],
    });
    expect(pathsOf([cobertura], known)).toEqual(["packages/core/src/a.ts"]);
  });

  it("breaks a tie by the directory the report came from", () => {
    const known = ["apps/api/src/index.ts", "apps/web/src/index.ts"];
    const chosen = (dir: string) => pathsOf([report([file("src/index.ts", 1, 1)], { dir })], known);
    expect(chosen("apps/web/coverage")).toEqual(["apps/web/src/index.ts"]);
    expect(chosen("apps/api")).toEqual(["apps/api/src/index.ts"]);
  });

  it("breaks a remaining tie by the fewest segments added", () => {
    const known = ["web/src/index.ts", "apps/api/src/index.ts"];
    expect(pathsOf([report([file("src/index.ts", 1, 1)], { dir: "" })], known)).toEqual(["web/src/index.ts"]);
  });

  it("breaks a tie that is left by the name of the prefix, so the result never depends on order", () => {
    const known = ["b/src/index.ts", "a/src/index.ts"];
    expect(pathsOf([report([file("src/index.ts", 1, 1)], { dir: "" })], known)).toEqual(["a/src/index.ts"]);
  });

  it("falls back to a unique suffix match for a path the winning prefix cannot place", () => {
    const known = ["p/src/a.ts", "p/src/b.ts", "q/lib/z.ts"];
    expect(pathsOf([report([file("src/a.ts", 1, 1), file("src/b.ts", 1, 1), file("lib/z.ts", 1, 1)])], known)).toEqual([
      "p/src/a.ts",
      "p/src/b.ts",
      "q/lib/z.ts",
    ]);
  });

  it("leaves a path unmatched when its suffix could be two files", () => {
    const known = ["p/src/a.ts", "p/src/b.ts", "q/lib/z.ts", "r/lib/z.ts"];
    const result = alignCoverage([report([file("src/a.ts", 1, 1), file("src/b.ts", 1, 1), file("lib/z.ts", 1, 1)])], known);
    expect(result.matched).toBe(2);
    expect(result.unmatched).toBe(1);
    expect([...result.files.keys()]).not.toContain("q/lib/z.ts");
  });

  it("counts what it cannot match, never naming it, and drops test files", () => {
    const known = ["src/a.ts", "src/a.test.ts"];
    const result = alignCoverage(
      [report([file("src/a.ts", 1, 2), file("/home/runner/secret-client/src/ghost.ts", 0, 3), file("src/a.test.ts", 1, 1)])],
      known,
    );
    expect(result).toMatchObject({ inReport: 2, matched: 1, unmatched: 1 });
    expect([...result.files.keys()]).toEqual(["src/a.ts"]);
    expect(JSON.stringify([...result.files.values()])).not.toContain("secret-client");
  });

  it("drops a path that lands on a test file", () => {
    const known = ["src/__helpers__/x.ts", "tests/util.ts"];
    expect(alignCoverage([report([file("tests/util.ts", 1, 1)])], known)).toMatchObject({
      inReport: 0,
      matched: 0,
      unmatched: 0,
    });
  });

  it("keeps only the best format in one directory", () => {
    const known = ["src/a.ts"];
    const formats: CoverageFormat[] = ["istanbul-summary", "cobertura", "lcov", "istanbul-final"];
    const reports = formats.map((format, i) => report([file("src/a.ts", i, 10)], { format }));
    const result = alignCoverage(reports, known);
    expect(result.files.get("src/a.ts")).toMatchObject({ format: "lcov", lines: { covered: 2, total: 10 } });
  });

  it("ranks Istanbul final above Cobertura above the Istanbul summary", () => {
    const known = ["src/a.ts"];
    const best = (formats: CoverageFormat[]) =>
      alignCoverage(
        formats.map((format) => report([file("src/a.ts", 1, 2)], { format })),
        known,
      ).files.get("src/a.ts")?.format;
    expect(best(["cobertura", "istanbul-final"])).toBe("istanbul-final");
    expect(best(["istanbul-summary", "cobertura"])).toBe("cobertura");
  });

  it("uses every format when they sit in different directories, taking lines from the report with ranges and the higher branch and function counts", () => {
    const known = ["src/a.ts"];
    const summary = report([file("src/a.ts", 5, 10)], { format: "istanbul-summary", dir: "summary" });
    const detailed = report([file("src/a.ts", 4, 10, { ranges: { covered: [[1, 4]], uncovered: [[5, 10]] } })], {
      format: "lcov",
      dir: "lcov",
    });
    const withBranches = report(
      [file("src/a.ts", 3, 10, { branches: { covered: 1, total: 2 }, functions: { covered: 1, total: 1 } })],
      {
        format: "cobertura",
        dir: "xml",
      },
    );
    for (const order of [
      [summary, detailed, withBranches],
      [withBranches, summary, detailed],
      [detailed, withBranches, summary],
    ]) {
      expect(alignCoverage(order, known).files.get("src/a.ts")).toEqual({
        path: "src/a.ts",
        format: "lcov",
        artefact: "coverage",
        lines: { covered: 4, total: 10 },
        ranges: { covered: [[1, 4]], uncovered: [[5, 10]] },
        branches: { covered: 1, total: 2 },
        functions: { covered: 1, total: 1 },
      });
    }
  });

  it("keeps the report with more lines covered when neither has ranges, and the first when they agree", () => {
    const known = ["src/a.ts"];
    const a = report([file("src/a.ts", 1, 2)], { artefact: "first", dir: "x" });
    const b = report([file("src/a.ts", 2, 2)], { artefact: "second", dir: "y" });
    const c = report([file("src/a.ts", 1, 2)], { artefact: "third", dir: "z" });
    expect(alignCoverage([a, b], known).files.get("src/a.ts")?.artefact).toBe("second");
    expect(alignCoverage([a, c], known).files.get("src/a.ts")?.artefact).toBe("first");
  });

  describe("joining two reports of one file that both carry ranges", () => {
    const known = ["src/a.ts"];
    const unit = (ranges: { covered: [number, number][]; uncovered: [number, number][] }) =>
      file("src/a.ts", lineCount(ranges.covered), lineCount([...ranges.covered, ...ranges.uncovered]), { ranges });

    it("counts a line as run when either report ran it", () => {
      // Each report ran one of the two lines, so together both lines ran.
      const a = report([unit({ covered: [[1, 1]], uncovered: [[2, 2]] })], { dir: "unit" });
      const b = report([unit({ covered: [[2, 2]], uncovered: [[1, 1]] })], { dir: "integration" });
      expect(alignCoverage([a, b], known).files.get("src/a.ts")).toMatchObject({
        lines: { covered: 2, total: 2 },
        ranges: { covered: [[1, 2]], uncovered: [] },
      });
    });

    it("joins overlapping ranges and keeps what neither ran", () => {
      // Instrumented: 1-10 from the first and 8-20 from the second, so 1-20 (20 lines).
      // Covered: 1-3 and 8-15, so 3 + 8 = 11 lines; never run: 4-7 and 16-20.
      const a = report([unit({ covered: [[1, 3]], uncovered: [[4, 10]] })], { dir: "unit" });
      const b = report([unit({ covered: [[8, 15]], uncovered: [[16, 20]] })], { dir: "integration" });
      expect(alignCoverage([a, b], known).files.get("src/a.ts")).toMatchObject({
        lines: { covered: 11, total: 20 },
        ranges: {
          covered: [
            [1, 3],
            [8, 15],
          ],
          uncovered: [
            [4, 7],
            [16, 20],
          ],
        },
      });
    });

    it("keeps the gaps between instrumented lines out of both lists", () => {
      // Instrumented: 1-3 and 10-12, six lines with nothing between. Covered: 1-2 and 10. Never run: 3 and 11-12.
      const a = report([unit({ covered: [[1, 2]], uncovered: [[3, 3]] })], { dir: "unit" });
      const b = report([unit({ covered: [[10, 10]], uncovered: [[11, 12]] })], { dir: "integration" });
      expect(alignCoverage([a, b], known).files.get("src/a.ts")).toMatchObject({
        lines: { covered: 3, total: 6 },
        ranges: {
          covered: [
            [1, 2],
            [10, 10],
          ],
          uncovered: [
            [3, 3],
            [11, 12],
          ],
        },
      });
    });

    it("keeps the higher branch and function counts, as reports do not say which ones ran", () => {
      const a = report([unit({ covered: [[1, 1]], uncovered: [] }), file("src/b.ts", 0, 0)], { dir: "unit" });
      const withCounts = { branches: { covered: 1, total: 4 }, functions: { covered: 2, total: 3 } };
      const b = report([{ ...unit({ covered: [[1, 1]], uncovered: [] }), ...withCounts }], { dir: "integration" });
      const c = report([{ ...unit({ covered: [[1, 1]], uncovered: [] }), branches: { covered: 1, total: 6 } }], { dir: "e2e" });
      expect(alignCoverage([a, b, c], known).files.get("src/a.ts")).toMatchObject({
        branches: { covered: 1, total: 6 },
        functions: { covered: 2, total: 3 },
      });
    });
  });

  describe("figures a report cannot have", () => {
    const known = ["src/a.ts", "src/b.ts"];

    it("drops a file whose line count is impossible", () => {
      const found = alignCoverage([report([file("src/a.ts", 12, 10), file("src/b.ts", 1, 2)])], known);
      expect([...found.files.keys()]).toEqual(["src/b.ts"]);
    });

    it("drops an impossible branch or function count and keeps the lines", () => {
      const found = alignCoverage(
        [report([file("src/a.ts", 1, 2, { branches: { covered: 3, total: 2 }, functions: { covered: -1, total: 2 } })])],
        known,
      );
      expect(found.files.get("src/a.ts")).toEqual({
        path: "src/a.ts",
        lines: { covered: 1, total: 2 },
        format: "lcov",
        artefact: "coverage",
      });
    });

    it.each([
      ["a range that runs backwards", { covered: [[3, 1]], uncovered: [] }],
      ["a line number below one", { covered: [[0, 2]], uncovered: [] }],
      ["ranges that disagree with the count", { covered: [[1, 1]], uncovered: [] }],
      ["a line in both lists", { covered: [[1, 2]], uncovered: [[2, 2]] }],
    ])("drops the ranges and keeps the totals for %s", (_, ranges) => {
      const found = alignCoverage([report([file("src/a.ts", 2, 3, { ranges: ranges as never })])], known);
      expect(found.files.get("src/a.ts")).toMatchObject({ lines: { covered: 2, total: 3 } });
      expect(found.files.get("src/a.ts")?.ranges).toBeUndefined();
      expect(found.lineDetail).toBe(false);
    });
  });

  it("says whether any matched file carries ranges", () => {
    const known = ["src/a.ts", "src/b.ts"];
    expect(alignCoverage([report([file("src/a.ts", 1, 1)])], known).lineDetail).toBe(false);
    const ranged = file("src/b.ts", 1, 1, { ranges: { covered: [[1, 1]], uncovered: [] } });
    expect(alignCoverage([report([file("src/a.ts", 1, 1), ranged])], known).lineDetail).toBe(true);
  });

  it("returns nothing for no reports", () => {
    expect(alignCoverage([], ["src/a.ts"])).toMatchObject({ inReport: 0, matched: 0, unmatched: 0 });
  });

  describe("counting files that match nothing", () => {
    it("counts the same relative path in two report directories as two files", () => {
      const known = ["src/a.ts"];
      const first = report([file("src/a.ts", 1, 2), file("gone/zzz.ts", 0, 4)], { artefact: "one", dir: "api/coverage" });
      const second = report([file("gone/zzz.ts", 0, 4)], { artefact: "one", dir: "web/coverage" });
      // src/a.ts matched once, and gone/zzz.ts is a stray in each of the two directories.
      expect(alignCoverage([first, second], known)).toMatchObject({ inReport: 3, matched: 1, unmatched: 2 });
    });

    it("counts one file once when the same report lists it twice", () => {
      const known = ["src/a.ts"];
      const twice = report([file("src/a.ts", 1, 2), file("gone/zzz.ts", 0, 4), file("gone/zzz.ts", 0, 4)]);
      expect(alignCoverage([twice], known)).toMatchObject({ inReport: 2, unmatched: 1 });
    });

    it("does not count a path as unmatched when another report placed it on a file already matched", () => {
      // Two packages each have src/a.ts. The first report is for core, so its transform places src/a.ts and src/b.ts
      // there. The second is for web, and its own transform cannot place src/a.ts between the two candidates.
      const known = [
        "packages/core/src/a.ts",
        "packages/core/src/b.ts",
        "packages/ui/src/a.ts",
        "apps/web/lib/x.ts",
        "apps/web/lib/y.ts",
      ];
      const core = report([file("src/a.ts", 1, 2), file("src/b.ts", 1, 2)], { artefact: "core", dir: "core/coverage" });
      const web = report([file("lib/x.ts", 1, 2), file("lib/y.ts", 1, 2), file("src/a.ts", 1, 2)], {
        artefact: "web",
        dir: "web/coverage",
      });
      expect(alignCoverage([core, web], known)).toMatchObject({ inReport: 4, matched: 4, unmatched: 0 });
    });
  });

  describe("choosing between many files with one name", () => {
    it("lets the directories that agree decide, even beyond the fifty candidates", () => {
      // Sixty packages each hold src/index.ts. The report path carries p57, which shares four segments with the right file.
      const known = Array.from({ length: 60 }, (_, i) => `packages/p${i}/src/index.ts`);
      const runner = "/home/runner/work/widgets/widgets";
      const found = alignCoverage([report([file(`${runner}/packages/p57/src/index.ts`, 3, 4)])], known);
      expect([...found.files.keys()]).toEqual(["packages/p57/src/index.ts"]);
    });

    it("places a package whose files all share one name when its other files vote for it", () => {
      const known = [...Array.from({ length: 60 }, (_, i) => `packages/p${i}/src/index.ts`), "packages/p58/src/util.ts"];
      const found = alignCoverage([report([file("src/index.ts", 1, 2), file("src/util.ts", 1, 2)])], known);
      // util.ts exists only in p58, so p58 collects a vote that no other package can match.
      expect([...found.files.keys()].sort()).toEqual(["packages/p58/src/index.ts", "packages/p58/src/util.ts"]);
    });
  });

  describe("matching by a unique suffix", () => {
    it("places a path that only ends a known path, and one that is ended by a known path", () => {
      const known = ["deep/nested/pkg/a.ts", "b.ts"];
      const found = alignCoverage([report([file("nested/pkg/a.ts", 1, 1), file("/ci/work/b.ts", 1, 1)], { dir: "x" })], known);
      expect([...found.files.keys()].sort()).toEqual(["b.ts", "deep/nested/pkg/a.ts"]);
    });

    it("leaves a path unmatched when two known files fit it and its own layout does not place it", () => {
      const known = ["packages/core/src/a.ts", "packages/ui/src/a.ts", "apps/web/lib/x.ts", "apps/web/lib/y.ts"];
      const web = report([file("lib/x.ts", 1, 1), file("lib/y.ts", 1, 1), file("src/a.ts", 1, 1)]);
      expect(alignCoverage([web], known)).toMatchObject({ inReport: 3, matched: 2, unmatched: 1 });
    });

    it("leaves unmatched every path whose only evidence is a name that thousands of files share", () => {
      const known = Array.from({ length: 5000 }, (_, i) => `pkg${i}/src/index.ts`);
      const entries = Array.from({ length: 300 }, (_, i) => file(`other${i}/index.ts`, 1, 1));
      // Each path could be any of the 5,000 files, and no two paths agree on a package, so none is placed.
      expect(alignCoverage([report(entries)], known)).toMatchObject({ matched: 0, unmatched: 300 });
    });

    it("leaves unmatched two paths whose votes tie across packages, and places them when the directory hint decides", () => {
      const known = Array.from({ length: 100 }, (_, i) => [`pkg${i}/src/index.ts`, `pkg${i}/src/main.ts`]).flat();
      // Both paths sit in `x`, so they agree on every package that has both files: a tie the paths cannot break.
      const entries = [file("x/index.ts", 1, 1), file("x/main.ts", 1, 1)];
      expect(alignCoverage([report(entries)], known).matched).toBe(0);
      expect(pathsOf([report(entries, { dir: "pkg7/src/coverage" })], known)).toEqual(["pkg7/src/index.ts", "pkg7/src/main.ts"]);
    });

    it("places paths held back by common names on the one package that they all agree on", () => {
      // 60 files share each name, so both paths are held back, but only a0 holds both names.
      const known = [
        ...Array.from({ length: 60 }, (_, i) => `a${i}/src/index.ts`),
        "a0/src/util.ts",
        ...Array.from({ length: 59 }, (_, i) => `b${i}/src/util.ts`),
      ];
      const entries = [file("x/index.ts", 1, 1), file("x/util.ts", 1, 1)];
      expect(pathsOf([report(entries)], known)).toEqual(["a0/src/index.ts", "a0/src/util.ts"]);
    });

    it("does not let a path outside the repository land on a root file by its name", () => {
      const root = "/home/runner/work/widgets/widgets";
      const found = alignCoverage(
        [
          report([
            file(`${root}/node_modules/foo/index.ts`, 0, 10),
            file(`${root}/index.ts`, 9, 10),
            file(`${root}/src/q.ts`, 1, 1),
          ]),
        ],
        ["index.ts", "src/q.ts"],
      );
      expect(found.files.get("index.ts")?.lines).toEqual({ covered: 9, total: 10 });
      expect(found).toMatchObject({ matched: 2, unmatched: 1 });
    });

    it("still places a path from another checkout by a tail of two or more segments", () => {
      const found = alignCoverage(
        [report([file("/ci/a/src/x.ts", 1, 1), file("/ci/a/src/y.ts", 1, 1), file("/elsewhere/src/z.ts", 1, 1)])],
        ["src/x.ts", "src/y.ts", "src/z.ts"],
      );
      expect([...found.files.keys()].sort()).toEqual(["src/x.ts", "src/y.ts", "src/z.ts"]);
    });
  });
});
