import { coverageCount, type CoverageCount, type CoverageFileReport } from "@dora-dashboard/core";
import { UpstreamError } from "../../core/errors.js";
import { addHit, lineRanges } from "./line-ranges.js";
import { YIELD_EVERY, yieldToEventLoop } from "./yield-loop.js";

type Node = { [key: string]: unknown };

const isObject = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

const normalise = (path: string): string => path.trim().replace(/\\/g, "/");

const unreadable = (cause?: unknown) =>
  new UpstreamError("A coverage file in the artefact is not valid JSON of the expected shape", 502, { cause });

function parseJson(text: string): Node {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw unreadable(error);
  }
  if (!isObject(value)) throw unreadable();
  return value;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The start and end of a location as text, or "?" for a part the map does not give. */
function span(location: unknown): string {
  const at = (point: unknown) => (isObject(point) ? `${String(point.line)}:${String(point.column)}` : "?");
  return isObject(location) ? `${at(location.start)}-${at(location.end)}` : "?";
}

/** What is known of one file across every entry that names it. Each function and branch arm is counted once. */
interface FileTally {
  path: string;
  hits: Map<number, number>;
  /** By start of `decl` (or `loc`) and name; true when any copy ran. */
  functions: Map<string, boolean>;
  /** By start of the branch location and arm index; true when any copy took it. */
  branches: Map<string, boolean>;
}

const orTrue = (map: Map<string, boolean>, key: string, ran: boolean): void => {
  map.set(key, (map.get(key) ?? false) || ran);
};

/** A line is as covered as its most-run statement that starts on it. */
function tallyStatements(into: FileTally, statements: Node, hitsById: Node): void {
  for (const [id, location] of Object.entries(statements)) {
    const line = isObject(location) && isObject(location.start) ? location.start.line : undefined;
    if (typeof line === "number") addHit(into.hits, line, count(hitsById[id]));
  }
}

/** Each function once, by where it is declared and its name, running if any entry for it ran. */
function tallyFunctions(into: FileTally, entry: Node): void {
  if (!isObject(entry.f)) return;
  const functionMap = isObject(entry.fnMap) ? entry.fnMap : {};
  for (const [id, hits] of Object.entries(entry.f)) {
    const described = functionMap[id];
    const where = isObject(described) ? span(described.decl ?? described.loc) : "?";
    const name = isObject(described) && typeof described.name === "string" ? described.name : "";
    // Without a map the id is all there is to tell two functions apart.
    orTrue(into.functions, isObject(described) ? `${where}\u0000${name}` : `id\u0000${id}`, count(hits) > 0);
  }
}

/** Each arm of each branch once, taken if any entry for it was taken. */
function tallyBranches(into: FileTally, entry: Node): void {
  if (!isObject(entry.b)) return;
  const branchMap = isObject(entry.branchMap) ? entry.branchMap : {};
  for (const [id, arms] of Object.entries(entry.b)) {
    if (!Array.isArray(arms)) continue;
    const described = branchMap[id];
    // Two kinds of branch can start at the same place (`a && b ? c : d`), so the type is part of the key.
    const where = isObject(described) ? `${String(described.type)}@${span(described.loc)}` : `id ${id}`;
    arms.forEach((hits, arm) => orTrue(into.branches, `${where}\u0000${arm}`, count(hits) > 0));
  }
}

function tallyFinal(into: FileTally, entry: Node, statements: Node, hitsById: Node): void {
  tallyStatements(into, statements, hitsById);
  tallyFunctions(into, entry);
  tallyBranches(into, entry);
}

const tallied = (map: Map<string, boolean>): CoverageCount | undefined =>
  map.size > 0 ? { covered: [...map.values()].filter(Boolean).length, total: map.size } : undefined;

/**
 * Reads Istanbul's `coverage-final.json`: line hits are the highest statement count among those starting on the line.
 * Entries that name the same file once their separators are normalised are one file: the highest hit per line, and each
 * function and branch arm counted once and run if any copy ran.
 */
export async function parseIstanbulFinal(text: string): Promise<CoverageFileReport[]> {
  const tallies = new Map<string, FileTally>();
  let seen = 0;
  for (const [key, entry] of Object.entries(parseJson(text))) {
    if (isObject(entry) && isObject(entry.statementMap) && isObject(entry.s)) {
      const path = normalise(typeof entry.path === "string" && entry.path !== "" ? entry.path : key);
      let tally = tallies.get(path);
      if (!tally) tallies.set(path, (tally = { path, hits: new Map(), functions: new Map(), branches: new Map() }));
      tallyFinal(tally, entry, entry.statementMap, entry.s);
    }
    if (++seen % YIELD_EVERY === 0) await yieldToEventLoop();
  }
  return [...tallies.values()].map((tally) => {
    const detail = lineRanges(tally.hits);
    const file: CoverageFileReport = { path: tally.path, lines: detail.lines };
    if (detail.ranges) file.ranges = detail.ranges;
    const functions = tallied(tally.functions);
    if (functions) file.functions = functions;
    const branches = tallied(tally.branches);
    if (branches) file.branches = branches;
    return file;
  });
}

const countOf = (value: unknown): CoverageCount | null => (isObject(value) ? coverageCount(value.covered, value.total) : null);

/** The count with more covered, then the larger total; either when the other is missing. */
const better = (a: CoverageCount | undefined, b: CoverageCount | undefined): CoverageCount | undefined =>
  !a || !b ? (a ?? b) : b.covered > a.covered || (b.covered === a.covered && b.total > a.total) ? b : a;

/**
 * The counts one summary entry gives, or null when its line count is impossible. An empty function or branch count is
 * left out.
 */
function summaryOf(entry: Node): Pick<CoverageFileReport, "lines" | "functions" | "branches"> | null {
  const lines = countOf(entry.lines);
  if (!lines) return null;
  const functions = countOf(entry.functions);
  const branches = countOf(entry.branches);
  return {
    lines,
    functions: functions && functions.total > 0 ? functions : undefined,
    branches: branches && branches.total > 0 ? branches : undefined,
  };
}

/** The file with each of its counts the better of the earlier entry's and the incoming one's. */
function mergeSummary(
  path: string,
  before: CoverageFileReport | undefined,
  incoming: NonNullable<ReturnType<typeof summaryOf>>,
): CoverageFileReport {
  const file: CoverageFileReport = { path, lines: better(before?.lines, incoming.lines)! };
  const mergedFunctions = better(before?.functions, incoming.functions);
  const mergedBranches = better(before?.branches, incoming.branches);
  if (mergedFunctions) file.functions = mergedFunctions;
  if (mergedBranches) file.branches = mergedBranches;
  return file;
}

/**
 * Reads Istanbul's `coverage-summary.json`, which has totals per file and no line detail. The `total` entry is skipped.
 * A file whose line count is impossible is dropped, and an impossible function or branch count is left out. Two entries
 * for one path keep the one with more lines covered, and the higher branch and function counts of the two.
 */
export async function parseIstanbulSummary(text: string): Promise<CoverageFileReport[]> {
  const files = new Map<string, CoverageFileReport>();
  let seen = 0;
  for (const [key, entry] of Object.entries(parseJson(text))) {
    const incoming = key !== "total" && isObject(entry) ? summaryOf(entry) : null;
    if (incoming) {
      const path = normalise(key);
      files.set(path, mergeSummary(path, files.get(path), incoming));
    }
    if (++seen % YIELD_EVERY === 0) await yieldToEventLoop();
  }
  return [...files.values()];
}
