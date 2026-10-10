import { areaLocator, codeAreas, type AreaKind, type AreaMode } from "./codeAreas.js";
import {
  alignCoverage,
  type AlignedCoverage,
  type AlignedFile,
  type CoverageCount,
  type CoverageFormat,
  type CoverageSnapshot,
  type LineRange,
} from "./codeCoverage.js";
import {
  DEFAULT_CODE_THRESHOLDS,
  codeFigures,
  compareComplexity,
  type CodeFigures,
  type CodeHealthFailure,
  type CodeHealthThresholds,
  type CodeSnapshot,
  type FunctionMetrics,
} from "./codeHealth.js";
import { isCodeFile, isTestPath } from "./codeTooling.js";
import type { Band } from "./dora.js";

/**
 * The report behind the detailed code analysis page: the repository broken down by area, the figures for one area, and
 * measured coverage when CI published it. Coverage is display only. It is read here to describe what ran and never feeds
 * `codeHealth`, `judge` or any grade, and an area carries a maintainability band but no overall grade, because testing
 * and hygiene are repository-wide (ADR 0013).
 */

/** How many entries each list keeps. Each capped list says how many there were before the cut. */
export const CODE_DETAIL_CAPS = {
  areas: 300,
  functions: 500,
  leastCovered: 50,
  notInReport: 200,
  untestedComplex: 100,
  rangesPerFile: 20,
} as const;

export interface Capped<T> {
  items: T[];
  /** How many there were before the cap. */
  total: number;
}

const capped = <T>(all: T[], limit: number): Capped<T> => ({ items: all.slice(0, limit), total: all.length });

/** The figures for one area. `maintainabilityBand` is the maintainability part only, never the repository's grade. */
export interface AreaSummary {
  /** Directory relative to the repository root, or "." for the files at the root. */
  path: string;
  kind: AreaKind;
  /** Source files (code files that are not tests) in the area. */
  files: number;
  functions: number;
  nloc: number;
  meanCcn: number;
  countAboveWarn: number;
  countAboveHigh: number;
  /** Source lines (NLOC) in functions with a CCN above the warning limit, using the thresholds in force. */
  nlocAboveWarn: number;
  testFunctions: number;
  testNloc: number;
  /** Measured line coverage of the area's files that a report matched, from 0 to 1, or null when none were. */
  coverage: number | null;
  /** Null when the area has no source function. */
  maintainabilityBand: Band | null;
}

/** A source function with the area it sits in and its measured coverage over `[startLine, endLine]`, or null when unknown. */
export interface FunctionRow extends FunctionMetrics {
  area: string | null;
  coverage: number | null;
}

/** Covered over instrumented lines, from 0 to 1, with the counts behind it. */
export interface CoverageShare extends CoverageCount {
  share: number;
}

export interface LeastCoveredFile {
  path: string;
  area: string | null;
  lines: CoverageCount;
  /** The lines never run, as ranges, at most `CODE_DETAIL_CAPS.rangesPerFile` of them. */
  uncovered: Capped<LineRange>;
}

/** A source file with functions that the coverage report does not mention. */
export interface NotInReportFile {
  path: string;
  area: string | null;
  functions: number;
  nloc: number;
}

export type CoverageView =
  | { status: "none" }
  | { status: "error"; message: string; fetchedAt: string }
  | {
      status: "ok";
      source: {
        artefacts: string[];
        runId: number | null;
        commitSha: string | null;
        fetchedAt: string;
        /** When the newest artefact was created, or null when none carried a date. Says how old the coverage is. */
        createdAt: string | null;
        formats: CoverageFormat[];
      };
      /** True when the coverage was measured on a different commit from the one analysed. */
      otherCommit: boolean;
      /** True when any matched file carries which lines ran, rather than only totals. */
      lineDetail: boolean;
      /** The three shares are over the selected scope; null when no matched file in scope carries that figure. */
      lines: CoverageShare | null;
      branches: CoverageShare | null;
      functions: CoverageShare | null;
      /** Repository-wide: `matched` and `inReport` count source files, `unmatched` those that match no file here. Paths are never exposed. */
      files: { inReport: number; matched: number; unmatched: number };
      /** In scope, by uncovered lines, largest first. */
      leastCovered: Capped<LeastCoveredFile>;
      /** In scope. Listed only when the file's area and language appear among the matched files. */
      notInReport: Capped<NotInReportFile>;
      /** In scope: functions above the warning complexity with instrumented lines but none covered. Needs `endLine`. */
      untestedComplex: Capped<FunctionRow>;
      /** Present when a newer read failed; the figures above then come from the last successful one. */
      lastError?: { message: string; fetchedAt: string };
    };

export interface CodeDetailReport {
  status: "ok";
  commitSha: string;
  analysedAt: string;
  thresholds: CodeHealthThresholds;
  /** How the areas were found. `unknown` means the snapshot predates version 6 and a crawl will find workspaces. */
  mode: AreaMode;
  /** Largest first by source lines, then by path. */
  areas: Capped<AreaSummary>;
  /** The selected area's path, or null for the whole repository. */
  area: string | null;
  /** Set when the requested area is not one of the areas; the report is then for the whole repository. */
  missingArea?: string;
  /** The figures for the selected scope, with the files read only in part. */
  scope: CodeFigures & { partlyMeasured: string[] };
  /** Source functions in scope, most complex first. */
  functions: Capped<FunctionRow>;
  coverage: CoverageView;
  /** Present when a newer analysis failed; the figures above then come from the last successful one. */
  lastError?: CodeHealthFailure;
}

/** What the code detail route returns: the report, or the reason there is not one. `error` means no analysis has ever succeeded. */
export type CodeDetailResponse = CodeDetailReport | { status: "none" } | ({ status: "error" } & CodeHealthFailure);

export interface CodeDetailOptions {
  /** The area to look at, by path; absent or empty for the whole repository. */
  area?: string | null;
  lastError?: CodeHealthFailure;
}

/** The newest coverage read, and the newest that succeeded. Either may be null. */
export interface CoverageSnapshots {
  latest: CoverageSnapshot | null;
  good: CoverageSnapshot | null;
}

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);

const share = (count: CoverageCount): CoverageShare => ({ ...count, share: count.total === 0 ? 0 : count.covered / count.total });

/** The list for `key`, created on first use, so a group is built by pushing rather than by copying. */
function bucket<K, V>(map: Map<K, V[]>, key: K): V[] {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  return list;
}

const rangeLines = ([first, last]: LineRange, from: number, to: number) =>
  Math.max(0, Math.min(last, to) - Math.max(first, from) + 1);

/** Covered and instrumented lines of one file inside `[from, to]`, or null when the file has no line detail. */
function linesWithin(file: AlignedFile | undefined, from: number, to: number): CoverageCount | null {
  if (!file || (!file.covered && !file.uncovered)) return null;
  const covered = sum((file.covered ?? []).map((r) => rangeLines(r, from, to)));
  const uncovered = sum((file.uncovered ?? []).map((r) => rangeLines(r, from, to)));
  return { covered, total: covered + uncovered };
}

const total = (counts: CoverageCount[]): CoverageShare | null =>
  counts.length === 0 ? null : share({ covered: sum(counts.map((c) => c.covered)), total: sum(counts.map((c) => c.total)) });

/** A function with its area and the share of its own lines that ran, which needs `endLine` and a report with line detail. */
function functionRow(f: FunctionMetrics, aligned: AlignedCoverage | null, areaOf: (file: string) => string | null): FunctionRow {
  const lines = f.endLine === undefined || !aligned ? null : linesWithin(aligned.files.get(f.file), f.startLine, f.endLine);
  return { ...f, area: areaOf(f.file), coverage: lines && lines.total > 0 ? lines.covered / lines.total : null };
}

/**
 * Everything about a snapshot and its coverage that does not depend on the selected area: the areas and their
 * summaries, the functions grouped by area and the coverage aligned onto repository paths. Build it once and ask it
 * for any area with `codeDetail`. It holds no clock and no rule that changes without a new snapshot, so it can be kept
 * in memory for as long as the snapshots it was built from are the newest.
 */
export interface PreparedCodeDetail {
  readonly snapshot: CodeSnapshot;
  readonly coverage: CoverageSnapshots;
  readonly thresholds: CodeHealthThresholds;
  readonly mode: AreaMode;
  readonly areas: Capped<AreaSummary>;
  readonly areaPaths: ReadonlySet<string>;
  readonly areaOf: (file: string) => string | null;
  readonly functionsByArea: ReadonlyMap<string | null, readonly FunctionMetrics[]>;
  readonly aligned: AlignedCoverage | null;
  readonly alignedByArea: ReadonlyMap<string | null, readonly AlignedFile[]>;
  /** `area`, a NUL and a language, for each combination that a matched file shows a report plainly covers. */
  readonly coveredKinds: ReadonlySet<string>;
}

/** Decides the areas, summarises each and aligns the coverage. Pure: the snapshots carry their own timestamps. */
export function prepareCodeDetail(
  snapshot: CodeSnapshot,
  coverage: CoverageSnapshots,
  thresholds: CodeHealthThresholds = DEFAULT_CODE_THRESHOLDS,
): PreparedCodeDetail {
  const functionPaths = new Set([...snapshot.functions.map((f) => f.file), ...(snapshot.partlyMeasured ?? [])]);
  // Before version 6 there is no file list or layout, so the function paths stand in and the areas are a guess.
  const files = snapshot.files ?? [...functionPaths].sort();
  const { mode, areas } = codeAreas(files, snapshot.files ? snapshot.layout : null);
  const areaOf = areaLocator(areas);

  const functionsByArea = new Map<string | null, FunctionMetrics[]>();
  const languageOf = new Map<string, string>();
  for (const f of snapshot.functions) {
    bucket(functionsByArea, areaOf(f.file)).push(f);
    languageOf.set(f.file, f.language);
  }
  const sourceFilesIn = new Map<string | null, number>();
  for (const file of files) {
    if (!isCodeFile(file) || isTestPath(file)) continue;
    const key = areaOf(file);
    sourceFilesIn.set(key, (sourceFilesIn.get(key) ?? 0) + 1);
  }

  const aligned = coverage.good && !coverage.good.error ? alignCoverage(coverage.good.reports, files) : null;
  const alignedByArea = new Map<string | null, AlignedFile[]>();
  // A file is blamed only where a report plainly covers its kind of code: the same area and language as a matched file.
  const coveredKinds = new Set<string>();
  for (const f of aligned?.files.values() ?? []) {
    const key = areaOf(f.path);
    bucket(alignedByArea, key).push(f);
    const language = languageOf.get(f.path);
    if (language) coveredKinds.add(`${key}\u0000${language}`);
  }

  const summaries: AreaSummary[] = areas.map(({ path, kind }) => {
    const fns = codeFigures(functionsByArea.get(path) ?? [], thresholds);
    const lines = total((alignedByArea.get(path) ?? []).map((f) => f.lines));
    return {
      path,
      kind,
      files: sourceFilesIn.get(path) ?? 0,
      functions: fns.functions,
      nloc: fns.nloc,
      meanCcn: fns.ccn.mean,
      countAboveWarn: fns.countAboveWarn,
      countAboveHigh: fns.countAboveHigh,
      nlocAboveWarn: sum(
        (functionsByArea.get(path) ?? []).filter((f) => !isTestPath(f.file) && f.ccn > thresholds.warn).map((f) => f.nloc),
      ),
      testFunctions: fns.tests.functions,
      testNloc: fns.tests.nloc,
      coverage: lines ? lines.share : null,
      maintainabilityBand: fns.functions === 0 ? null : fns.maintainabilityBand,
    };
  });
  summaries.sort((a, b) => b.nloc - a.nloc || a.path.localeCompare(b.path));

  return {
    snapshot,
    coverage,
    thresholds,
    mode,
    areas: capped(summaries, CODE_DETAIL_CAPS.areas),
    areaPaths: new Set(areas.map((a) => a.path)),
    areaOf,
    functionsByArea,
    aligned,
    alignedByArea,
    coveredKinds,
  };
}

interface Scope {
  /** The selected area, or null for the whole repository. */
  selected: string | null;
  inScope: (file: string) => boolean;
}

function coverageView(prepared: PreparedCodeDetail, sourceFns: readonly FunctionMetrics[], scope: Scope): CoverageView {
  const { latest, good } = prepared.coverage;
  const { aligned, areaOf, thresholds } = prepared;
  if (!good || !aligned) {
    return latest
      ? { status: "error", message: latest.error ?? "Unknown error", fetchedAt: latest.fetchedAt }
      : { status: "none" };
  }
  const scoped = scope.selected === null ? [...aligned.files.values()] : [...(prepared.alignedByArea.get(scope.selected) ?? [])];

  const unfinished = scoped
    .filter((f) => f.lines.total > f.lines.covered)
    .sort((a, b) => b.lines.total - b.lines.covered - (a.lines.total - a.lines.covered) || a.path.localeCompare(b.path));
  const leastCovered: Capped<LeastCoveredFile> = {
    total: unfinished.length,
    items: unfinished.slice(0, CODE_DETAIL_CAPS.leastCovered).map((f) => ({
      path: f.path,
      area: areaOf(f.path),
      lines: f.lines,
      uncovered: capped(f.uncovered ?? [], CODE_DETAIL_CAPS.rangesPerFile),
    })),
  };

  const byFile = new Map<string, FunctionMetrics[]>();
  for (const f of sourceFns) bucket(byFile, f.file).push(f);
  const notInReport = [...byFile.entries()]
    .filter(([path, list]) => !aligned.files.has(path) && prepared.coveredKinds.has(`${areaOf(path)}\u0000${list[0]!.language}`))
    .map(([path, list]) => ({ path, area: areaOf(path), functions: list.length, nloc: sum(list.map((f) => f.nloc)) }))
    .sort((a, b) => b.nloc - a.nloc || a.path.localeCompare(b.path));

  const untested = sourceFns
    .filter((f) => f.ccn > thresholds.warn && f.endLine !== undefined)
    .filter((f) => {
      const lines = linesWithin(aligned.files.get(f.file), f.startLine, f.endLine!);
      return lines !== null && lines.total > 0 && lines.covered === 0;
    })
    .sort(compareComplexity);

  const newest = good.artefacts.reduce<string | null>(
    (latestAt, a) => (latestAt === null || a.createdAt > latestAt ? a.createdAt : latestAt),
    null,
  );
  const view: CoverageView = {
    status: "ok",
    source: {
      artefacts: good.artefacts.map((a) => a.name),
      runId: good.runId,
      commitSha: good.commitSha,
      fetchedAt: good.fetchedAt,
      createdAt: newest,
      formats: [...new Set(good.reports.map((r) => r.format))],
    },
    otherCommit: good.commitSha !== prepared.snapshot.commitSha,
    lineDetail: scoped.some((f) => f.covered || f.uncovered),
    lines: total(scoped.map((f) => f.lines)),
    branches: total(scoped.flatMap((f) => (f.branches ? [f.branches] : []))),
    functions: total(scoped.flatMap((f) => (f.functions ? [f.functions] : []))),
    files: { inReport: aligned.inReport, matched: aligned.matched, unmatched: aligned.unmatched },
    leastCovered,
    notInReport: capped(notInReport, CODE_DETAIL_CAPS.notInReport),
    untestedComplex: {
      total: untested.length,
      items: untested.slice(0, CODE_DETAIL_CAPS.untestedComplex).map((f) => functionRow(f, aligned, areaOf)),
    },
  };
  return latest?.error ? { ...view, lastError: { message: latest.error, fetchedAt: latest.fetchedAt } } : view;
}

/**
 * Builds the detailed code analysis report for the whole repository or one area of a prepared snapshot. Pure and
 * cheap enough to run on every request. Coverage never changes a figure that `codeHealth` returns, and a path in a
 * coverage report that matches no file here is counted but never returned.
 */
export function codeDetail(prepared: PreparedCodeDetail, options: CodeDetailOptions = {}): CodeDetailReport {
  const { snapshot, thresholds, areaOf } = prepared;
  const requested = options.area ? options.area : null;
  const selected = requested !== null && prepared.areaPaths.has(requested) ? requested : null;
  const inScope = (file: string) => selected === null || areaOf(file) === selected;

  const scopeFunctions = selected === null ? snapshot.functions : (prepared.functionsByArea.get(selected) ?? []);
  const sourceInScope = scopeFunctions.filter((f) => !isTestPath(f.file));
  const view = coverageView(prepared, sourceInScope, { selected, inScope });
  const lineView = view.status === "ok" ? prepared.aligned : null;

  // Sort and cap before the per-function coverage work, which is the expensive part.
  const ranked = [...sourceInScope].sort(compareComplexity);
  const rows: Capped<FunctionRow> = {
    total: ranked.length,
    items: ranked.slice(0, CODE_DETAIL_CAPS.functions).map((f) => functionRow(f, lineView, areaOf)),
  };

  return {
    status: "ok",
    commitSha: snapshot.commitSha,
    analysedAt: snapshot.analysedAt,
    thresholds,
    mode: prepared.mode,
    areas: prepared.areas,
    area: selected,
    ...(requested !== null && selected === null ? { missingArea: requested } : {}),
    scope: {
      ...codeFigures(scopeFunctions, thresholds),
      partlyMeasured: (snapshot.partlyMeasured ?? []).filter((f) => !isTestPath(f) && inScope(f)).sort(),
    },
    functions: rows,
    coverage: view,
    ...(options.lastError ? { lastError: options.lastError } : {}),
  };
}
