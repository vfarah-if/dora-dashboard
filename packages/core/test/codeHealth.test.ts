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
    const custom = codeHealth(sample, { warn: 4, high: 10 });
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
