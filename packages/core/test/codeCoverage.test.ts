import { describe, expect, it } from "vitest";
import {
  alignCoverage,
  chooseCoverageRun,
  isCoverageArtefactName,
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

  it("prefers the newest run that built the analysed commit, whatever newer runs exist", () => {
    expect(chooseCoverageRun(found, "aaa").map((a) => a.id)).toEqual([2, 1]);
  });

  it("takes the newest run when none built the analysed commit", () => {
    expect(chooseCoverageRun(found, "zzz").map((a) => a.id)).toEqual([4]);
    expect(chooseCoverageRun(found, null).map((a) => a.id)).toEqual([4]);
  });

  it("keeps at most the limit from the chosen run", () => {
    expect(chooseCoverageRun(found, "aaa", 1).map((a) => a.id)).toEqual([2]);
    expect(chooseCoverageRun(found, "aaa", 0)).toEqual([]);
  });

  it("is empty when nothing was found", () => {
    expect(chooseCoverageRun([], "aaa")).toEqual([]);
  });

  it("breaks a tie on time by the higher artefact id", () => {
    const same = [
      artefact(7, "coverage", "2026-10-01T10:00:00Z", 1, "x"),
      artefact(8, "coverage-b", "2026-10-01T10:00:00Z", 2, "y"),
    ];
    expect(chooseCoverageRun(same, null).map((a) => a.id)).toEqual([8]);
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

  it("uses every format when they sit in different directories, and keeps the most detailed report of a file", () => {
    const known = ["src/a.ts"];
    const summary = report([file("src/a.ts", 5, 10)], { format: "istanbul-summary", dir: "summary" });
    const detailed = report([file("src/a.ts", 4, 10, { covered: [[1, 4]], uncovered: [[5, 10]] })], {
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
      expect(alignCoverage(order, known).files.get("src/a.ts")).toMatchObject({
        format: "lcov",
        lines: { covered: 4, total: 10 },
      });
    }
  });

  it("keeps the first of two reports that say the same", () => {
    const known = ["src/a.ts"];
    const a = report([file("src/a.ts", 1, 2)], { artefact: "first", dir: "x" });
    const b = report([file("src/a.ts", 2, 2)], { artefact: "second", dir: "y" });
    expect(alignCoverage([a, b], known).files.get("src/a.ts")?.artefact).toBe("first");
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

    it("stays quick and unmatched when thousands of files share the name", () => {
      const known = Array.from({ length: 5000 }, (_, i) => `pkg${i}/src/index.ts`);
      const entries = Array.from({ length: 300 }, (_, i) => file(`other${i}/index.ts`, 1, 1));
      const started = Date.now();
      const found = alignCoverage([report(entries)], known);
      // The chosen transform places one of them; the rest end in a name that thousands of files share.
      expect(found.matched).toBe(1);
      expect(found.unmatched).toBe(299);
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
