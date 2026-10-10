import { coverageCount, type CoverageCount, type CoverageFileReport } from "@dora-dashboard/core";
import { addHit, lineRanges } from "./line-ranges.js";
import { YIELD_EVERY, yieldToEventLoop } from "./yield-loop.js";

interface Tally {
  hits: Map<number, number>;
  /** The `LF` and `LH` totals, `FNF` and `FNH`, `BRF` and `BRH` as written, until the record ends and they are checked. */
  raw: { [tag: string]: number };
  /** The checked totals, null when a report did not give a pair or gave an impossible one. */
  lines: CoverageCount | null;
  functions: CoverageCount | null;
  branches: CoverageCount | null;
  /** Every function named in `FN` or `FNDA`, and those with a count above zero in `FNDA`. */
  functionNames: Set<string>;
  functionsRun: Set<string>;
  /** Each branch arm by line, block and branch number, true when taken. */
  branchArms: Map<string, boolean>;
}

const newRecord = (): Tally => ({
  hits: new Map(),
  raw: {},
  lines: null,
  functions: null,
  branches: null,
  functionNames: new Set(),
  functionsRun: new Set(),
  branchArms: new Map(),
});

const whole = (text: string | undefined): number | null => {
  const value = Number(text);
  return text !== undefined && text.trim() !== "" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
};

/** A number exactly as written, or NaN, so that `coverageCount` can refuse a negative or fractional one. */
const exact = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

/** Paths are kept as the report wrote them apart from separators; `alignCoverage` does the rest. */
const normalise = (path: string): string => path.trim().replace(/\\/g, "/");

/** The name in an `FN` record: `FN:<line>,<name>`, or `FN:<start>,<end>,<name>` as lcov 2.x writes it. */
function functionName(value: string): string {
  const first = value.indexOf(",");
  const second = value.indexOf(",", first + 1);
  const twoNumbers =
    second > first && /^\d+$/.test(value.slice(0, first).trim()) && /^\d+$/.test(value.slice(first + 1, second).trim());
  return value.slice((twoNumbers ? second : first) + 1);
}

/** Checks the totals a record gave, once the record is complete. A pair that is impossible is dropped. */
function seal(record: Tally): void {
  const pair = (covered: string, total: string) => {
    const [c, t] = [record.raw[covered], record.raw[total]];
    return c === undefined || t === undefined ? null : coverageCount(c, t);
  };
  record.lines = pair("LH", "LF");
  record.functions = pair("FNH", "FNF");
  record.branches = pair("BRH", "BRF");
}

const larger = (a: CoverageCount | null, b: CoverageCount | null): CoverageCount | null =>
  !a || !b ? (a ?? b) : { covered: Math.max(a.covered, b.covered), total: Math.max(a.total, b.total) };

function merge(into: Tally, from: Tally): void {
  for (const [line, count] of from.hits) addHit(into.hits, line, count);
  into.lines = larger(into.lines, from.lines);
  into.functions = larger(into.functions, from.functions);
  into.branches = larger(into.branches, from.branches);
  for (const name of from.functionNames) into.functionNames.add(name);
  for (const name of from.functionsRun) into.functionsRun.add(name);
  for (const [arm, taken] of from.branchArms) into.branchArms.set(arm, (into.branchArms.get(arm) ?? false) || taken);
}

/** The larger of a reported count and what the lines of the record add up to, with covered never above total. */
function joined(reported: CoverageCount | null, seen: number, ran: number): CoverageCount {
  const total = Math.max(reported?.total ?? 0, seen);
  return { covered: Math.min(Math.max(reported?.covered ?? 0, ran), total), total };
}

function toReport(path: string, record: Tally): CoverageFileReport {
  const file: CoverageFileReport = { path, lines: record.lines ?? { covered: 0, total: 0 } };
  if (record.hits.size > 0) {
    const detail = lineRanges(record.hits);
    file.lines = detail.lines;
    if (detail.ranges) file.ranges = detail.ranges;
  }
  // Records of one file can run different functions and take different branches, so the lines that name them can say more
  // than any one record's totals. Neither is trusted alone: the figure is the larger of the highest valid total a record
  // gave and the distinct names (or arms) seen, so it never falls below what one record says and still joins disjoint
  // runs. Names can repeat in a file (two constructors), which is why the totals matter; arms are keyed by line.
  const functions = joined(record.functions, record.functionNames.size, record.functionsRun.size);
  if (functions.total > 0) file.functions = functions;
  const taken = [...record.branchArms.values()].filter(Boolean).length;
  const branches = joined(record.branches, record.branchArms.size, taken);
  if (branches.total > 0) file.branches = branches;
  return file;
}

/**
 * Reads an lcov tracefile. Line hits come from `DA` records and, when a file has none, only the `LF` and `LH` totals
 * are kept, so such a file has counts and no ranges. A path that appears in several records (a merged report) is
 * combined: the highest hit count of each line, the union of the functions and branch arms the records name, and the
 * larger of their totals only where they name none. Counts that cannot be true (more covered than there are) are dropped.
 */
export async function parseLcov(text: string): Promise<CoverageFileReport[]> {
  const records = new Map<string, Tally>();
  let path: string | null = null;
  let current = newRecord();
  let seen = 0;

  const flush = async (): Promise<void> => {
    if (path !== null && path !== "") {
      seal(current);
      const existing = records.get(path);
      if (existing) merge(existing, current);
      else records.set(path, current);
      if (++seen % YIELD_EVERY === 0) await yieldToEventLoop();
    }
    path = null;
    current = newRecord();
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    if (line === "end_of_record") {
      await flush();
      continue;
    }
    if (colon < 0) continue;
    const tag = line.slice(0, colon);
    const value = line.slice(colon + 1);
    switch (tag) {
      case "SF":
        // A record cut off by the next file is kept, and anything before the first file belongs to no file.
        if (path !== null) await flush();
        else current = newRecord();
        path = normalise(value);
        break;
      case "DA": {
        const [number, count] = value.split(",");
        const at = whole(number);
        const hits = whole(count);
        if (at !== null && hits !== null) addHit(current.hits, at, hits);
        break;
      }
      case "LF":
      case "LH":
      case "FNF":
      case "FNH":
      case "BRF":
      case "BRH":
        current.raw[tag] = exact(value);
        break;
      case "FN":
        current.functionNames.add(functionName(value));
        break;
      case "FNDA": {
        const comma = value.indexOf(",");
        const name = value.slice(comma + 1);
        current.functionNames.add(name);
        if ((whole(value.slice(0, comma)) ?? 0) > 0) current.functionsRun.add(name);
        break;
      }
      case "BRDA": {
        const [at, block, branch, taken] = value.split(",");
        if (taken === undefined) break;
        const key = `${at},${block},${branch}`;
        const hit = taken !== "-" && (whole(taken) ?? 0) > 0;
        current.branchArms.set(key, (current.branchArms.get(key) ?? false) || hit);
        break;
      }
    }
  }
  await flush();
  return [...records].map(([name, record]) => toReport(name, record));
}
