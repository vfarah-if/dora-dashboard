import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/core/errors.js";
import { lineRanges, MAX_RANGES_PER_FILE } from "../src/infrastructure/coverage-reports/line-ranges.js";
import { parseCobertura } from "../src/infrastructure/coverage-reports/parse-cobertura.js";
import { parseIstanbulFinal, parseIstanbulSummary } from "../src/infrastructure/coverage-reports/parse-istanbul.js";
import { parseLcov } from "../src/infrastructure/coverage-reports/parse-lcov.js";

const RUNNER = "/home/runner/work/widgets/widgets";

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
      covered: [
        [1, 2],
        [6, 6],
      ],
      uncovered: [[3, 4]],
    });
  });

  it("does not join across a line the report does not mention", () => {
    const result = lineRanges(
      new Map([
        [1, 0],
        [3, 0],
      ]),
    );

    expect(result.uncovered).toEqual([
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
    expect(result.covered).toEqual([[7, 7]]);
  });

  it("stores at most 1,000 ranges per list while the counts stay exact", () => {
    // Odd lines run and even lines never do, so no two lines in a list are consecutive: 1,500 ranges in each.
    const hits = new Map<number, number>();
    for (let line = 1; line <= 3000; line++) hits.set(line, line % 2);

    const result = lineRanges(hits);

    expect(result.lines).toEqual({ covered: 1500, total: 3000 });
    expect(result.covered).toHaveLength(MAX_RANGES_PER_FILE);
    expect(result.uncovered).toHaveLength(MAX_RANGES_PER_FILE);
    expect(result.covered[0]).toEqual([1, 1]);
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
        covered: [
          [1, 2],
          [6, 6],
        ],
        uncovered: [[3, 4]],
        functions: { covered: 1, total: 2 },
        branches: { covered: 1, total: 2 },
      },
      { path: "src/b.ts", lines: { covered: 0, total: 1 }, covered: [], uncovered: [[1, 1]] },
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
    expect(files[0]!.covered).toEqual([[2, 2]]);
    expect(files[0]!.uncovered).toEqual([[1, 1]]);
    expect(files[0]!.functions).toEqual({ covered: 1, total: 1 });
  });

  it("keeps a record that has no end_of_record, and one cut off by the next file", async () => {
    const files = await parseLcov("SF:src/a.ts\nDA:1,1\nSF:src/b.ts\nDA:1,0\n");

    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[1]!.uncovered).toEqual([[1, 1]]);
  });

  it("ignores malformed records and lines before any file", async () => {
    const files = await parseLcov(
      "DA:1,1\nrubbish\nSF:src/a.ts\nDA:x,1\nDA:2,y\nDA:3,1\nBRDA:1,0,0\nend_of_record\nSF:\nend_of_record",
    );

    expect(files).toHaveLength(1);
    expect(files[0]!.lines).toEqual({ covered: 1, total: 1 });
  });

  it("reads a large report in full while yielding to the event loop", async () => {
    const text = Array.from({ length: 450 }, (_, i) => `SF:src/f${i}.ts\nDA:1,1\nend_of_record`).join("\n");

    expect(await parseLcov(text)).toHaveLength(450);
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
        covered: [[1, 2]],
        uncovered: [[5, 5]],
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

  it("reads a large report in full while yielding to the event loop", async () => {
    const many = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`src/f${i}.ts`, entry()]));

    expect(await parseIstanbulFinal(JSON.stringify(many))).toHaveLength(450);
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

  it("refuses text that is not a JSON object", async () => {
    await expect(parseIstanbulSummary("{")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("reads a large report in full while yielding to the event loop", async () => {
    const many = Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`src/f${i}.ts`, { lines: { total: 1, covered: 1 } }]));

    expect(await parseIstanbulSummary(JSON.stringify(many))).toHaveLength(450);
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
        covered: [
          [1, 2],
          [6, 6],
        ],
        uncovered: [[4, 4]],
        functions: { covered: 1, total: 2 },
        branches: { covered: 1, total: 2 },
      },
      { path: "src/Other.ts", lines: { covered: 1, total: 1 }, covered: [[1, 1]], uncovered: [] },
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

  it.each([
    ['<!DOCTYPE coverage SYSTEM "http://localhost/x.dtd"><coverage line-rate="1"/>'],
    ['<!DOCTYPE x [<!ENTITY a "aaaa">]><coverage line-rate="1">&a;</coverage>'],
    ['<!doctype coverage><coverage line-rate="1"/>'],
    ['<coverage line-rate="1"><!ENTITY a "b"></coverage>'],
  ])("refuses a document type or entity declaration before parsing %#", async (text) => {
    await expect(parseCobertura(text)).rejects.toThrow(/document type declaration/);
  });

  it("refuses text that is not a Cobertura report", async () => {
    await expect(parseCobertura("just text")).rejects.toBeInstanceOf(UpstreamError);
    await expect(parseCobertura("<report><a/></report>")).rejects.toThrow(/not a Cobertura report/);
  });

  it("reads a large report in full while yielding to the event loop", async () => {
    const classes = Array.from(
      { length: 450 },
      (_, i) => `<class filename="f${i}.ts"><lines><line number="1" hits="1"/></lines></class>`,
    );
    const text = `<coverage line-rate="1"><packages><package><classes>${classes.join("")}</classes></package></packages></coverage>`;

    expect((await parseCobertura(text)).files).toHaveLength(450);
  });
});
