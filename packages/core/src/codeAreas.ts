import type { CodeLayout } from "./codeHealth.js";
import { matchesWorkspaces } from "./codeLayout.js";
import { isCodeFile, isTestPath } from "./codeTooling.js";

/**
 * Breaks a repository into areas: the packages of a monorepo, or the main source folders of anything else (ADR 0029).
 * The rules run on request over the stored file list, so changing them needs no new crawl.
 */

/** `workspace` is a package or project with its own manifest, `folder` a source folder, `root` the files at the top. */
export type AreaKind = "workspace" | "folder" | "root";

/**
 * How the areas were found. `workspace` means from workspace declarations or several manifests, `folder` from the source
 * layout, and `unknown` that the snapshot has no file list, because it predates version 6 or its listing could not be
 * read, so only function paths were available.
 */
export type AreaMode = "workspace" | "folder" | "unknown";

export interface CodeArea {
  /** Directory relative to the repository root, or "." for the files at the root. */
  path: string;
  kind: AreaKind;
}

export interface CodeAreas {
  mode: AreaMode;
  /** Sorted by path. Every file given to `codeAreas` belongs to exactly one of them. */
  areas: CodeArea[];
}

/** The path of the area that holds files at the repository root. */
export const ROOT_AREA = ".";

const FIXTURE_DIRECTORIES = new Set(["fixtures", "__fixtures__", "testdata", "test-data", "__snapshots__"]);
const MAX_DEPTH = 10;
const DOMINANT_SHARE = 0.8;

const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

const joinPath = (base: string, name: string) => (base === "" ? name : `${base}/${name}`);

const inFixtureOrTest = (dir: string) =>
  isTestPath(`${dir}/x`) || dir.split("/").some((segment) => FIXTURE_DIRECTORIES.has(segment.toLowerCase()));

/** Product source: a code file outside any test or fixture directory and not named as a test. */
const isSource = (file: string) => isCodeFile(file) && !isTestPath(file) && !inFixtureOrTest(dirOf(file));

/** Every directory that holds a code file at any depth below it, so an empty or code-free manifest folder can be dropped. */
function directoriesWithCode(files: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    if (!isCodeFile(file)) continue;
    for (let dir = dirOf(file); dir !== "" && !dirs.has(dir); dir = dirOf(dir)) dirs.add(dir);
  }
  return dirs;
}

/** The directories of manifests that could be an area, shallowest first. */
function candidateDirectories(files: readonly string[], layout: CodeLayout): string[] {
  const withCode = directoriesWithCode(files);
  const dirs = new Set<string>();
  for (const manifest of layout.manifests) {
    const dir = dirOf(manifest);
    if (dir !== "" && !inFixtureOrTest(dir) && withCode.has(dir)) dirs.add(dir);
  }
  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** Keeps the outermost of nested directories, so a manifest inside a package does not become an area of its own. */
function outermost(dirs: readonly string[]): string[] {
  const kept: string[] = [];
  for (const dir of dirs) if (!kept.some((outer) => dir.startsWith(`${outer}/`))) kept.push(dir);
  return kept;
}

/** How many of `files` sit below each immediate child directory of `base`. Files directly in `base` count for nothing. */
function childCounts(files: readonly string[], base: string): Map<string, number> {
  const counts = new Map<string, number>();
  const skip = base === "" ? 0 : base.length + 1;
  for (const file of files) {
    const slash = file.indexOf("/", skip);
    if (slash === -1) continue;
    const child = file.slice(skip, slash);
    counts.set(child, (counts.get(child) ?? 0) + 1);
  }
  return counts;
}

const below = (files: readonly string[], base: string) => (base === "" ? files : files.filter((f) => f.startsWith(`${base}/`)));

/**
 * The child directories to treat as areas when no workspace is declared. It starts at `src/` when that holds source and
 * at the root otherwise, and keeps descending while one child holds at least 80% of the source, which finds `src/<pkg>`
 * in Python and `src/main/java/...` in Java. It stops before a child that has no source subdirectory of its own.
 */
function folderAreaPaths(source: readonly string[]): string[] {
  let base = source.some((f) => f.startsWith("src/")) ? "src" : "";
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const here = below(source, base);
    let top: [string, number] | null = null;
    for (const entry of [...childCounts(here, base)].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!top || entry[1] > top[1]) top = entry;
    }
    if (!top || top[1] / here.length < DOMINANT_SHARE) break;
    const next = joinPath(base, top[0]);
    if (childCounts(below(source, next), next).size === 0) break;
    base = next;
  }
  return [...childCounts(below(source, base), base).keys()].map((name) => joinPath(base, name));
}

/** The area directories under the declared or inferred layout, with the mode they came from. */
function layoutAreaPaths(files: readonly string[], layout: CodeLayout): { mode: AreaMode; paths: string[] } {
  const candidates = candidateDirectories(files, layout);
  if (layout.workspaces) {
    const declared = outermost(candidates.filter((dir) => matchesWorkspaces(dir, layout.workspaces!)));
    if (declared.length > 0) return { mode: "workspace", paths: declared };
  }
  const found = outermost(candidates);
  if (found.length >= 2) return { mode: "workspace", paths: found };
  return { mode: "folder", paths: folderAreaPaths(files.filter(isSource)) };
}

/**
 * Decides the areas of a repository from its file list and layout. A snapshot from before version 6 has neither, so
 * pass the function paths with a null layout; the folder rules then run and the mode is `unknown`.
 *
 * 1. Candidates are the directories of manifests, less the root, test and fixture directories and any with no code.
 * 2. Declared workspaces: candidates matching a positive pattern and no `!` pattern are areas, outermost only.
 * 3. Otherwise two or more candidates, outermost only, are areas; one alone is not enough, so
 * 4. folder mode takes the source folders instead.
 * 5. Files outside every area are grouped by top-level folder, and files at the root form `.`.
 */
export function codeAreas(files: readonly string[], layout: CodeLayout | null | undefined): CodeAreas {
  const { mode, paths } = layout
    ? layoutAreaPaths(files, layout)
    : { mode: "unknown" as const, paths: folderAreaPaths(files.filter(isSource)) };
  const kind: AreaKind = mode === "workspace" ? "workspace" : "folder";
  const areas = new Map<string, CodeArea>(paths.map((path) => [path, { path, kind }]));
  const locate = areaLocator([...areas.values()]);

  for (const file of files) {
    if (locate(file) !== null) continue;
    const slash = file.indexOf("/");
    if (slash === -1) areas.set(ROOT_AREA, { path: ROOT_AREA, kind: "root" });
    else areas.set(file.slice(0, slash), { path: file.slice(0, slash), kind: "folder" });
  }
  return { mode, areas: [...areas.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * A lookup from a file to the path of its area, by the longest `path/` prefix; null when no area holds it. Build it once
 * for many files. Files with no directory belong to the `.` area when there is one.
 */
export function areaLocator(areas: readonly CodeArea[]): (file: string) => string | null {
  const paths = new Set(areas.map((a) => a.path));
  return (file) => {
    for (let dir = dirOf(file); dir !== ""; dir = dirOf(dir)) if (paths.has(dir)) return dir;
    return paths.has(ROOT_AREA) && !file.includes("/") ? ROOT_AREA : null;
  };
}

/** The path of the area that holds `file`, by the longest `path/` prefix, or null when none does. */
export const areaOf = (file: string, areas: readonly CodeArea[]): string | null => areaLocator(areas)(file);
