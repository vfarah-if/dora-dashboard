import { baseName, type CandidateFile } from "./codeTooling.js";

/**
 * How a repository is laid out: which files are manifests and which workspaces the root declares. Everything here is
 * pure and reads untrusted text, so every step is bounded and no pattern runs over more than one short line.
 */

const MANIFEST_NAMES = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "project.json",
  "composer.json",
  "mix.exs",
  "pubspec.yaml",
  "Package.swift",
  "deno.json",
]);

const MANIFEST_SUFFIXES = [".csproj", ".fsproj", ".gemspec"];

/** The root files that can declare workspaces. The caller reads them (at most 256 KiB each) and passes them to `workspacePatterns`. */
export const WORKSPACE_FILES: readonly string[] = ["package.json", "pnpm-workspace.yaml", "lerna.json"];

const MAX_LINES = 2_000;
const MAX_LINE = 1_000;
const MAX_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 300;
const MAX_SEGMENTS = 64;

/** True when the file's base name marks a package, crate, module or project, in any directory. */
export function isManifest(path: string): boolean {
  const name = baseName(path);
  if (MANIFEST_NAMES.has(name)) return true;
  return name.length > 0 && MANIFEST_SUFFIXES.some((suffix) => name.length > suffix.length && name.endsWith(suffix));
}

const unquote = (text: string): string => {
  const value = text.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) return value.slice(1, -1);
  return value;
};

/** Drops a trailing ` # comment`, which in YAML only starts after whitespace. */
const withoutComment = (line: string) => line.replace(/(^|\s)#.*$/, "").trimEnd();

const keepPatterns = (values: unknown): string[] =>
  Array.isArray(values)
    ? values.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_PATTERN_LENGTH)
    : [];

function fromJson(content: string, key: "workspaces" | "packages"): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const field = (parsed as Record<string, unknown>)[key];
  if (Array.isArray(field)) return keepPatterns(field);
  // Yarn and npm also accept `{ "packages": [...] }`.
  if (key === "workspaces" && typeof field === "object" && field !== null) {
    return keepPatterns((field as Record<string, unknown>).packages);
  }
  return [];
}

/** The items of a flow sequence such as `['a', "b/*"]`, with the brackets already removed. */
const flowItems = (inner: string): string[] =>
  inner
    .split(",")
    .map(unquote)
    .filter((v) => v.length > 0);

/**
 * The `packages:` list of a pnpm workspace file, in block style (`- a`) or flow style (`[a, b]`, on one line or
 * several). It reads lines and nothing else, so no YAML parser is needed and no input can make it loop.
 */
function fromPnpm(content: string): string[] {
  const lines = content.split(/\r?\n/, MAX_LINES);
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = withoutComment(lines[i]!.slice(0, MAX_LINE));
    const head = /^packages\s*:(.*)$/.exec(line);
    if (!head) continue;
    const rest = (head[1] ?? "").trim();
    if (rest.startsWith("[")) {
      let flow = rest;
      for (let j = i + 1; !flow.includes("]") && j < lines.length; j++)
        flow += ` ${withoutComment(lines[j]!.slice(0, MAX_LINE))}`;
      const close = flow.indexOf("]");
      return flowItems(flow.slice(1, close === -1 ? undefined : close)).slice(0, MAX_PATTERNS);
    }
    for (let j = i + 1; j < lines.length; j++) {
      const item = withoutComment(lines[j]!.slice(0, MAX_LINE));
      if (item.trim() === "") continue;
      if (!/^\s+-/.test(item) && !/^-/.test(item)) break;
      const value = unquote(item.replace(/^\s*-\s*/, ""));
      if (value) found.push(value);
      if (found.length >= MAX_PATTERNS) break;
    }
    return found.slice(0, MAX_PATTERNS);
  }
  return found;
}

/**
 * The workspace patterns the root files declare, or null when they declare none. Reads the `workspaces` field of
 * `package.json` (an array, or an object with `packages`), the `packages:` list of `pnpm-workspace.yaml` and the
 * `packages` field of `lerna.json`. Paths are matched by their root-relative name; other files are ignored.
 */
export function workspacePatterns(rootFiles: readonly CandidateFile[]): string[] | null {
  const patterns: string[] = [];
  for (const file of rootFiles) {
    if (file.path === "package.json") patterns.push(...fromJson(file.content, "workspaces"));
    else if (file.path === "pnpm-workspace.yaml") patterns.push(...fromPnpm(file.content));
    else if (file.path === "lerna.json") patterns.push(...fromJson(file.content, "packages"));
  }
  const unique = [...new Set(patterns)].slice(0, MAX_PATTERNS);
  return unique.length === 0 ? null : unique;
}

const normalise = (text: string): string[] =>
  text
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .slice(0, MAX_SEGMENTS);

/** `*` and `?` within one segment, by a two-pointer walk that backtracks to the last `*` only, so it stays quadratic at worst. */
function matchSegment(text: string, pattern: string): boolean {
  let t = 0;
  let p = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      t++;
      p++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Whole-path match, where `**` stands for any number of segments, including none. */
function matchSegments(path: string[], pattern: string[]): boolean {
  // reach[j] is true when the first i path segments match the first j pattern segments.
  let reach = new Array<boolean>(pattern.length + 1).fill(false);
  reach[0] = true;
  for (let j = 0; j < pattern.length; j++) reach[j + 1] = reach[j]! && pattern[j] === "**";
  for (const segment of path) {
    const next = new Array<boolean>(pattern.length + 1).fill(false);
    for (let j = 0; j < pattern.length; j++) {
      const part = pattern[j]!;
      if (part === "**") next[j + 1] = next[j]! || reach[j + 1]! || reach[j]!;
      else next[j + 1] = reach[j]! && matchSegment(segment, part);
    }
    reach = next;
  }
  return reach[pattern.length]!;
}

/**
 * Whether a directory path matches a workspace pattern, one segment at a time. Supports `*`, `?`, `**` and a leading `!`
 * (which inverts the result). A leading `./` and a trailing `/` are ignored. Brace patterns such as `{a,b}` are not
 * supported and match nothing but themselves.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const negated = pattern.startsWith("!");
  const body = normalise(negated ? pattern.slice(1) : pattern);
  const matched = matchSegments(normalise(path), body);
  return negated ? !matched : matched;
}

/** True when the path matches a positive pattern and none of the `!` patterns, which is how package managers read the list. */
export function matchesWorkspaces(path: string, patterns: readonly string[]): boolean {
  const positive = patterns.filter((p) => !p.startsWith("!"));
  const negative = patterns.filter((p) => p.startsWith("!"));
  return positive.some((p) => matchesGlob(path, p)) && negative.every((p) => matchesGlob(path, p));
}
