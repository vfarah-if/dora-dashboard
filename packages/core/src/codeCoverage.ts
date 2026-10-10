import { isTestPath } from "./codeTooling.js";

/**
 * Measured test coverage, read from a CI artefact for display only. Nothing here feeds `codeHealth`, `judge` or any
 * grade: a figure that CI published says what ran, not whether the tests are good (ADR 0030).
 *
 * The API reads the artefact and parses it; this module holds the shapes it stores and the pure steps that turn
 * reports into figures about this repository's own files.
 */

/** The coverage file formats that are read, in the order `alignCoverage` prefers when one directory holds several. */
export const COVERAGE_FORMATS = ["lcov", "istanbul-final", "cobertura", "istanbul-summary"] as const;

export type CoverageFormat = (typeof COVERAGE_FORMATS)[number];

/** Whole numbers, never negative, with `covered` no greater than `total`. Build one with `coverageCount`. */
export interface CoverageCount {
  covered: number;
  total: number;
}

/**
 * A count, or null when the pair is impossible: not whole, negative, or more covered than there are. Reports come from
 * CI and are not trusted, so every count read from one goes through here before it can reach a share.
 */
export function coverageCount(covered: unknown, total: unknown): CoverageCount | null {
  if (!Number.isSafeInteger(covered) || !Number.isSafeInteger(total)) return null;
  const c = covered as number;
  const t = total as number;
  return c >= 0 && c <= t ? { covered: c, total: t } : null;
}

/** An inclusive range of line numbers, `[first, last]`. */
export type LineRange = [number, number];

/**
 * Which instrumented lines ran and which never did, as ranges. Every instrumented line is in exactly one list, so the
 * two together also say which lines carry code, and a file has both lists or neither.
 */
export interface LineRanges {
  covered: LineRange[];
  uncovered: LineRange[];
}

/** What a report says about one file. */
export interface CoverageFileReport {
  /** The path as the report wrote it, normalised by the parser. After `alignCoverage` it is the repository path. */
  path: string;
  lines: CoverageCount;
  branches?: CoverageCount;
  functions?: CoverageCount;
  /**
   * Absent when the format has no per-line hits, or when the file has more runs of lines than the reader keeps; the
   * file then has its exact totals and nothing finer, so no figure is worked out from a list that was cut short.
   */
  ranges?: LineRanges;
}

/** One coverage file parsed from an artefact. */
export interface CoverageReport {
  format: CoverageFormat;
  /** The name of the artefact it came from. */
  artefact: string;
  /** The directory of the file inside the archive, a hint for which part of the repository it covers. */
  dir: string;
  /** Cobertura `<source>` roots, which its relative file names are relative to. */
  sourceRoots?: string[];
  files: CoverageFileReport[];
}

/** A coverage artefact on the code host. */
export interface CoverageArtefact {
  id: number;
  name: string;
  sizeBytes: number;
  /** ISO 8601. */
  createdAt: string;
  /** The workflow run that produced it. */
  runId: number;
  /** The commit that run built. */
  commitSha: string;
}

/**
 * Bumped when the stored shape changes. A snapshot of another version is not shown, and the next crawl reads its run
 * again because `CoverageService` only skips a run it has already read at this version.
 */
export const COVERAGE_SNAPSHOT_VERSION = 2;

/** The run that coverage is read from. */
export interface CoverageRun {
  runId: number;
  /** The commit the run built. */
  commitSha: string;
  /** The run's coverage artefacts that are read, newest first. Never empty. */
  artefacts: CoverageArtefact[];
  /** How many coverage artefacts the run had, which is more than `artefacts.length` when some were left unread. */
  artefactsInRun: number;
}

interface CoverageReadBase {
  fetchedAt: string;
  version: number;
}

/** A read that found a run and parsed at least one report from it. */
export interface CoverageRead extends CoverageReadBase, CoverageRun {
  reports: CoverageReport[];
  /** Coverage files in the artefacts that could not be parsed. They are left out and the rest are kept. */
  unreadableFiles: number;
  error: null;
}

/** A read that failed. The run and commit are null when it failed before a run was chosen. */
export interface CoverageReadFailure extends CoverageReadBase {
  runId: number | null;
  commitSha: string | null;
  artefacts: CoverageArtefact[];
  reports: [];
  error: string;
}

/** What one read of a repository's coverage found. `error` tells the two apart, and is null exactly when the read succeeded. */
export type CoverageSnapshot = CoverageRead | CoverageReadFailure;

/** The artefacts whose name says they hold coverage, in any letter case. */
export const isCoverageArtefactName = (name: string): boolean => /coverage/i.test(name);

export const MAX_RUN_ARTEFACTS = 5;

/**
 * The run to read coverage from: the newest run that built the analysed commit, otherwise the newest run. That run's
 * artefacts are returned, newest first and at most `max` (at least one), so a matrix that uploads `coverage-api` and
 * `coverage-web` keeps both. Null when nothing was found.
 */
export function chooseCoverageRun(
  found: readonly CoverageArtefact[],
  analysedSha: string | null,
  max = MAX_RUN_ARTEFACTS,
): CoverageRun | null {
  const newest = (a: CoverageArtefact, b: CoverageArtefact) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id;
  const sorted = [...found].sort(newest);
  const chosen = (analysedSha ? sorted.find((a) => a.commitSha === analysedSha) : undefined) ?? sorted[0];
  if (!chosen) return null;
  const inRun = sorted.filter((a) => a.runId === chosen.runId);
  return {
    runId: chosen.runId,
    commitSha: chosen.commitSha,
    artefacts: inRun.slice(0, Math.max(max, 1)),
    artefactsInRun: inRun.length,
  };
}

// ---- line ranges ----------------------------------------------------------------------------------------------

const isLineRange = (range: unknown): range is LineRange =>
  Array.isArray(range) &&
  range.length === 2 &&
  Number.isSafeInteger(range[0]) &&
  Number.isSafeInteger(range[1]) &&
  (range[0] as number) >= 1 &&
  (range[0] as number) <= (range[1] as number);

/** The lines in a set of ranges, counting each line once however the ranges overlap. */
export const lineCount = (ranges: readonly LineRange[]): number => joinRanges(ranges).reduce((n, [a, b]) => n + b - a + 1, 0);

/** The same lines as sorted, disjoint ranges, with ranges that overlap or touch joined into one. */
export function joinRanges(ranges: readonly LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  for (const [first, last] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const previous = out[out.length - 1];
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else out.push([first, last]);
  }
  return out;
}

/** The lines of `from` that are not in `remove`. Both must be sorted and disjoint, as `joinRanges` returns them. */
function withoutRanges(from: readonly LineRange[], remove: readonly LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  let next = 0;
  for (const [first, last] of from) {
    while (next < remove.length && remove[next]![1] < first) next++;
    let start = first;
    for (let i = next; start <= last; i++) {
      const cut = remove[i];
      if (!cut || cut[0] > last) {
        out.push([start, last]);
        break;
      }
      if (cut[0] > start) out.push([start, cut[0] - 1]);
      start = Math.max(start, cut[1] + 1);
    }
  }
  return out;
}

/**
 * One file as two reports saw it, such as the unit and the integration artefacts of a matrix. With line ranges on both
 * sides a line ran when it ran in either, which is the true figure. Without them the side with line ranges wins, then
 * the side with more lines covered. Branch and function counts cannot be joined, as reports do not say which branch or
 * function each count is, so the higher of the two is kept.
 */
function mergeFile(a: AlignedFile, b: AlignedFile): AlignedFile {
  const better = (x: CoverageCount | undefined, y: CoverageCount | undefined) =>
    !x ? y : !y ? x : y.covered > x.covered || (y.covered === x.covered && y.total > x.total) ? y : x;
  let base: AlignedFile;
  if (a.ranges && b.ranges) {
    const instrumented = joinRanges([...a.ranges.covered, ...a.ranges.uncovered, ...b.ranges.covered, ...b.ranges.uncovered]);
    const covered = joinRanges([...a.ranges.covered, ...b.ranges.covered]);
    const uncovered = withoutRanges(instrumented, covered);
    base = { ...a, lines: { covered: lineCount(covered), total: lineCount(instrumented) }, ranges: { covered, uncovered } };
  } else if (a.ranges || b.ranges) {
    base = a.ranges ? a : b;
  } else {
    base = b.lines.covered > a.lines.covered ? b : a;
  }
  const merged: AlignedFile = { ...base };
  delete merged.branches;
  delete merged.functions;
  const branches = better(a.branches, b.branches);
  const functions = better(a.functions, b.functions);
  if (branches) merged.branches = branches;
  if (functions) merged.functions = functions;
  return merged;
}

/**
 * A file report with every impossible figure removed, or null when its line count is impossible. Ranges that are not
 * whole, ascending line numbers, or whose lines disagree with the line count, are dropped and the totals kept.
 */
function trusted(file: CoverageFileReport): CoverageFileReport | null {
  const lines = coverageCount(file.lines?.covered, file.lines?.total);
  if (!lines) return null;
  const out: CoverageFileReport = { path: file.path, lines };
  const branches = file.branches && coverageCount(file.branches.covered, file.branches.total);
  const functions = file.functions && coverageCount(file.functions.covered, file.functions.total);
  if (branches) out.branches = branches;
  if (functions) out.functions = functions;
  const ranges = file.ranges;
  if (
    ranges &&
    Array.isArray(ranges.covered) &&
    Array.isArray(ranges.uncovered) &&
    ranges.covered.every(isLineRange) &&
    ranges.uncovered.every(isLineRange) &&
    lineCount(ranges.covered) === lines.covered &&
    lineCount(ranges.uncovered) === lines.total - lines.covered &&
    lineCount([...ranges.covered, ...ranges.uncovered]) === lines.total
  ) {
    out.ranges = { covered: ranges.covered, uncovered: ranges.uncovered };
  }
  return out;
}

// ---- alignment ----------------------------------------------------------------------------------------------

/** A file's coverage once its path is a repository path. */
export interface AlignedFile extends CoverageFileReport {
  format: CoverageFormat;
  artefact: string;
}

export interface AlignedCoverage {
  /** Source files of this repository that the reports cover, by repository path. */
  readonly files: ReadonlyMap<string, AlignedFile>;
  /** Distinct source files the reports name, whether or not they match a file here. Test files are not counted. */
  readonly inReport: number;
  readonly matched: number;
  /** `inReport - matched`. Their paths never leave the API, because a runner path can hold a person's or a client's name. */
  readonly unmatched: number;
  /** True when any matched file carries line ranges, so the report says which lines ran and not only totals. */
  readonly lineDetail: boolean;
}

const MAX_NAME_CANDIDATES = 50;

const isAbsolute = (raw: string) => /^(file:|[\\/]|[A-Za-z]:)/.test(raw);

/** Segments of a path with separators, `file://`, a drive letter, `.` and `..` dealt with. `..` above the start is dropped. */
function segmentsOf(raw: string): string[] {
  const text = raw
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^[A-Za-z]:(\/|$)/, "");
  const out: string[] = [];
  for (const part of text.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

interface Transform {
  /** Leading segments removed from the path, joined by "/". Empty strips nothing. */
  strip: string;
  /** Segments put in their place, joined by "/". */
  add: string;
}

const keyOf = (t: Transform) => `${t.strip}\u0000${t.add}`;

function apply(segments: readonly string[], t: Transform): string {
  const strip = t.strip === "" ? [] : t.strip.split("/");
  if (strip.some((part, i) => segments[i] !== part)) return "";
  const rest = segments.slice(strip.length);
  return (t.add === "" ? rest : [...t.add.split("/"), ...rest]).join("/");
}

/** The variants of a report path to try: relative to each Cobertura source root when it is relative, and as written. */
function variantsOf(raw: string, roots: readonly string[] | undefined): string[][] {
  const plain = segmentsOf(raw);
  if (!roots || roots.length === 0 || isAbsolute(raw)) return [plain];
  return [...roots.map((root) => segmentsOf(`${root}/${raw}`)), plain];
}

/** The transform that maps `from` onto `to` by their longest common run of trailing segments, or null when they share none. */
function transformBetween(from: readonly string[], to: readonly string[]): Transform | null {
  let common = 0;
  while (common < from.length && common < to.length && from[from.length - 1 - common] === to[to.length - 1 - common]) common++;
  if (common === 0) return null;
  return { strip: from.slice(0, from.length - common).join("/"), add: to.slice(0, to.length - common).join("/") };
}

function hintScore(dir: string, add: string): number {
  if (add === "") return 0;
  const hint = `/${segmentsOf(dir).join("/")}/`;
  return hint.includes(`/${add}/`) ? 1 : 0;
}

interface Entry {
  raw: string;
  variants: string[][];
  file: CoverageFileReport;
}

/** The repository's files, indexed by every run of trailing segments, so a report path finds its best matches by lookup. */
interface KnownIndex {
  paths: ReadonlySet<string>;
  /** Each key is the last `k` segments of one or more files, joined by "/", for every `k` up to the file's depth. */
  suffixes: ReadonlyMap<string, string[][]>;
}

function indexKnown(knownFiles: ReadonlySet<string>): KnownIndex {
  const suffixes = new Map<string, string[][]>();
  for (const path of knownFiles) {
    const segments = path.split("/");
    for (let k = 1; k <= segments.length; k++) {
      const key = segments.slice(segments.length - k).join("/");
      const list = suffixes.get(key);
      if (list) list.push(segments);
      else suffixes.set(key, [segments]);
    }
  }
  return { paths: knownFiles, suffixes };
}

/**
 * The known files that share the most trailing segments with `variant`. Ranking by shared segments means that a
 * package where every file is called `index.ts` still offers the file whose directories also agree with the report's
 * path. The whole group is returned, so the caller can tell when it is too large to enumerate.
 */
function nearestKnown(variant: readonly string[], index: KnownIndex): string[][] {
  let best: string[][] = [];
  for (let k = 1; k <= variant.length; k++) {
    const list = index.suffixes.get(variant.slice(variant.length - k).join("/"));
    if (!list) break;
    best = list;
  }
  return best;
}

type Votes = Map<string, { transform: Transform; count: number }>;

function vote(votes: Votes, keys: Set<string>, transform: Transform): void {
  const key = keyOf(transform);
  if (keys.has(key)) return;
  keys.add(key);
  const existing = votes.get(key);
  if (existing) existing.count++;
  else votes.set(key, { transform, count: 1 });
}

/**
 * The transform most entries agree on; ties go to the directory hint, then to the fewest segments added.
 *
 * A path whose best matches are more than `MAX_NAME_CANDIDATES` files (a package full of `index.ts`) cannot say much by
 * itself, so it is held back. The paths that name few files vote first. The held-back paths then vote only for the
 * leading transforms, by a single lookup each, so that they back the right package without a vote for every package. If
 * nothing else voted, they vote for their first candidates, and a transform stands only when it alone leads with at
 * least two paths behind it (or alone matches the directory hint among the leaders), so that a name shared by many
 * files never puts a report on an arbitrary package. Such paths are then left unmatched and counted.
 */
function bestTransform(entries: readonly Entry[], index: KnownIndex, dir: string): Transform | null {
  const votes: Votes = new Map();
  const held: { variant: string[]; keys: Set<string>; candidates: string[][] }[] = [];
  for (const entry of entries) {
    const keys = new Set<string>();
    for (const variant of entry.variants) {
      const candidates = nearestKnown(variant, index);
      if (candidates.length > MAX_NAME_CANDIDATES) {
        held.push({ variant, keys, candidates });
        continue;
      }
      for (const known of candidates) {
        const transform = transformBetween(variant, known);
        if (transform) vote(votes, keys, transform);
      }
    }
  }
  if (votes.size === 0) {
    for (const { variant, keys, candidates } of held) {
      for (const known of candidates.slice(0, MAX_NAME_CANDIDATES)) {
        const transform = transformBetween(variant, known);
        if (transform) vote(votes, keys, transform);
      }
    }
    // One path alone, or several whose votes tie across packages, would pick an arbitrary package among the files that
    // share a name, so only a single leader backed by at least two paths stands, with the directory hint as tie-break.
    const top = [...votes.values()].reduce((most, v) => Math.max(most, v.count), 0);
    let leaders = top >= 2 ? [...votes.entries()].filter(([, v]) => v.count === top) : [];
    if (leaders.length > 1) leaders = leaders.filter(([, v]) => hintScore(dir, v.transform.add) > 0);
    const keep = leaders.length === 1 ? leaders[0]![0] : null;
    for (const key of [...votes.keys()]) if (key !== keep) votes.delete(key);
  } else if (held.length > 0) {
    const leaders = [...votes.values()]
      .sort((a, b) => b.count - a.count || (keyOf(a.transform) < keyOf(b.transform) ? -1 : 1))
      .slice(0, MAX_NAME_CANDIDATES);
    for (const { variant, keys } of held) {
      for (const leader of leaders) {
        const target = apply(variant, leader.transform);
        if (target !== "" && index.paths.has(target)) vote(votes, keys, leader.transform);
      }
    }
  }
  let best: { transform: Transform; count: number } | null = null;
  const segmentsAdded = (t: Transform) => (t.add === "" ? 0 : t.add.split("/").length);
  for (const vote of votes.values()) {
    if (!best) best = vote;
    else if (vote.count !== best.count) best = vote.count > best.count ? vote : best;
    else {
      const byHint = hintScore(dir, vote.transform.add) - hintScore(dir, best.transform.add);
      const byAdded = segmentsAdded(best.transform) - segmentsAdded(vote.transform);
      const byKey = keyOf(vote.transform) < keyOf(best.transform) ? 1 : -1;
      if ((byHint || byAdded || byKey) > 0) best = vote;
    }
  }
  return best ? best.transform : null;
}

/**
 * The one known file whose path ends the report's path or is ended by it, or null when none or several do. Both
 * directions are lookups in the index (the known files that end with the whole text, and each tail of the text that is
 * itself a known file), and the search stops at the second file, so the cost is bounded by the depth of the path.
 *
 * A tail is tried only when it has at least two segments, and never when the report's own layout (`winner`) already
 * places the path under the root it strips: such a path sits in the checkout but is not a file of this repository, such
 * as `node_modules/foo/index.ts`, and a tail like `index.ts` would otherwise put its figures on an unrelated file.
 */
function uniqueSuffixMatch(variants: readonly string[][], index: KnownIndex, winner: Transform | null): string | null {
  const found = new Set<string>();
  for (const variant of variants) {
    if (variant.length === 0) continue;
    for (const known of index.suffixes.get(variant.join("/")) ?? []) {
      found.add(known.join("/"));
      if (found.size > 1) return null;
    }
    if (winner && winner.strip !== "" && apply(variant, winner) !== "") continue;
    for (let k = 2; k < variant.length; k++) {
      const tail = variant.slice(variant.length - k).join("/");
      if (index.paths.has(tail)) found.add(tail);
      if (found.size > 1) return null;
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

/** Keeps only the best-ranked format among the reports that share an artefact and directory. */
function bestFormatPerDirectory(reports: readonly CoverageReport[]): CoverageReport[] {
  const rank = (r: CoverageReport) => COVERAGE_FORMATS.indexOf(r.format);
  const best = new Map<string, number>();
  for (const r of reports) {
    const key = `${r.artefact}\u0000${r.dir}`;
    best.set(key, Math.min(best.get(key) ?? Infinity, rank(r)));
  }
  return reports.filter((r) => rank(r) === best.get(`${r.artefact}\u0000${r.dir}`));
}

/**
 * Maps the paths in coverage reports onto this repository's files.
 *
 * Reports name files in their own way: relative to a package, or as absolute runner paths such as
 * `/home/runner/work/widgets/widgets/src/a.ts`. For each report the paths vote on the transform that adds a prefix or
 * strips one so that they land on the known files that share the most trailing segments with them, and the transform
 * with most votes is applied. A path still unmatched falls back to a suffix match that must be unique. Several formats
 * in one directory are reduced to the best one (lcov, then Istanbul final, then Cobertura, then Istanbul summary), a
 * file covered by several reports is merged (`mergeFile`), impossible figures are dropped (`trusted`), and test files
 * are dropped.
 */
export function alignCoverage(reports: readonly CoverageReport[], knownFiles: readonly string[]): AlignedCoverage {
  const known = new Set(knownFiles);
  const index = indexKnown(known);

  const files = new Map<string, AlignedFile>();
  // Unmatched entries are told apart by where the report sits as well as by path: the same relative path in two report
  // directories can be two different files.
  const unmatched = new Map<string, string[][]>();
  const winners: Transform[] = [];
  for (const report of bestFormatPerDirectory(reports)) {
    const entries: Entry[] = report.files
      .map((raw) => trusted(raw))
      .filter((file): file is CoverageFileReport => file !== null)
      .map((file) => ({ raw: file.path, variants: variantsOf(file.path, report.sourceRoots), file }))
      .filter((entry) => !isTestPath(entry.variants[entry.variants.length - 1]!.join("/")));
    const winner = bestTransform(entries, index, report.dir);
    if (winner) winners.push(winner);
    for (const entry of entries) {
      const viaVote = winner ? entry.variants.map((v) => apply(v, winner)).find((p) => known.has(p)) : undefined;
      const target = viaVote ?? uniqueSuffixMatch(entry.variants, index, winner);
      if (!target || isTestPath(target)) {
        if (!target) {
          const path = entry.variants[entry.variants.length - 1]!.join("/");
          unmatched.set(`${report.artefact}\u0000${report.dir}\u0000${path}`, entry.variants);
        }
        continue;
      }
      const candidate: AlignedFile = { ...entry.file, path: target, format: report.format, artefact: report.artefact };
      const existing = files.get(target);
      files.set(target, existing ? mergeFile(existing, candidate) : candidate);
    }
  }
  // A path that one report could not place is not a stray file when another report's layout puts it on a file that
  // is already matched.
  let strays = 0;
  for (const variants of unmatched.values()) {
    const placedElsewhere = winners.some((w) => variants.some((v) => files.has(apply(v, w))));
    if (!placedElsewhere) strays++;
  }
  const lineDetail = [...files.values()].some((f) => f.ranges !== undefined);
  return { files, inReport: files.size + strays, matched: files.size, unmatched: strays, lineDetail };
}
