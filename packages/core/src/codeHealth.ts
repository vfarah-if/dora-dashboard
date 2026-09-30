import { isCodeFile, isTestPath, type ToolingFacts } from "./codeTooling.js";
import {
  HIGH_CCN,
  LONG_FUNCTION_NLOC,
  MANY_PARAMS,
  WARN_CCN,
  gradeCodeHealth,
  maintainabilityChecks,
  testingChecks,
  type CodeGrade,
  type GradeCheck,
  type HygieneFigures,
  type MaintainabilityCounts,
  type MaintainabilityFigures,
} from "./codeGrade.js";
import { describeHotspots, nextBand, type Hotspot, type NextBand } from "./codeAdvice.js";
import { isBot } from "./pullRequests.js";
import { mean, median, p75 } from "./stats.js";
import type { PullRequest } from "./types.js";

/** One function found by a static analyser. `file` is relative to the repository root. */
export interface FunctionMetrics {
  file: string;
  language: string;
  name: string;
  startLine: number;
  /** Cyclomatic complexity: the number of independent paths through the function. */
  ccn: number;
  /** Lines of code, excluding blank lines and comments. */
  nloc: number;
  params: number;
}

/**
 * Bumped whenever a snapshot gains data, so that older snapshots are analysed again even when the branch has
 * not moved. Version 1 (no number stored) had no tooling facts; version 3 read CI and coverage configuration more
 * strictly (comments, `continue-on-error`, installs), so version 2 tooling facts may differ. Version 4 records
 * the files the analyser may have read only in part.
 */
export const CODE_SNAPSHOT_VERSION = 4;

/** What one analysis of one commit found. `error` is set, with no functions, when the analysis could not run. */
export interface CodeSnapshot {
  commitSha: string;
  analysedAt: string;
  functions: FunctionMetrics[];
  error?: string | null;
  /** Read from the clone's files; absent on version 1 snapshots and when the files could not be read. */
  tooling?: ToolingFacts | null;
  /** Absent means version 1. */
  snapshotVersion?: number;
  /**
   * Files the analyser may have read only in part, so some of their functions can be missing from `functions`.
   * Absent before version 4.
   */
  partlyMeasured?: string[];
}

export interface CodeHealthThresholds {
  /** A function with a CCN above this is worth a look. */
  warn: number;
  /** A function with a CCN above this is hard to test and to change safely. */
  high: number;
}

export interface CcnBucket {
  label: string;
  min: number;
  /** Null for the open-ended top bucket. */
  max: number | null;
  count: number;
}

export interface LanguageHealth {
  language: string;
  functions: number;
  nloc: number;
  meanCcn: number;
}

/** The range that decides which merged pull requests count towards `prsWithTests`. Dates as YYYY-MM-DD. */
export interface CodeHealthRange {
  from?: string;
  to?: string;
}

export interface PrsWithTests {
  /** `withTests / total`, from 0 to 1. */
  share: number;
  withTests: number;
  /** Merged pull requests in the range with file data that change at least one source file. */
  total: number;
}

export interface CodeHealthReport {
  status: "ok";
  commitSha: string;
  analysedAt: string;
  /** Source functions only; test functions are counted in `tests`. */
  functions: number;
  /** Source lines (NLOC). */
  nloc: number;
  ccn: { mean: number; median: number; p75: number; max: number };
  /** Share of source functions, by count, above each threshold. */
  shareAboveWarn: number;
  shareAboveHigh: number;
  countAboveWarn: number;
  countAboveHigh: number;
  mostComplex: FunctionMetrics | null;
  distribution: CcnBucket[];
  languages: LanguageHealth[];
  /** The ten most complex source functions, each with the kind of change that would help. */
  hotspots: Hotspot[];
  /** The fewest functions to simplify for maintainability to reach the next band; null when elite or empty. */
  nextBand: NextBand | null;
  /** Source files the analyser may have read only in part, sorted. Empty when none, or before snapshot version 4. */
  partlyMeasured: string[];
  tests: { functions: number; nloc: number };
  maintainability: MaintainabilityFigures;
  testing: { testRatio: number; prsWithTests: PrsWithTests | null; ciRunsTests: boolean | null; coverageFloor: number | null };
  /** Null when the clone's files could not be read, or the snapshot predates version 2. */
  hygiene: (HygieneFigures & { linters: string[]; formatters: string[]; ciLinters: string[]; ciFormatChecks: string[] }) | null;
  tooling: ToolingFacts | null;
  /** Null when there is no source function to grade, or no tooling facts. */
  grade: CodeGrade | null;
  /** The evidence behind the grade, one entry per check, so a front end needs no thresholds of its own. See `GradeCheck`. */
  checks: GradeCheck[];
  /** The source function with the most lines (NLOC), or null when there is none. */
  longestFunction: FunctionMetrics | null;
  /** Present when a newer analysis failed; the figures above then come from the last successful one. */
  lastError?: CodeHealthFailure;
}

/**
 * Why an analysis produced no figures, so a front end can offer the right remedy without matching message text.
 * `analyser-missing` means lizard is not on the API's PATH, `analysis-off` means CODE_ANALYSIS=off, `failed` is anything else.
 */
export type CodeHealthFailureReason = "analyser-missing" | "analysis-off" | "failed";

export interface CodeHealthFailure {
  message: string;
  analysedAt: string;
  reason: CodeHealthFailureReason;
}

/** What the code health route returns: a report, or the reason there is not one. `error` means no analysis has ever succeeded. */
export type CodeHealthResponse = CodeHealthReport | { status: "none" } | ({ status: "error" } & CodeHealthFailure);

export const DEFAULT_CODE_THRESHOLDS: CodeHealthThresholds = { warn: WARN_CCN, high: HIGH_CCN };

const BUCKETS: readonly { label: string; min: number; max: number | null }[] = [
  { label: "1 to 5", min: 1, max: 5 },
  { label: "6 to 10", min: 6, max: 10 },
  { label: "11 to 20", min: 11, max: 20 },
  { label: "21 to 50", min: 21, max: 50 },
  { label: "Over 50", min: 51, max: null },
];

const HOTSPOT_COUNT = 10;

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);
const ratio = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

const inRange = (mergedAt: string, from: string | undefined, to: string | undefined) =>
  !(from && mergedAt < from) && !(to && mergedAt > to);

/** The verdict on one pull request: null when it does not count, otherwise whether it also changes tests. */
function changesTests(pr: PullRequest, from: string | undefined, to: string | undefined): boolean | null {
  // A pull request with more than 100 files lists only the first 100, so its split of source and tests is unknown.
  if (!pr.files || pr.filesTruncated || !pr.mergedAt || isBot(pr) || !inRange(pr.mergedAt, from, to)) return null;
  const code = pr.files.filter(isCodeFile);
  return code.some((f) => !isTestPath(f)) ? code.some(isTestPath) : null;
}

/**
 * Of the pull requests merged in the range that have file data and change source code, how many also change a
 * test file. Bots are left out, as in the flow report. Pull requests without `files` are ignored.
 */
export function prsWithTests(prs: readonly PullRequest[], range: CodeHealthRange = {}): PrsWithTests | null {
  const to = range.to ? `${range.to.slice(0, 10)}T23:59:59Z` : undefined;
  const verdicts = prs.map((pr) => changesTests(pr, range.from, to)).filter((v): v is boolean => v !== null);
  const withTests = verdicts.filter(Boolean).length;
  return verdicts.length === 0 ? null : { share: withTests / verdicts.length, withTests, total: verdicts.length };
}

/** Most complex first; ties fall to size, then to file and name so the order never depends on input order. */
const compareComplexity = (a: FunctionMetrics, b: FunctionMetrics) =>
  b.ccn - a.ccn || b.nloc - a.nloc || a.file.localeCompare(b.file) || a.name.localeCompare(b.name);

function ccnSummary(ccns: number[]): CodeHealthReport["ccn"] {
  return {
    mean: mean(ccns) ?? 0,
    median: median(ccns) ?? 0,
    p75: p75(ccns) ?? 0,
    // A reduce, not `Math.max(...ccns)`, which overflows the stack on very large repositories.
    max: ccns.reduce((top, c) => (c > top ? c : top), 0),
  };
}

const distributionOf = (fns: FunctionMetrics[]): CcnBucket[] =>
  BUCKETS.map((b) => ({ ...b, count: fns.filter((f) => f.ccn >= b.min && (b.max === null || f.ccn <= b.max)).length }));

function languageBreakdown(fns: FunctionMetrics[]): LanguageHealth[] {
  const byLanguage = new Map<string, FunctionMetrics[]>();
  for (const fn of fns) {
    const list = byLanguage.get(fn.language);
    if (list) list.push(fn);
    else byLanguage.set(fn.language, [fn]);
  }
  return [...byLanguage.entries()]
    .map(([language, list]) => ({
      language,
      functions: list.length,
      nloc: sum(list.map((f) => f.nloc)),
      meanCcn: mean(list.map((f) => f.ccn)) ?? 0,
    }))
    .sort((a, b) => b.functions - a.functions || a.language.localeCompare(b.language));
}

function maintainabilityFigures(fns: FunctionMetrics[]): MaintainabilityFigures {
  const nloc = sum(fns.map((f) => f.nloc));
  const linesAbove = (limit: number) => ratio(sum(fns.filter((f) => f.ccn > limit).map((f) => f.nloc)), nloc);
  return {
    linesAboveWarn: linesAbove(WARN_CCN),
    linesAboveHigh: linesAbove(HIGH_CCN),
    longFunctions: ratio(fns.filter((f) => f.nloc > LONG_FUNCTION_NLOC).length, fns.length),
    manyParams: ratio(fns.filter((f) => f.params > MANY_PARAMS).length, fns.length),
  };
}

function hygieneFigures(tooling: ToolingFacts): NonNullable<CodeHealthReport["hygiene"]> {
  return {
    linterConfigured: tooling.linters.length > 0,
    formatterConfigured: tooling.formatters.length > 0,
    ciRunsLinter: tooling.ciLinters.length > 0,
    ciChecksFormat: tooling.ciFormatChecks.length > 0,
    onlyEditorconfig: tooling.formatters.length === 0 && tooling.weakFormatters.length > 0,
    linters: tooling.linters,
    formatters: tooling.formatters,
    ciLinters: tooling.ciLinters,
    ciFormatChecks: tooling.ciFormatChecks,
  };
}

function testingFigures(testRatio: number, prs: PrsWithTests | null, tooling: ToolingFacts | null): CodeHealthReport["testing"] {
  return {
    testRatio,
    prsWithTests: prs,
    ciRunsTests: tooling ? tooling.ciRunsTests : null,
    coverageFloor: tooling ? tooling.coverageFloor : null,
  };
}

function maintainabilityCounts(fns: FunctionMetrics[]): MaintainabilityCounts {
  const above = (limit: number) => fns.filter((f) => f.ccn > limit).length;
  return {
    linesAboveWarn: above(WARN_CCN),
    linesAboveHigh: above(HIGH_CCN),
    longFunctions: fns.filter((f) => f.nloc > LONG_FUNCTION_NLOC).length,
    manyParams: fns.filter((f) => f.params > MANY_PARAMS).length,
  };
}

/**
 * The grade and the evidence behind it. With no source function there is nothing to judge. Without tooling facts
 * the tooling checks are left out and there is no grade, but the checks that can be measured are still listed.
 */
function judge(
  fns: FunctionMetrics[],
  maintainability: MaintainabilityFigures,
  testRatio: number,
  prs: PrsWithTests | null,
  tooling: ToolingFacts | null,
): { grade: CodeGrade | null; checks: GradeCheck[] } {
  if (fns.length === 0) return { grade: null, checks: [] };
  const counts = maintainabilityCounts(fns);
  const prShare = prs ? prs.share : null;
  if (!tooling) {
    const checks = [
      ...maintainabilityChecks(maintainability, counts),
      ...testingChecks({ testRatio, prsWithTests: prShare }, prs),
    ];
    return { grade: null, checks };
  }
  return gradeCodeHealth({
    maintainability,
    counts,
    testing: { testRatio, prsWithTests: prShare, ciRunsTests: tooling.ciRunsTests, coverageFloor: tooling.coverageFloor },
    prs,
    hygiene: hygieneFigures(tooling),
    tools: hygieneFigures(tooling),
  });
}

/** The function with the most lines, for a "longest function" tile; ties fall to complexity, file and name. */
const longestOf = (fns: FunctionMetrics[]): FunctionMetrics | null =>
  fns.reduce<FunctionMetrics | null>(
    (best, f) => (best && (best.nloc > f.nloc || (best.nloc === f.nloc && compareComplexity(best, f) <= 0)) ? best : f),
    null,
  );

/**
 * Summarises one analysed commit and grades it. Pure: the snapshot carries its own timestamp, and the pull
 * requests and range are passed in. Only source functions feed the maintainability figures.
 */
export function codeHealth(
  snapshot: CodeSnapshot,
  prs: readonly PullRequest[] = [],
  range: CodeHealthRange = {},
  thresholds: CodeHealthThresholds = DEFAULT_CODE_THRESHOLDS,
): CodeHealthReport {
  const fns = snapshot.functions.filter((f) => !isTestPath(f.file));
  const testFns = snapshot.functions.filter((f) => isTestPath(f.file));
  const ccns = fns.map((f) => f.ccn);
  const nloc = sum(fns.map((f) => f.nloc));
  const testNloc = sum(testFns.map((f) => f.nloc));
  const above = (limit: number) => fns.filter((f) => f.ccn > limit).length;
  const byComplexity = [...fns].sort(compareComplexity);

  const maintainability = maintainabilityFigures(fns);
  const tooling = snapshot.tooling ?? null;
  const withTests = prsWithTests(prs, range);
  const testRatio = ratio(testNloc, nloc);
  const path = nextBand(fns, maintainability);

  return {
    status: "ok",
    commitSha: snapshot.commitSha,
    analysedAt: snapshot.analysedAt,
    functions: fns.length,
    nloc,
    ccn: ccnSummary(ccns),
    shareAboveWarn: ratio(above(thresholds.warn), fns.length),
    shareAboveHigh: ratio(above(thresholds.high), fns.length),
    countAboveWarn: above(thresholds.warn),
    countAboveHigh: above(thresholds.high),
    mostComplex: byComplexity[0] ?? null,
    distribution: distributionOf(fns),
    languages: languageBreakdown(fns),
    hotspots: describeHotspots(byComplexity.slice(0, HOTSPOT_COUNT), nloc, path),
    nextBand: path,
    partlyMeasured: (snapshot.partlyMeasured ?? []).filter((f) => !isTestPath(f)).sort(),
    tests: { functions: testFns.length, nloc: testNloc },
    maintainability,
    testing: testingFigures(testRatio, withTests, tooling),
    hygiene: tooling && hygieneFigures(tooling),
    tooling,
    ...judge(fns, maintainability, testRatio, withTests, tooling),
    longestFunction: longestOf(fns),
  };
}
