import { describe, expect, it } from "vitest";
import { describeHotspots, hotspotShape, nextBand } from "../src/codeAdvice.js";
import { codeHealth, type CodeSnapshot, type FunctionMetrics } from "../src/codeHealth.js";
import { maintainabilityGrade } from "../src/codeGrade.js";

const fn = (name: string, ccn: number, nloc: number, file = "src/a.ts", params = 1): FunctionMetrics => ({
  file,
  language: "TypeScript",
  name,
  startLine: 1,
  ccn,
  nloc,
  params,
});

const filler = (count: number, nloc: number) => Array.from({ length: count }, (_, i) => fn(`ok${i}`, 2, nloc));

const snapshot = (functions: FunctionMetrics[], partlyMeasured?: string[]): CodeSnapshot => ({
  commitSha: "abc123",
  analysedAt: "2026-09-29T10:00:00Z",
  functions,
  ...(partlyMeasured ? { partlyMeasured } : {}),
});

describe("hotspotShape", () => {
  it("calls a capitalised function in a tsx or jsx file a component", () => {
    expect(hotspotShape(fn("Page", 12, 30, "src/Page.tsx"))).toBe("component");
    expect(hotspotShape(fn("Page", 12, 30, "src/Page.JSX"))).toBe("component");
  });

  it("calls a lower-case function in a tsx file by its body, not a component", () => {
    // 12 / 20 = 0.6 branches per line.
    expect(hotspotShape(fn("helper", 12, 20, "src/Page.tsx"))).toBe("dense");
  });

  it("calls one branch for every two lines dense, the limit included", () => {
    expect(hotspotShape(fn("f", 11, 22))).toBe("dense"); // exactly 0.5
    expect(hotspotShape(fn("f", 11, 23))).toBe("branching"); // just under 0.5, and under 40 lines
  });

  it("calls a function of 40 lines or more long when it is not dense", () => {
    expect(hotspotShape(fn("f", 11, 40))).toBe("long");
    expect(hotspotShape(fn("f", 11, 39))).toBe("branching");
    expect(hotspotShape(fn("f", 3, 61))).toBe("long"); // over the 60-line limit with little branching
  });

  it("has nothing to advise within the complexity and length limits, whatever the parameters", () => {
    expect(hotspotShape(fn("f", 10, 60))).toBeNull();
    expect(hotspotShape(fn("f", 2, 5, "src/a.ts", 9))).toBeNull();
  });

  it("does not divide by zero on a function with no lines", () => {
    expect(hotspotShape(fn("f", 11, 0))).toBe("dense");
  });
});

describe("nextBand", () => {
  // 1,000 source lines. Above CCN 20: A (60) is 6%, medium. Above CCN 10: A, B, C = 150 is 15%, medium.
  // No function is over 60 lines or 5 parameters, so maintainability is medium.
  const a = fn("A", 25, 60);
  const b = fn("B", 15, 50);
  const c = fn("C", 12, 40);
  const medium = [a, b, c, ...filler(34, 25)];

  it("names the function whose simplifying clears both complexity checks for high", () => {
    // High needs under 3% above CCN 20, so A goes (60 to 0). Above CCN 10 is then B and C, 90 lines,
    // 9%, which is already under the 10% high needs, so nothing more is picked.
    const figures = codeHealth(snapshot(medium)).maintainability;
    expect(maintainabilityGrade(figures).band).toBe("medium");
    expect(nextBand(medium, figures)).toEqual({ from: "medium", to: "high", functions: [a], lines: 60 });
  });

  it("picks the largest offender first so the fewest functions do", () => {
    // 1,000 lines. Above CCN 10: A 60, B 100, C 50, D 40 = 250 is 25%, low. Medium needs under 20%:
    // B alone takes it to 150, 15%. Above CCN 20 (A, 6%) already meets medium's 8%.
    // B is also the one function over 60 lines (1 of 34, 2.9%, fine for medium).
    const big = fn("B", 15, 100);
    const fns = [a, big, fn("C", 12, 50), fn("D", 11, 40), ...filler(30, 25)];
    const figures = codeHealth(snapshot(fns)).maintainability;
    expect(maintainabilityGrade(figures).band).toBe("low");
    expect(nextBand(fns, figures)).toEqual({ from: "low", to: "medium", functions: [big], lines: 100 });
  });

  it("counts long functions by number, stopping once the share is strictly under the limit", () => {
    // 4 of 100 functions over 60 lines is 4%, medium. High needs under 3%: 3 of 100 is 3%, not enough,
    // so two go. All four tie on size and complexity, so the name decides.
    const long = ["l4", "l2", "l1", "l3"].map((name) => fn(name, 1, 61));
    const fns = [...long, ...filler(96, 10)];
    const figures = codeHealth(snapshot(fns)).maintainability;
    expect(maintainabilityGrade(figures).band).toBe("medium");
    const path = nextBand(fns, figures)!;
    expect(path.functions.map((f) => f.name)).toEqual(["l1", "l2"]);
    expect(path.lines).toBe(122);
  });

  it("counts functions with many parameters", () => {
    // 5 of 100 is 5%, medium. High needs under 3%, so three go.
    const wide = [1, 2, 3, 4, 5].map((i) => fn(`p${i}`, 1, 10 + i, "src/a.ts", 6));
    const fns = [...wide, ...filler(95, 10)];
    const path = nextBand(fns, codeHealth(snapshot(fns)).maintainability)!;
    expect(path.to).toBe("high");
    expect(path.functions.map((f) => f.name)).toEqual(["p5", "p4", "p3"]);
  });

  it("needs a pick when a line figure equals the limit, since limits are exclusive", () => {
    // 1,000 lines. X and Y (50 each, CCN 11) put exactly 10% above CCN 10, which is medium because high needs
    // under 10%. Taking X leaves 5%, so one pick is enough; X and Y tie on size and complexity, so the name decides.
    const x = fn("X", 11, 50);
    const fns = [fn("Y", 11, 50), x, ...filler(36, 25)];
    const figures = codeHealth(snapshot(fns)).maintainability;
    expect(figures.linesAboveWarn).toBe(0.1);
    expect(nextBand(fns, figures)).toEqual({ from: "medium", to: "high", functions: [x], lines: 50 });
  });

  it("aims at elite's limits from high", () => {
    // 1,000 lines with 60 above CCN 10 is 6%: under high's 10% but not elite's 5%.
    const h = fn("H", 15, 60);
    const fns = [h, ...filler(47, 20)];
    const figures = codeHealth(snapshot(fns)).maintainability;
    expect(maintainabilityGrade(figures).band).toBe("high");
    expect(nextBand(fns, figures)).toEqual({ from: "high", to: "elite", functions: [h], lines: 60 });
  });

  it("prefers a function that fails several counted checks, so one pick clears both", () => {
    // 100 functions. Over 60 lines: W, L1, L2 (3%). Over 5 parameters: W, P1, P2 (3%). Both are medium, and
    // high needs under 3%. W fails both, so taking it leaves 2% of each; by size alone L1 would go first and
    // a second pick would be needed for parameters.
    const w = fn("W", 2, 61, "src/a.ts", 6);
    const fns = [
      fn("L1", 2, 70),
      fn("L2", 2, 65),
      w,
      fn("P1", 2, 10, "src/a.ts", 6),
      fn("P2", 2, 10, "src/a.ts", 6),
      ...filler(95, 10),
    ];
    const figures = codeHealth(snapshot(fns)).maintainability;
    expect(maintainabilityGrade(figures).band).toBe("medium");
    expect(nextBand(fns, figures)?.functions).toEqual([w]);
  });

  it("is null when maintainability is already elite, or there is no source", () => {
    const fns = filler(10, 10);
    expect(nextBand(fns, codeHealth(snapshot(fns)).maintainability)).toBeNull();
    expect(nextBand([], codeHealth(snapshot([])).maintainability)).toBeNull();
  });
});

describe("describeHotspots", () => {
  it("adds the shape, the share of source lines and whether the function is on the path", () => {
    const a = fn("A", 25, 60);
    const b = fn("B", 3, 20);
    const [first, second] = describeHotspots([a, b], 200, { from: "medium", to: "high", functions: [a], lines: 60 });
    expect(first).toMatchObject({ name: "A", shape: "long", lineShare: 0.3, onPath: true });
    expect(second).toMatchObject({ name: "B", shape: null, lineShare: 0.1, onPath: false });
  });

  it("gives a zero share when there are no lines, and nothing on the path without one", () => {
    expect(describeHotspots([fn("A", 1, 0)], 0, null)[0]).toMatchObject({ lineShare: 0, onPath: false });
  });
});

describe("codeHealth advice", () => {
  it("carries the path and marks its hotspots", () => {
    const fns = [fn("A", 25, 60), fn("B", 15, 50), fn("C", 12, 40), ...filler(34, 25)];
    const report = codeHealth(snapshot(fns));
    expect(report.nextBand?.functions.map((f) => f.name)).toEqual(["A"]);
    expect(report.hotspots.filter((h) => h.onPath).map((h) => h.name)).toEqual(["A"]);
    expect(report.hotspots[0]).toMatchObject({ name: "A", shape: "long", lineShare: 0.06 });
  });

  it("lists partly measured source files sorted, leaving test files out", () => {
    const report = codeHealth(snapshot(filler(1, 5), ["src/b.tsx", "src/a.test.tsx", "src/a.tsx"]));
    expect(report.partlyMeasured).toEqual(["src/a.tsx", "src/b.tsx"]);
  });

  it("has no partly measured files for a snapshot from before version 4", () => {
    expect(codeHealth(snapshot(filler(1, 5))).partlyMeasured).toEqual([]);
  });

  it("reports the source files no installed tool could read", () => {
    expect(codeHealth({ ...snapshot(filler(1, 5)), unmeasuredFiles: 7 }).unmeasuredFiles).toBe(7);
  });

  it("has no unmeasured files for a snapshot from before version 5", () => {
    expect(codeHealth(snapshot(filler(1, 5))).unmeasuredFiles).toBe(0);
  });
});
