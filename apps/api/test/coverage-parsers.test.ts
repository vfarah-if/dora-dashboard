import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/core/errors.js";
import { lineRanges, MAX_RANGES_PER_FILE } from "../src/infrastructure/coverage-reports/line-ranges.js";
import { parseCobertura } from "../src/infrastructure/coverage-reports/parse-cobertura.js";
import { parseIstanbulFinal, parseIstanbulSummary } from "../src/infrastructure/coverage-reports/parse-istanbul.js";
import { parseLcov } from "../src/infrastructure/coverage-reports/parse-lcov.js";
import { YIELD_EVERY } from "../src/infrastructure/coverage-reports/yield-loop.js";

const RUNNER = "/home/runner/work/widgets/widgets";

/**
 * Queues other work on the event loop before the parse starts, then reports whether that work ran before the parse
 * finished. A parser that never yields finishes through microtasks alone, so the other work would come second.
 */
async function yieldsDuring(parse: () => Promise<unknown>): Promise<boolean> {
  const order: string[] = [];
  setImmediate(() => order.push("other"));
  await parse();
  order.push("parsed");
  return order[0] === "other";
}

describe("lineRanges", () => {
  it("joins consecutive lines and keeps exact counts", () => {
    const hits = new Map([
      [1, 3],
      [2, 1],
      [3, 0],
      [4, 0],
      [6, 2],
    ]);

    expect(lineRanges(hits)).toEqual({
      lines: { covered: 3, total: 5 },
      ranges: {
        covered: [
          [1, 2],
          [6, 6],
        ],
        uncovered: [[3, 4]],
      },
    });
  });

  it("does not join across a line the report does not mention", () => {
    const result = lineRanges(
      new Map([
        [1, 0],
        [3, 0],
      ]),
    );

    expect(result.ranges?.uncovered).toEqual([
      [1, 1],
      [3, 3],
    ]);
  });

  it("ignores line numbers that are not positive whole numbers", () => {
    const result = lineRanges(
      new Map([
        [0, 1],
        [-2, 1],
        [1.5, 1],
        [7, 1],
      ]),
    );

    expect(result.lines).toEqual({ covered: 1, total: 1 });
    expect(result.ranges?.covered).toEqual([[7, 7]]);
  });

  it("leaves out both lists, and keeps exact counts, when both need more than 1,000 ranges", () => {
    // Lines 1 to 2,002 alternate, odd lines run and even lines never do, so no two lines in a list are consecutive:
    // 1,001 covered runs and 1,001 uncovered runs.
    const hits = new Map<number, number>();
    for (let line = 1; line <= 2 * (MAX_RANGES_PER_FILE + 1); line++) hits.set(line, line % 2);

    const result = lineRanges(hits);

    expect(result.lines).toEqual({ covered: 1001, total: 2002 });
    expect(result).not.toHaveProperty("ranges");
  });

  it("leaves out both lists when only the covered list passes the cap", () => {
    // 1,001 isolated covered lines (every second line) with the lines between them not mentioned: no uncovered runs.
    const hits = new Map<number, number>();
    for (let i = 0; i <= MAX_RANGES_PER_FILE; i++) hits.set(1 + 2 * i, 1);
    hits.set(2, 0);

    const result = lineRanges(hits);

    expect(result.lines).toEqual({ covered: 1001, total: 1002 });
    expect(result).not.toHaveProperty("ranges");
  });

  it("keeps both lists when each has exactly 1,000 ranges", () => {
    // Lines 1 to 2,000 alternate, giving 1,000 covered runs and 1,000 uncovered runs.
    const hits = new Map<number, number>();
    for (let line = 1; line <= 2 * MAX_RANGES_PER_FILE; line++) hits.set(line, line % 2);

    const result = lineRanges(hits);

    expect(result.ranges?.covered).toHaveLength(MAX_RANGES_PER_FILE);
    expect(result.ranges?.uncovered).toHaveLength(MAX_RANGES_PER_FILE);
    expect(result.lines).toEqual({ covered: 1000, total: 2000 });
  });
});

describe("parseLcov", () => {
  const trace = [
    "TN:",
    `SF:${RUNNER}/src/a.ts`,
    "FN:1,alpha",
    "FN:10,beta",
    "FNDA:3,alpha",
    "FNDA:0,beta",
    "FNF:2",
    "FNH:1",
    "DA:1,3",
    "DA:2,3",
    "DA:3,0",
    "DA:4,0",
    "DA:6,1,abc123",
    "LF:5",
    "LH:3",
    "BRDA:2,0,0,1",
    "BRDA:2,0,1,-",
    "BRF:2",
    "BRH:1",
    "end_of_record",
    "SF:src\\b.ts",
    "DA:1,0",
    "end_of_record",
  ].join("\n");

  it("reads lines, ranges, functions and branches per file", async () => {
    const files = await parseLcov(trace);

    expect(files).toEqual([
      {
        path: `${RUNNER}/src/a.ts`,
        lines: { covered: 3, total: 5 },
        ranges: {
          covered: [
            [1, 2],
            [6, 6],
          ],
          uncovered: [[3, 4]],
        },
        functions: { covered: 1, total: 2 },
        branches: { covered: 1, total: 2 },
      },
      { path: "src/b.ts", lines: { covered: 0, total: 1 }, ranges: { covered: [], uncovered: [[1, 1]] } },
    ]);
  });

  it("counts functions and branches from their own records when the totals are missing", async () => {
    const files = await parseLcov(
      [
        "SF:src/a.ts",
        "FN:1,alpha",
        "FN:5,beta",
        "FNDA:2,alpha",
        "BRDA:3,0,0,4",
        "BRDA:3,0,1,0",
        "BRDA:3,0,2,-",
        "end_of_record",
      ].join("\n"),
    );

    // One of two named functions ran; one of three branch arms was taken.
    expect(files[0]!.functions).toEqual({ covered: 1, total: 2 });
    expect(files[0]!.branches).toEqual({ covered: 1, total: 3 });
  });

  it("keeps only the totals for a file with no line records", async () => {
    const [file] = await parseLcov("SF:src/a.ts\nLF:40\nLH:30\nend_of_record\n");

    expect(file).toEqual({ path: "src/a.ts", lines: { covered: 30, total: 40 } });
  });

  it("combines a path that appears twice, taking the highest hit count per line", async () => {
    const files = await parseLcov(
      [
        "SF:src/a.ts",
        "DA:1,0",
        "DA:2,0",
        "FNF:1",
        "FNH:0",
        "end_of_record",
        "SF:src/a.ts",
        "DA:2,5",
        "FNF:1",
        "FNH:1",
        "end_of_record",
      ].join("\n"),
    );

    expect(files).toHaveLength(1);
    expect(files[0]!.ranges).toEqual({ covered: [[2, 2]], uncovered: [[1, 1]] });
    expect(files[0]!.functions).toEqual({ covered: 1, total: 1 });
  });

  it("takes the union of the functions two records of a file ran, not the larger total", async () => {
    const record = (alpha: number, beta: number) =>
      [
        "SF:src/a.ts",
        "FN:1,alpha",
        "FN:9,beta",
        `FNDA:${alpha},alpha`,
        `FNDA:${beta},beta`,
        "FNF:2",
        "FNH:1",
        "end_of_record",
      ].join("\n");

    const [file] = await parseLcov([record(1, 0), record(0, 1)].join("\n"));

    // Each record ran one of two functions, but not the same one, so together both ran.
    expect(file!.functions).toEqual({ covered: 2, total: 2 });
  });

  it("never reports fewer functions than a record says when a name repeats in the file", async () => {
    const record = (hit: number) =>
      [
        "SF:src/a.ts",
        "FN:1,constructor",
        "FN:10,constructor",
        "FN:20,render",
        `FNDA:${hit},constructor`,
        "FNDA:0,render",
        "FNF:3",
        `FNH:${hit === 0 ? 0 : 1}`,
        "end_of_record",
      ].join("\n");

    const [file] = await parseLcov(record(1));

    // Two names are distinct but the report says three functions, one run.
    expect(file!.functions).toEqual({ covered: 1, total: 3 });
    // FNH:2 (both constructors ran) is above the one distinct name that ran.
    const [both] = await parseLcov(record(1).replace("FNH:1", "FNH:2"));
    expect(both!.functions).toEqual({ covered: 2, total: 3 });
  });

  it("takes the union of the branch arms two records of a file took", async () => {
    const record = (first: string, second: string) =>
      ["SF:src/a.ts", `BRDA:4,0,0,${first}`, `BRDA:4,0,1,${second}`, "BRF:2", "BRH:1", "end_of_record"].join("\n");

    const [file] = await parseLcov([record("1", "-"), record("0", "3")].join("\n"));

    // Arm 0 was taken by the first record and arm 1 by the second: 2 of 2.
    expect(file!.branches).toEqual({ covered: 2, total: 2 });
  });

  it("counts a function seen only in FNDA, and reads the lcov 2.x FN form with a start and an end line", async () => {
    const [file] = await parseLcov(["SF:src/a.ts", "FN:3,5,alpha", "FNDA:1,alpha", "FNDA:0,gamma", "end_of_record"].join("\n"));

    // alpha matches its FNDA, so it is one function and not "5,alpha"; gamma is named only by FNDA and never ran.
    expect(file!.functions).toEqual({ covered: 1, total: 2 });
  });

  it("falls back to the larger of the totals when the records name no functions or branches", async () => {
    const [file] = await parseLcov(
      [
        "SF:src/a.ts",
        "FNF:3",
        "FNH:1",
        "BRF:4",
        "BRH:0",
        "end_of_record",
        "SF:src/a.ts",
        "FNF:2",
        "FNH:2",
        "BRF:6",
        "BRH:1",
        "end_of_record",
      ].join("\n"),
    );

    // Highest covered 2 and highest total 3 for functions; 1 and 6 for branches.
    expect(file!.functions).toEqual({ covered: 2, total: 3 });
    expect(file!.branches).toEqual({ covered: 1, total: 6 });
  });

  it("drops totals that cannot be true", async () => {
    const [file] = await parseLcov(
      ["SF:src/a.ts", "LF:3", "LH:5", "FNF:1", "FNH:2", "BRF:-1", "BRH:0", "end_of_record"].join("\n"),
    );

    expect(file).toEqual({ path: "src/a.ts", lines: { covered: 0, total: 0 } });
  });

  it("drops an impossible total but keeps what the function and branch records say", async () => {
    const [file] = await parseLcov(["SF:src/a.ts", "FNF:1", "FNH:2", "FN:1,alpha", "FNDA:1,alpha", "end_of_record"].join("\n"));

    expect(file!.functions).toEqual({ covered: 1, total: 1 });
  });

  it("keeps a record that has no end_of_record, and one cut off by the next file", async () => {
    const files = await parseLcov("SF:src/a.ts\nDA:1,1\nSF:src/b.ts\nDA:1,0\n");

    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[1]!.ranges?.uncovered).toEqual([[1, 1]]);
  });

  it("ignores malformed records and lines before any file", async () => {
    const files = await parseLcov(
      "DA:1,1\nrubbish\nSF:src/a.ts\nDA:x,1\nDA:2,y\nDA:3,1\nBRDA:1,0,0\nend_of_record\nSF:\nend_of_record",
    );

    expect(files).toHaveLength(1);
    expect(files[0]!.lines).toEqual({ covered: 1, total: 1 });
  });

  it("yields to the event loop while reading a report of more than YIELD_EVERY files", async () => {
    const text = Array.from({ length: YIELD_EVERY + 50 }, (_, i) => `SF:src/f${i}.ts\nDA:1,1\nend_of_record`).join("\n");

    expect(await yieldsDuring(() => parseLcov(text))).toBe(true);
    expect(await parseLcov(text)).toHaveLength(YIELD_EVERY + 50);
  });
});

describe("parseIstanbulFinal", () => {
  const entry = (extra: object = {}) => ({
    path: `${RUNNER}/src/a.ts`,
    statementMap: {
      "0": { start: { line: 1 }, end: { line: 1 } },
      "1": { start: { line: 2 }, end: { line: 2 } },
      "2": { start: { line: 2 }, end: { line: 3 } },
      "3": { start: { line: 5 }, end: { line: 5 } },
    },
    s: { "0": 1, "1": 0, "2": 4, "3": 0 },
    f: { "0": 2, "1": 0 },
    b: { "0": [1, 0], "1": [0, 0, 2] },
    ...extra,
  });

  it("takes the highest statement count among those starting on a line", async () => {
    const files = await parseIstanbulFinal(JSON.stringify({ key: entry() }));

    // Line 2 has statements run 0 and 4 times, so it ran. Lines: 1 and 2 ran, 5 did not.
    expect(files).toEqual([
      {
        path: `${RUNNER}/src/a.ts`,
        lines: { covered: 2, total: 3 },
        ranges: { covered: [[1, 2]], uncovered: [[5, 5]] },
        functions: { covered: 1, total: 2 },
        // Arms: [1,0] and [0,0,2] make 5, of which two were taken.
        branches: { covered: 2, total: 5 },
      },
    ]);
  });

  it("falls back to the key when the entry has no path, and normalises separators", async () => {
    const files = await parseIstanbulFinal(JSON.stringify({ "src\\a.ts": entry({ path: undefined, f: {}, b: {} }) }));

    expect(files[0]!.path).toBe("src/a.ts");
    expect(files[0]).not.toHaveProperty("functions");
    expect(files[0]).not.toHaveProperty("branches");
  });

  it("skips entries without a statement map and statements without a line", async () => {
    const files = await parseIstanbulFinal(
      JSON.stringify({
        a: { path: "src/a.ts" },
        b: "text",
        c: entry({ statementMap: { "0": { start: {} }, "1": null }, s: { "0": 1 }, f: [], b: { "0": "x" } }),
      }),
    );

    expect(files).toHaveLength(1);
    expect(files[0]!.lines).toEqual({ covered: 0, total: 0 });
  });

  it.each(["not json", "[]", "3"])("refuses %s", async (text) => {
    await expect(parseIstanbulFinal(text)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("merges entries for one file: highest hit per line, each function and arm once, run if any copy ran", async () => {
    const at = (line: number, column = 0) => ({ start: { line, column }, end: { line, column: column + 1 } });
    const copy = (path: string, lineOne: number, functionHits: number[], arms: number[]) => ({
      path,
      statementMap: { "0": at(1), "1": at(2) },
      s: { "0": lineOne, "1": 1 },
      fnMap: { "0": { name: "f", decl: at(1) }, "1": { name: "g", decl: at(5) } },
      f: { "0": functionHits[0], "1": functionHits[1] },
      branchMap: { "0": { loc: at(2, 4) } },
      b: { "0": arms },
    });

    const files = await parseIstanbulFinal(
      JSON.stringify({ one: copy("src/a.ts", 0, [1, 0], [1, 0]), two: copy("src\\a.ts", 2, [0, 2], [0, 3]) }),
    );

    // Line 1 ran in the second copy only, line 2 in both: 2 of 2. Each function ran in one copy: 2 of 2. Arm 0 in the
    // first copy and arm 1 in the second: 2 of 2.
    expect(files).toEqual([
      {
        path: "src/a.ts",
        lines: { covered: 2, total: 2 },
        ranges: { covered: [[1, 2]], uncovered: [] },
        functions: { covered: 2, total: 2 },
        branches: { covered: 2, total: 2 },
      },
    ]);
  });

  it("tells branches of different types apart when they start at the same place", async () => {
    const loc = { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } };
    const [file] = await parseIstanbulFinal(
      JSON.stringify({
        a: {
          path: "src/a.ts",
          statementMap: { "0": { start: { line: 1 } } },
          s: { "0": 1 },
          branchMap: { "0": { type: "cond-expr", loc }, "1": { type: "binary-expr", loc } },
          b: { "0": [1, 0], "1": [1, 0] },
        },
      }),
    );

    // `a && b ? c : d`: two arms of each kind, one taken in each, so 2 of 4.
    expect(file!.branches).toEqual({ covered: 2, total: 4 });
  });

  it("leaves out the ranges and keeps exact counts for a file with more runs of lines than are kept", async () => {
    // Statements on odd lines 1 to 2,003 run and those on even lines 2 to 2,002 never do: 1,002 and 1,001 runs.
    const statementMap: { [id: string]: object } = {};
    const s: { [id: string]: number } = {};
    for (let line = 1; line <= 2003; line++) {
      statementMap[String(line)] = { start: { line } };
      s[String(line)] = line % 2;
    }

    const [file] = await parseIstanbulFinal(JSON.stringify({ a: { path: "src/a.ts", statementMap, s } }));

    expect(file!.lines).toEqual({ covered: 1002, total: 2003 });
    expect(file).not.toHaveProperty("ranges");
  });

  it("yields to the event loop while reading more than YIELD_EVERY entries", async () => {
    const many = Object.fromEntries(
      Array.from({ length: YIELD_EVERY + 50 }, (_, i) => [`src/f${i}.ts`, entry({ path: `src/f${i}.ts` })]),
    );
    const text = JSON.stringify(many);

    expect(await yieldsDuring(() => parseIstanbulFinal(text))).toBe(true);
    expect(await parseIstanbulFinal(text)).toHaveLength(YIELD_EVERY + 50);
  });
});

describe("parseIstanbulSummary", () => {
  it("reads totals per file, skips the overall total and leaves out empty branch counts", async () => {
    const files = await parseIstanbulSummary(
      JSON.stringify({
        total: { lines: { total: 100, covered: 50, pct: 50 } },
        "src/a.ts": {
          lines: { total: 10, covered: 7, pct: 70 },
          functions: { total: 2, covered: 1, pct: 50 },
          branches: { total: 0, covered: 0, pct: 100 },
        },
        "src/b.ts": { lines: { total: 4, covered: 4 }, functions: { total: 0, covered: 0 }, branches: { total: 6, covered: 3 } },
        "src/c.ts": { statements: { total: 1, covered: 1 } },
        "src/d.ts": "text",
      }),
    );

    expect(files).toEqual([
      { path: "src/a.ts", lines: { covered: 7, total: 10 }, functions: { covered: 1, total: 2 } },
      { path: "src/b.ts", lines: { covered: 4, total: 4 }, branches: { covered: 3, total: 6 } },
    ]);
  });

  it("refuses text that is not a JSON object, keeping the reason as the cause", async () => {
    const error = await parseIstanbulSummary("{").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).cause).toBeInstanceOf(SyntaxError);
  });

  it("drops a file whose line count is impossible, and leaves out impossible function and branch counts", async () => {
    const files = await parseIstanbulSummary(
      JSON.stringify({
        "src/a.ts": { lines: { total: 2, covered: 3 } },
        "src/b.ts": { lines: { total: 2, covered: -1 } },
        "src/c.ts": { lines: { total: 2.5, covered: 1 } },
        "src/d.ts": { lines: { total: 4, covered: 2 }, functions: { total: 1, covered: 2 }, branches: { total: 3, covered: 1 } },
      }),
    );

    expect(files).toEqual([{ path: "src/d.ts", lines: { covered: 2, total: 4 }, branches: { covered: 1, total: 3 } }]);
  });

  it("keeps the entry with more lines covered when two entries are for one path, and the higher other counts", async () => {
    const files = await parseIstanbulSummary(
      JSON.stringify({
        "src/a.ts": { lines: { total: 10, covered: 4 }, functions: { total: 3, covered: 3 }, branches: { total: 2, covered: 0 } },
        "src\\a.ts": { lines: { total: 8, covered: 6 }, functions: { total: 4, covered: 1 }, branches: { total: 4, covered: 3 } },
      }),
    );

    // Lines from the second (6 covered beats 4), functions from the first (3 beats 1), branches from the second (3 beats 0).
    expect(files).toEqual([
      {
        path: "src/a.ts",
        lines: { covered: 6, total: 8 },
        functions: { covered: 3, total: 3 },
        branches: { covered: 3, total: 4 },
      },
    ]);
  });

  it("yields to the event loop while reading more than YIELD_EVERY entries", async () => {
    const many = Object.fromEntries(
      Array.from({ length: YIELD_EVERY + 50 }, (_, i) => [`src/f${i}.ts`, { lines: { total: 1, covered: 1 } }]),
    );
    const text = JSON.stringify(many);

    expect(await yieldsDuring(() => parseIstanbulSummary(text))).toBe(true);
    expect(await parseIstanbulSummary(text)).toHaveLength(YIELD_EVERY + 50);
  });
});

describe("parseCobertura", () => {
  const xml = `<?xml version="1.0" ?>
<coverage line-rate="0.5" branch-rate="0.5" version="1">
  <sources><source>${RUNNER}/packages/ui</source></sources>
  <packages>
    <package name="ui">
      <classes>
        <class name="Button" filename="src/Button.ts" line-rate="0.5">
          <methods>
            <method name="render"><lines><line number="1" hits="2"/></lines></method>
            <method name="idle"><lines><line number="4" hits="0"/></lines></method>
          </methods>
          <lines>
            <line number="1" hits="2"/>
            <line number="2" hits="0" branch="true" condition-coverage="50% (1/2)"/>
            <line number="4" hits="0"/>
          </lines>
        </class>
        <class name="Button.Inner" filename="src/Button.ts">
          <methods/>
          <lines><line number="2" hits="3" branch="true"/><line number="6" hits="1"/></lines>
        </class>
        <class name="Other" filename="src\\Other.ts"><lines><line number="1" hits="1"/></lines></class>
        <class name="NoFile"><lines><line number="1" hits="1"/></lines></class>
      </classes>
    </package>
  </packages>
</coverage>`;

  it("merges classes sharing a file and reads source roots, methods and condition coverage", async () => {
    const { files, sourceRoots } = await parseCobertura(xml);

    expect(sourceRoots).toEqual([`${RUNNER}/packages/ui`]);
    // Button.ts: line 2 is 0 then 3, so the higher wins. Lines 1, 2, 6 ran and 4 did not.
    expect(files).toEqual([
      {
        path: "src/Button.ts",
        lines: { covered: 3, total: 4 },
        ranges: {
          covered: [
            [1, 2],
            [6, 6],
          ],
          uncovered: [[4, 4]],
        },
        functions: { covered: 1, total: 2 },
        branches: { covered: 1, total: 2 },
      },
      { path: "src/Other.ts", lines: { covered: 1, total: 1 }, ranges: { covered: [[1, 1]], uncovered: [] } },
    ]);
  });

  it("keeps the better condition coverage when a merged line reports it twice", async () => {
    const { files } = await parseCobertura(
      `<coverage line-rate="1"><packages><package><classes>
        <class filename="a.ts"><lines><line number="1" hits="1" condition-coverage="0% (0/2)"/></lines></class>
        <class filename="a.ts"><lines><line number="1" hits="1" condition-coverage="100% (2/2)"/></lines></class>
        <class filename="a.ts"><lines><line number="1" hits="1" condition-coverage="50% (1/2)"/><line number="x" hits="1"/></lines></class>
      </classes></package></packages></coverage>`,
    );

    expect(files[0]!.branches).toEqual({ covered: 2, total: 2 });
  });

  it("reads a report with no sources, packages or classes", async () => {
    expect(await parseCobertura('<coverage line-rate="0"><packages/></coverage>')).toEqual({ files: [], sourceRoots: [] });
    expect(await parseCobertura('<coverage line-rate="0"><sources><source> </source></sources></coverage>')).toEqual({
      files: [],
      sourceRoots: [],
    });
  });

  it("reads the header that Istanbul writes, a DOCTYPE naming an external DTD that is never fetched", async () => {
    const text = [
      '<?xml version="1.0" ?>',
      '<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">',
      '<coverage line-rate="1"><packages><package><classes>',
      '<class filename="a.ts"><lines><line number="1" hits="1"/></lines></class>',
      "</classes></package></packages></coverage>",
    ].join("\n");

    const { files } = await parseCobertura(text);

    expect(files).toEqual([{ path: "a.ts", lines: { covered: 1, total: 1 }, ranges: { covered: [[1, 1]], uncovered: [] } }]);
  });

  it("reads a DOCTYPE with a PUBLIC identifier", async () => {
    const text = '<!DOCTYPE coverage PUBLIC "-//x//DTD//EN" "http://localhost/x.dtd"><coverage line-rate="1"/>';

    expect((await parseCobertura(text)).files).toEqual([]);
  });

  it.each([
    ['<!DOCTYPE x [<!ENTITY a "aaaa">]><coverage line-rate="1">&a;</coverage>'],
    ['<!DOCTYPE coverage SYSTEM "http://localhost/x.dtd" [ ]><coverage line-rate="1"/>'],
    ['<!DOCTYPE coverage [ ]><coverage line-rate="1"/>'],
    ['<!DOCTYPE coverage SYSTEM "a.dtd"><!DOCTYPE b [ ]><coverage line-rate="1"/>'],
    ['<coverage line-rate="1"><!ENTITY a "b"></coverage>'],
  ])("refuses an internal subset or entity declaration before parsing %#", async (text) => {
    await expect(parseCobertura(text)).rejects.toThrow(/document type declaration/);
  });

  it("reads a report whose comment mentions an entity or an internal subset", async () => {
    const text = '<!-- <!ENTITY a "b"> and <!DOCTYPE x [ --><coverage line-rate="1"><packages/></coverage>';

    expect(await parseCobertura(text)).toEqual({ files: [], sourceRoots: [] });
  });

  it("still refuses an entity declared after a comment", async () => {
    const text = '<!-- harmless --><!DOCTYPE x [<!ENTITY a "b">]><coverage line-rate="1"/>';

    await expect(parseCobertura(text)).rejects.toThrow(/document type declaration/);
  });

  it("refuses a report cut off inside its second class, rather than reading it as a shorter one", async () => {
    const whole = `<coverage line-rate="1"><packages><package><classes>
      <class filename="a.ts"><lines><line number="1" hits="1"/></lines></class>
      <class filename="b.ts"><lines><line number="1" hits="1"/></lines></class>
    </classes></package></packages></coverage>`;
    const cut = whole.slice(0, whole.indexOf('<line number="1" hits="1"/>', whole.indexOf("b.ts")));

    const error = await parseCobertura(cut).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).message).toBe("A coverage file in the artefact is not valid XML");
    expect((error as UpstreamError).cause).toBeDefined();
  });

  it("refuses a report with a mismatched closing tag", async () => {
    const text = '<coverage line-rate="1"><packages><package></packages></package></coverage>';

    await expect(parseCobertura(text)).rejects.toThrow("not valid XML");
  });

  it("counts a method once when its class is listed under two packages, and as run if any copy ran", async () => {
    const klass = (hits: number) => `<class filename="src/a.ts"><methods>
        <method name="render" signature="()V"><lines><line number="3" hits="${hits}"/></lines></method>
      </methods><lines><line number="3" hits="${hits}"/></lines></class>`;
    const text = `<coverage line-rate="1"><packages>
      <package name="one"><classes>${klass(0)}</classes></package>
      <package name="two"><classes>${klass(4)}</classes></package>
    </packages></coverage>`;

    const { files } = await parseCobertura(text);

    expect(files[0]!.functions).toEqual({ covered: 1, total: 1 });
  });

  it("tells methods apart by name, signature and first line", async () => {
    const text = `<coverage line-rate="1"><packages><package><classes><class filename="a.ts"><methods>
      <method name="m" signature="(I)V"><lines><line number="1" hits="1"/></lines></method>
      <method name="m" signature="(S)V"><lines><line number="1" hits="0"/></lines></method>
      <method name="m" signature="(I)V"><lines><line number="9" hits="0"/></lines></method>
    </methods></class></classes></package></packages></coverage>`;

    const { files } = await parseCobertura(text);

    // Three distinct keys, of which only the first ran.
    expect(files[0]!.functions).toEqual({ covered: 1, total: 3 });
  });

  it("drops a condition coverage that cannot be true", async () => {
    const { files } = await parseCobertura(
      `<coverage line-rate="1"><packages><package><classes><class filename="a.ts"><lines>
        <line number="1" hits="1" condition-coverage="100% (3/2)"/>
        <line number="2" hits="1" condition-coverage="50% (1/2)"/>
      </lines></class></classes></package></packages></coverage>`,
    );

    expect(files[0]!.branches).toEqual({ covered: 1, total: 2 });
  });

  it("refuses text that is not a Cobertura report", async () => {
    await expect(parseCobertura("just text")).rejects.toBeInstanceOf(UpstreamError);
    await expect(parseCobertura("<report><a/></report>")).rejects.toThrow(/not a Cobertura report/);
  });

  it("yields to the event loop while reading more than YIELD_EVERY classes", async () => {
    const classes = Array.from(
      { length: YIELD_EVERY + 50 },
      (_, i) => `<class filename="f${i}.ts"><lines><line number="1" hits="1"/></lines></class>`,
    );
    const text = `<coverage line-rate="1"><packages><package><classes>${classes.join("")}</classes></package></packages></coverage>`;

    expect(await yieldsDuring(() => parseCobertura(text))).toBe(true);
    expect((await parseCobertura(text)).files).toHaveLength(YIELD_EVERY + 50);
  });
});
