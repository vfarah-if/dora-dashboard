import type { CoverageCount, CoverageFileReport } from "@dora-dashboard/core";
import { UpstreamError } from "../../core/errors.js";
import { addHit, lineRanges } from "./line-ranges.js";
import { YIELD_EVERY, yieldToEventLoop } from "./yield-loop.js";

type Node = { [key: string]: unknown };

const isObject = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

const normalise = (path: string): string => path.trim().replace(/\\/g, "/");

const unreadable = () => new UpstreamError("A coverage file in the artefact is not valid JSON of the expected shape", 502);

function parseJson(text: string): Node {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadable();
  }
  if (!isObject(value)) throw unreadable();
  return value;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A count that is kept only when there is something to count, as a file with no branches has no branch figure. */
const optional = (covered: number, total: number): CoverageCount | undefined => (total > 0 ? { covered, total } : undefined);

function fromFinal(key: string, entry: Node): CoverageFileReport | null {
  const statements = entry.statementMap;
  const hitsById = entry.s;
  if (!isObject(statements) || !isObject(hitsById)) return null;
  // A line is as covered as its most-run statement that starts on it.
  const hits = new Map<number, number>();
  for (const [id, location] of Object.entries(statements)) {
    const line = isObject(location) && isObject(location.start) ? location.start.line : undefined;
    if (typeof line === "number") addHit(hits, line, count(hitsById[id]));
  }
  const ranges = lineRanges(hits);
  const file: CoverageFileReport = {
    path: normalise(typeof entry.path === "string" && entry.path !== "" ? entry.path : key),
    lines: ranges.lines,
    covered: ranges.covered,
    uncovered: ranges.uncovered,
  };
  const functionHits = isObject(entry.f) ? Object.values(entry.f).map(count) : [];
  const functions = optional(functionHits.filter((n) => n > 0).length, functionHits.length);
  if (functions) file.functions = functions;
  const branchHits = isObject(entry.b) ? Object.values(entry.b).flatMap((a) => (Array.isArray(a) ? a.map(count) : [])) : [];
  const branches = optional(branchHits.filter((n) => n > 0).length, branchHits.length);
  if (branches) file.branches = branches;
  return file;
}

/** Reads Istanbul's `coverage-final.json`: line hits are the highest statement count among those starting on the line. */
export async function parseIstanbulFinal(text: string): Promise<CoverageFileReport[]> {
  const files: CoverageFileReport[] = [];
  let seen = 0;
  for (const [key, entry] of Object.entries(parseJson(text))) {
    const file = isObject(entry) ? fromFinal(key, entry) : null;
    if (file) files.push(file);
    if (++seen % YIELD_EVERY === 0) await yieldToEventLoop();
  }
  return files;
}

const countOf = (value: unknown): CoverageCount | null => {
  if (!isObject(value) || typeof value.total !== "number" || typeof value.covered !== "number") return null;
  return { covered: value.covered, total: value.total };
};

/** Reads Istanbul's `coverage-summary.json`, which has totals per file and no line detail. The `total` entry is skipped. */
export async function parseIstanbulSummary(text: string): Promise<CoverageFileReport[]> {
  const files: CoverageFileReport[] = [];
  let seen = 0;
  for (const [key, entry] of Object.entries(parseJson(text))) {
    if (key !== "total" && isObject(entry)) {
      const lines = countOf(entry.lines);
      if (lines) {
        const file: CoverageFileReport = { path: normalise(key), lines };
        const functions = countOf(entry.functions);
        if (functions && functions.total > 0) file.functions = functions;
        const branches = countOf(entry.branches);
        if (branches && branches.total > 0) file.branches = branches;
        files.push(file);
      }
    }
    if (++seen % YIELD_EVERY === 0) await yieldToEventLoop();
  }
  return files;
}
