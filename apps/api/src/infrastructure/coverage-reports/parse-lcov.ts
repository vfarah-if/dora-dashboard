import type { CoverageFileReport } from "@dora-dashboard/core";
import { addHit, lineRanges } from "./line-ranges.js";
import { YIELD_EVERY, yieldToEventLoop } from "./yield-loop.js";

interface Tally {
  hits: Map<number, number>;
  linesFound: number | null;
  linesHit: number | null;
  functionsFound: number | null;
  functionsHit: number | null;
  branchesFound: number | null;
  branchesHit: number | null;
  /** Function names seen in `FN`, and those with a count above zero in `FNDA`, for a report that has no `FNF`. */
  functionNames: Set<string>;
  functionsRun: Set<string>;
  branchLines: number;
  branchesTaken: number;
}

const newRecord = (): Tally => ({
  hits: new Map(),
  linesFound: null,
  linesHit: null,
  functionsFound: null,
  functionsHit: null,
  branchesFound: null,
  branchesHit: null,
  functionNames: new Set(),
  functionsRun: new Set(),
  branchLines: 0,
  branchesTaken: 0,
});

const whole = (text: string | undefined): number | null => {
  const value = Number(text);
  return text !== undefined && text.trim() !== "" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
};

/** Paths are kept as the report wrote them apart from separators; `alignCoverage` does the rest. */
const normalise = (path: string): string => path.trim().replace(/\\/g, "/");

function merge(into: Tally, from: Tally): void {
  for (const [line, count] of from.hits) addHit(into.hits, line, count);
  for (const key of ["linesFound", "linesHit", "functionsFound", "functionsHit", "branchesFound", "branchesHit"] as const) {
    if (from[key] !== null) into[key] = Math.max(into[key] ?? 0, from[key]!);
  }
  for (const name of from.functionNames) into.functionNames.add(name);
  for (const name of from.functionsRun) into.functionsRun.add(name);
  into.branchLines = Math.max(into.branchLines, from.branchLines);
  into.branchesTaken = Math.max(into.branchesTaken, from.branchesTaken);
}

function toReport(path: string, record: Tally): CoverageFileReport {
  const file: CoverageFileReport = { path, lines: { covered: record.linesHit ?? 0, total: record.linesFound ?? 0 } };
  if (record.hits.size > 0) {
    const ranges = lineRanges(record.hits);
    file.lines = ranges.lines;
    file.covered = ranges.covered;
    file.uncovered = ranges.uncovered;
  }
  const functions =
    record.functionsFound !== null
      ? { covered: record.functionsHit ?? 0, total: record.functionsFound }
      : { covered: record.functionsRun.size, total: record.functionNames.size };
  if (functions.total > 0) file.functions = functions;
  const branches =
    record.branchesFound !== null
      ? { covered: record.branchesHit ?? 0, total: record.branchesFound }
      : { covered: record.branchesTaken, total: record.branchLines };
  if (branches.total > 0) file.branches = branches;
  return file;
}

/**
 * Reads an lcov tracefile. Line hits come from `DA` records and, when a file has none, only the `LF` and `LH` totals
 * are kept, so such a file has counts and no ranges. A path that appears in several records (a merged report) is
 * combined, taking the highest hit count of each line.
 */
export async function parseLcov(text: string): Promise<CoverageFileReport[]> {
  const records = new Map<string, Tally>();
  let path: string | null = null;
  let current = newRecord();
  let seen = 0;

  const flush = async (): Promise<void> => {
    if (path !== null && path !== "") {
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
        current.linesFound = whole(value);
        break;
      case "LH":
        current.linesHit = whole(value);
        break;
      case "FNF":
        current.functionsFound = whole(value);
        break;
      case "FNH":
        current.functionsHit = whole(value);
        break;
      case "FN": {
        const name = value.slice(value.indexOf(",") + 1);
        current.functionNames.add(name);
        break;
      }
      case "FNDA": {
        const comma = value.indexOf(",");
        if ((whole(value.slice(0, comma)) ?? 0) > 0) current.functionsRun.add(value.slice(comma + 1));
        break;
      }
      case "BRF":
        current.branchesFound = whole(value);
        break;
      case "BRH":
        current.branchesHit = whole(value);
        break;
      case "BRDA": {
        const taken = value.split(",")[3];
        current.branchLines++;
        if (taken !== undefined && taken !== "-" && (whole(taken) ?? 0) > 0) current.branchesTaken++;
        break;
      }
    }
  }
  await flush();
  return [...records].map(([name, record]) => toReport(name, record));
}
