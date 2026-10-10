import { areaLocator, codeAreas, type AreaKind, type AreaMode } from "./codeAreas.js";
import {
  COVERAGE_SNAPSHOT_VERSION,
  alignCoverage,
  type AlignedCoverage,
  type AlignedFile,
  type CoverageCount,
  type CoverageFormat,
  type CoverageRead,
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
import { sum } from "./stats.js";

/**
 * The report behind the detailed code analysis page: the repository broken down by area, the figures for one area, and
 * measured coverage when CI published it. Coverage is display only. It is read here to describe what ran and never feeds
 * `codeHealth`, `judge` or any grade (ADR 0030), and an area carries a maintainability band but no overall grade,
 * because testing and hygiene are repository-wide (ADR 0029).
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

/** A list cut at a limit, with how many there were before the cut. Read-only, as a prepared one is shared between requests. */
export interface Capped<T> {
  readonly items: readonly T[];
  /** How many there were before the cap. */
  readonly total: number;
}

/** The first `limit` of `all`, mapped when `map` is given, so `items.length <= total` always holds. */
function capped<T>(all: readonly T[], limit: number): Capped<T>;
function capped<T, U>(all: readonly T[], limit: number, map: (item: T) => U): Capped<U>;
function capped<T, U>(all: readonly T[], limit: number, map?: (item: T) => U): Capped<T | U> {
  const items = all.slice(0, limit);
  return { items: map ? items.map(map) : items, total: all.length };
}

/** The figures for one area. `maintainabilityBand` is the maintainability part only, never the repository's grade. */
export interface AreaSummary {
  /** Directory relative to the repository root, or "." for the files at the root. */
  path: string;
  kind: AreaKind;
  /**
   * Source files (code files that are not tests) in the area. A fixture file counts here, as its functions count in the
   * figures, although a fixture directory is never chosen as an area of its own.
   */
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
  /** Measured line coverage of the area's files that a report matched, from 0 to 1, or null when none were or they instrument no line. */
  coverage: number | null;
  /** Null when the area has no source function. */
  maintainabilityBand: Band | null;
}

/** A source function with the area it sits in and its measured coverage over `[startLine, endLine]`, or null when unknown. */
export interface FunctionRow extends FunctionMetrics {
  area: string | null;
  coverage: number | null;
}

/** Covered over instrumented lines, from 0 to 1, with the counts behind it. Never built for a total of 0. */
export interface CoverageShare extends CoverageCount {
  share: number;
}

export interface LeastCoveredFile {
  path: string;
  area: string | null;
  lines: CoverageCount;
  /** The lines never run, as ranges, at most `CODE_DETAIL_CAPS.rangesPerFile` of them; null when this file's report has no line ranges. */
  uncovered: Capped<LineRange> | null;
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
        /** The names of the artefacts read. */
        artefacts: string[];
        /** How many coverage artefacts the run had, which is more than `artefacts.length` when some were left unread. */
        artefactsInRun: number;
        runId: number;
        commitSha: string;
        fetchedAt: string;
        /** When the newest artefact read was created, which says how old the coverage is. */
        createdAt: string;
        formats: CoverageFormat[];
        /** Coverage files in the artefacts that could not be parsed and were left out. */
        unreadableFiles: number;
      };
      /** True when the coverage was measured on a different commit from the one analysed. */
      otherCommit: boolean;
      /** True when any matched file in the whole report carries which lines ran, rather than only totals. */
      lineDetail: boolean;
      /** Matched files in the selected scope. When 0 the report does not reach this scope, which is why every list is empty. */
      filesInScope: number;
      /** The three shares are over the selected scope; null when no matched file in scope carries that figure, or it counts nothing. */
      lines: CoverageShare | null;
      branches: CoverageShare | null;
      functions: CoverageShare | null;
      /** Repository-wide: `matched` and `inReport` count source files, `unmatched` those that match no file here. Paths are never exposed. */
      files: { inReport: number; matched: number; unmatched: number };
      /** In scope, by uncovered lines, largest first. */
      leastCovered: Capped<LeastCoveredFile>;
      /** In scope. Listed only when the file's area and language appear among the matched files. */
      notInReport: Capped<NotInReportFile>;
      /**
       * In scope: source files with functions that the report does not name and that are not listed above, because no
       * matched file shares their area and language, so the report plainly does not try to cover them.
       */
      notInReportOtherKinds: number;
      /** In scope: functions above the warning complexity with instrumented lines but none covered. Needs `endLine` and line ranges. */
      untestedComplex: Capped<FunctionRow>;
      /** Present when a newer read failed; the figures above then come from the last successful one. */
      lastError?: { message: string; fetchedAt: string };
    };

export interface CodeDetailReport {
  status: "ok";
  commitSha: string;
  analysedAt: string;
  thresholds: CodeHealthThresholds;
  /**
   * How the areas were found. `unknown` means the snapshot has no file list, because it predates version 6 or its
   * listing could not be read, so only function paths were available; a full re-crawl or a new commit finds workspaces.
   */
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
  good: CoverageRead | null;
}

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

/** Covered and instrumented lines of one file inside `[from, to]`, or null when the file has no line ranges. */
function linesWithin(file: AlignedFile | undefined, from: number, to: number): CoverageCount | null {
  if (!file?.ranges) return null;
  const covered = sum(file.ranges.covered.map((r) => rangeLines(r, from, to)));
  const uncovered = sum(file.ranges.uncovered.map((r) => rangeLines(r, from, to)));
  return { covered, total: covered + uncovered };
}

/** The counts added together as a share, or null when there are none or they count nothing, which is not 0%. */
function total(counts: readonly CoverageCount[]): CoverageShare | null {
  const covered = sum(counts.map((c) => c.covered));
  const all = sum(counts.map((c) => c.total));
  return all === 0 ? null : { covered, total: all, share: covered / all };
}

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

/** A coverage snapshot stored in another shape is not shown; the next crawl reads its run again. */
const current = <T extends CoverageSnapshot>(snapshot: T | null): T | null =>
  snapshot && snapshot.version === COVERAGE_SNAPSHOT_VERSION ? snapshot : null;

/** Decides the areas, summarises each and aligns the coverage. Pure: the snapshots carry their own timestamps. */
export function prepareCodeDetail(
  snapshot: CodeSnapshot,
  stored: CoverageSnapshots,
  thresholds: CodeHealthThresholds = DEFAULT_CODE_THRESHOLDS,
): PreparedCodeDetail {
  const coverage: CoverageSnapshots = { latest: current(stored.latest), good: current(stored.good) };
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

  const aligned = coverage.good ? alignCoverage(coverage.good.reports, files) : null;
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
      maintainabilityBand: fns.maintainabilityBand,
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
    return latest?.error ? { status: "error", message: latest.error, fetchedAt: latest.fetchedAt } : { status: "none" };
  }
  const scoped = scope.selected === null ? [...aligned.files.values()] : [...(prepared.alignedByArea.get(scope.selected) ?? [])];

  const unfinished = scoped
    .filter((f) => f.lines.total > f.lines.covered)
    .sort((a, b) => b.lines.total - b.lines.covered - (a.lines.total - a.lines.covered) || a.path.localeCompare(b.path));
  const leastCovered = capped(unfinished, CODE_DETAIL_CAPS.leastCovered, (f) => ({
    path: f.path,
    area: areaOf(f.path),
    lines: f.lines,
    uncovered: f.ranges ? capped(f.ranges.uncovered, CODE_DETAIL_CAPS.rangesPerFile) : null,
  }));

  const byFile = new Map<string, FunctionMetrics[]>();
  for (const f of sourceFns) bucket(byFile, f.file).push(f);
  const absent = [...byFile.entries()].filter(([path]) => !aligned.files.has(path));
  const notInReport = absent
    .filter(([path, list]) => prepared.coveredKinds.has(`${areaOf(path)}\u0000${list[0]!.language}`))
    .map(([path, list]) => ({ path, area: areaOf(path), functions: list.length, nloc: sum(list.map((f) => f.nloc)) }))
    .sort((a, b) => b.nloc - a.nloc || a.path.localeCompare(b.path));

  const untested = sourceFns
    .filter((f) => f.ccn > thresholds.warn && f.endLine !== undefined)
    .filter((f) => {
      const lines = linesWithin(aligned.files.get(f.file), f.startLine, f.endLine!);
      return lines !== null && lines.total > 0 && lines.covered === 0;
    })
    .sort(compareComplexity);

  const newest = good.artefacts.reduce(
    (at, a) => (a.createdAt > at ? a.createdAt : at),
    good.artefacts[0]?.createdAt ?? good.fetchedAt,
  );
  const view: CoverageView = {
    status: "ok",
    source: {
      artefacts: good.artefacts.map((a) => a.name),
      artefactsInRun: Math.max(good.artefactsInRun, good.artefacts.length),
      runId: good.runId,
      commitSha: good.commitSha,
      fetchedAt: good.fetchedAt,
      createdAt: newest,
      formats: [...new Set(good.reports.map((r) => r.format))],
      unreadableFiles: good.unreadableFiles,
    },
    otherCommit: good.commitSha !== prepared.snapshot.commitSha,
    lineDetail: aligned.lineDetail,
    filesInScope: scoped.length,
    lines: total(scoped.map((f) => f.lines)),
    branches: total(scoped.flatMap((f) => (f.branches ? [f.branches] : []))),
    functions: total(scoped.flatMap((f) => (f.functions ? [f.functions] : []))),
    files: { inReport: aligned.inReport, matched: aligned.matched, unmatched: aligned.unmatched },
    leastCovered,
    notInReport: capped(notInReport, CODE_DETAIL_CAPS.notInReport),
    notInReportOtherKinds: absent.length - notInReport.length,
    untestedComplex: capped(untested, CODE_DETAIL_CAPS.untestedComplex, (f) => functionRow(f, aligned, areaOf)),
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
  const rows = capped(ranked, CODE_DETAIL_CAPS.functions, (f) => functionRow(f, lineView, areaOf));

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
