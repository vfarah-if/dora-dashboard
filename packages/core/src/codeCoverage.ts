import { isTestPath } from "./codeTooling.js";

/**
 * Measured test coverage, read from a CI artefact for display only. Nothing here feeds `codeHealth`, `judge` or any
 * grade: a figure that CI published says what ran, not whether the tests are good (ADR 0013).
 *
 * The API reads the artefact and parses it; this module holds the shapes it stores and the pure steps that turn
 * reports into figures about this repository's own files.
 */

/** A coverage file format, in the order `alignCoverage` prefers when one directory holds several. */
export type CoverageFormat = "lcov" | "istanbul-final" | "cobertura" | "istanbul-summary";

export interface CoverageCount {
  covered: number;
  total: number;
}

/** An inclusive range of line numbers, `[first, last]`. */
export type LineRange = [number, number];

/** What a report says about one file. Ranges are present only when the format carries per-line hits. */
export interface CoverageFileReport {
  /** The path as the report wrote it, normalised by the parser. After `alignCoverage` it is the repository path. */
  path: string;
  lines: CoverageCount;
  branches?: CoverageCount;
  functions?: CoverageCount;
  /** Lines that ran at least once, as ranges. Kept as well as `uncovered`, so a line with no code can be told from one never run. */
  covered?: LineRange[];
  /** Instrumented lines that never ran, as ranges. */
  uncovered?: LineRange[];
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

/** Bumped when the stored shape changes, so older snapshots are read again. */
export const COVERAGE_SNAPSHOT_VERSION = 1;

/** What one read of a repository's coverage found. `error` is set, with no reports, when the read failed. */
export interface CoverageSnapshot {
  fetchedAt: string;
  version: number;
  artefacts: CoverageArtefact[];
  /** Null on an error snapshot that never found a run. */
  runId: number | null;
  commitSha: string | null;
  reports: CoverageReport[];
  error?: string | null;
}

/** The artefacts whose name says they hold coverage, in any letter case. */
export const isCoverageArtefactName = (name: string): boolean => /coverage/i.test(name);

const MAX_RUN_ARTEFACTS = 5;

/**
 * The run to read coverage from: the newest run that built the analysed commit, otherwise the newest run. All of that
 * run's artefacts are returned, newest first and at most `max`, so a matrix that uploads `coverage-api` and
 * `coverage-web` keeps both. Empty when nothing was found.
 */
export function chooseCoverageRun(
  found: readonly CoverageArtefact[],
  analysedSha: string | null,
  max = MAX_RUN_ARTEFACTS,
): CoverageArtefact[] {
  const newest = (a: CoverageArtefact, b: CoverageArtefact) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id;
  const sorted = [...found].sort(newest);
  const chosen = (analysedSha ? sorted.find((a) => a.commitSha === analysedSha) : undefined) ?? sorted[0];
  if (!chosen) return [];
  return sorted.filter((a) => a.runId === chosen.runId).slice(0, Math.max(max, 0));
}

// ---- alignment ----------------------------------------------------------------------------------------------

/** A file's coverage once its path is a repository path. */
export interface AlignedFile extends CoverageFileReport {
  format: CoverageFormat;
  artefact: string;
}

export interface AlignedCoverage {
  /** Source files of this repository that the reports cover, by repository path. */
  files: Map<string, AlignedFile>;
  /** Distinct source files the reports name, whether or not they match a file here. Test files are not counted. */
  inReport: number;
  matched: number;
  /** `inReport - matched`. Their paths never leave the API, because a runner path can hold a person's or a client's name. */
  unmatched: number;
}

const FORMAT_PRIORITY: readonly CoverageFormat[] = ["lcov", "istanbul-final", "cobertura", "istanbul-summary"];
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
 * nothing else voted, they vote for the first candidates so that something is chosen.
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
 * directions are lookups in the index (a known file ending the text, and each tail of the text that is a known file),
 * and the search stops at the second file, so the cost is bounded by the depth of the path.
 */
function uniqueSuffixMatch(variants: readonly string[][], index: KnownIndex): string | null {
  const found = new Set<string>();
  for (const variant of variants) {
    if (variant.length === 0) continue;
    for (const known of index.suffixes.get(variant.join("/")) ?? []) {
      found.add(known.join("/"));
      if (found.size > 1) return null;
    }
    for (let k = 1; k < variant.length; k++) {
      const tail = variant.slice(variant.length - k).join("/");
      if (index.paths.has(tail)) found.add(tail);
      if (found.size > 1) return null;
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

/** Keeps only the best-ranked format among the reports that share an artefact and directory. */
function bestFormatPerDirectory(reports: readonly CoverageReport[]): CoverageReport[] {
  const rank = (r: CoverageReport) => FORMAT_PRIORITY.indexOf(r.format);
  const best = new Map<string, number>();
  for (const r of reports) {
    const key = `${r.artefact}\u0000${r.dir}`;
    best.set(key, Math.min(best.get(key) ?? Infinity, rank(r)));
  }
  return reports.filter((r) => rank(r) === best.get(`${r.artefact}\u0000${r.dir}`));
}

/** How much a file report says, so that the most detailed one wins when several cover the same file. */
const detail = (f: CoverageFileReport) => (f.covered || f.uncovered ? 4 : 0) + (f.branches ? 1 : 0) + (f.functions ? 1 : 0);

/**
 * Maps the paths in coverage reports onto this repository's files.
 *
 * Reports name files in their own way: relative to a package, or as absolute runner paths such as
 * `/home/runner/work/widgets/widgets/src/a.ts`. For each report the paths vote on the transform that adds a prefix or
 * strips one so that they land on known files by base name, and the transform with most votes is applied. A path
 * still unmatched falls back to a suffix match that must be unique. Several formats in one directory are reduced to
 * the best one (lcov, then Istanbul final, then Cobertura, then Istanbul summary), a file covered by several reports
 * keeps the most detailed, and test files are dropped.
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
      .map((file) => ({ raw: file.path, variants: variantsOf(file.path, report.sourceRoots), file }))
      .filter((entry) => !isTestPath(entry.variants[entry.variants.length - 1]!.join("/")));
    const winner = bestTransform(entries, index, report.dir);
    if (winner) winners.push(winner);
    for (const entry of entries) {
      const viaVote = winner ? entry.variants.map((v) => apply(v, winner)).find((p) => known.has(p)) : undefined;
      const target = viaVote ?? uniqueSuffixMatch(entry.variants, index);
      if (!target || isTestPath(target)) {
        if (!target) {
          const path = entry.variants[entry.variants.length - 1]!.join("/");
          unmatched.set(`${report.artefact}\u0000${report.dir}\u0000${path}`, entry.variants);
        }
        continue;
      }
      const candidate: AlignedFile = { ...entry.file, path: target, format: report.format, artefact: report.artefact };
      const existing = files.get(target);
      if (!existing || detail(candidate) > detail(existing)) files.set(target, candidate);
    }
  }
  // A path that one report could not place is not a stray file when another report's layout puts it on a file that
  // is already matched.
  let strays = 0;
  for (const variants of unmatched.values()) {
    const placedElsewhere = winners.some((w) => variants.some((v) => files.has(apply(v, w))));
    if (!placedElsewhere) strays++;
  }
  return { files, inReport: files.size + strays, matched: files.size, unmatched: strays };
}
