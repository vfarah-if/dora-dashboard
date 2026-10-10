/**
 * Paths and tooling facts read from a clone's files, never by running anything in it (ADR 0013).
 * Everything here is pure: the caller supplies file contents.
 */

export interface CandidateFile {
  path: string;
  content: string;
}

/** What the repository's own files say about linting, formatting and testing. Tool names are lower case. */
export interface ToolingFacts {
  /** Linters with a configuration file. */
  linters: string[];
  /** Formatters with a configuration file. `.editorconfig` is not one; see `weakFormatters`. */
  formatters: string[];
  /** Tools that only nudge editors, such as `.editorconfig`. They do not count as a formatter. */
  weakFormatters: string[];
  /** Linters that a CI workflow runs, directly or through a make target or package script. */
  ciLinters: string[];
  /** Formatters that a CI workflow runs in check mode, so unformatted code fails the build. */
  ciFormatChecks: string[];
  ciRunsTests: boolean;
  /** The lowest line coverage threshold found in a config file, as a percentage, or null when none is set. */
  coverageFloor: number | null;
}

const CODE_EXTENSIONS = new Set(
  "ts tsx mts cts js jsx mjs cjs py java kt kts go rs rb php cs swift scala c h cc cpp cxx hpp hh m mm lua pl sol vue dart zig".split(
    " ",
  ),
);

/** The last segment of a slash-separated path. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** True for a file in a language on a fixed list of extensions, whether or not an analyser is installed for it. */
export function isCodeFile(path: string): boolean {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && CODE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * A tool's configuration rather than the product's source: a dot-file such as `.ncurc.mjs` or `.eslintrc.cjs`, or a
 * name with `.config.` in it such as `vite.config.ts`. A module named `config.ts` is source. It goes by name alone, so
 * a product module named `database.config.ts` is missed and `karma.conf.js` or `jest.setup.ts` still count as source.
 * Only the pull request check uses this, so a configuration change alone does not read as source changed without
 * tests (ADR 0027).
 */
export function isToolConfig(path: string): boolean {
  const name = baseName(path);
  return name.startsWith(".") || name.includes(".config.");
}

const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "__mocks__", "spec"]);

/**
 * A file that holds tests: `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, `conftest.py`, `*_test.go`,
 * `*Test.java`, `*Tests.java`, `*Tests.cs`, `*_spec.rb`, `*Spec.scala`, `*Spec.kt`, or anything under a directory
 * named test, tests, __tests__, __mocks__ or spec (in any letter case).
 */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((s) => TEST_DIRECTORIES.has(s.toLowerCase()))) return true;
  return (
    /\.(test|spec)\./.test(name) ||
    /^test_.*\.py$/.test(name) ||
    name === "conftest.py" ||
    /_test\.(py|go)$/.test(name) ||
    /Tests?\.java$/.test(name) ||
    /Tests\.cs$/.test(name) ||
    /_spec\.rb$/.test(name) ||
    /Spec\.(scala|kt)$/.test(name)
  );
}

const CANDIDATE_NAMES: RegExp[] = [
  /^package\.json$/,
  /^(makefile|GNUmakefile)$/i,
  /^eslint\.config\.\w+$/,
  /^\.eslintrc(\.\w+)?$/,
  /^biome\.jsonc?$/,
  /^\.?ruff\.toml$/,
  /^pyproject\.toml$/,
  /^(setup\.cfg|tox\.ini|pytest\.ini|\.coveragerc|\.flake8|\.pylintrc|pylintrc)$/,
  /^\.golangci\.\w+$/,
  /^\.rubocop\.yml$/,
  /^\.?clippy\.toml$/,
  /^detekt\.ya?ml$/,
  /^build\.gradle(\.kts)?$/,
  /^\.prettierrc(\.\w+)?$/,
  /^prettier\.config\.\w+$/,
  /^\.?rustfmt\.toml$/,
  /^(go\.mod|Cargo\.toml|\.editorconfig)$/,
  /^(vitest|vite|jest)\.config\.\w+$/,
  /^vitest\.workspace\.\w+$/,
];

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** Whether `detectTooling` can use this file. Fixtures inside test directories are ignored. */
export function isToolingCandidate(path: string): boolean {
  if (WORKFLOW.test(path)) return true;
  if (isTestPath(path)) return false;
  const name = baseName(path);
  return CANDIDATE_NAMES.some((re) => re.test(name));
}

/**
 * The candidate paths to read. Every workflow file is always included, so a crowded repository cannot push its CI
 * configuration out; the rest are taken shallowest first, at most `limit` of them.
 */
export function toolingCandidates(paths: readonly string[], limit = 200): string[] {
  const depth = (p: string) => p.split("/").length;
  const wanted = paths.filter(isToolingCandidate);
  const rest = wanted
    .filter((p) => !WORKFLOW.test(p))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, limit);
  return [...rest, ...wanted.filter((p) => WORKFLOW.test(p))].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

// ---- command expansion ---------------------------------------------------------------------------------------
//
// Everything below reads untrusted text, so every step is bounded: lines are cut, expansions are capped, and no
// pattern runs over more than one short command at a time.

const MAX_LINE = 2_000;
const MAX_CI_CHARS = 1_000_000;
const MAX_MAKE_LINE = 4_096;
const MAX_MAKE_VARIABLE = 1_024;
const MAX_MAKE_EXPANSION = 262_144;

function parseJson(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Commands that put a tool on the machine rather than run it. */
const INSTALL =
  /^(?:sudo\s+)?(?:npm\s+(?:i|install|ci|add)|yarn\s+(?:add|install)|pnpm\s+(?:i|add|install)|bun\s+(?:add|install)|pip3?\s+install|pipx\s+install|uv\s+(?:tool\s+install|pip\s+install|add)|python3?\s+-m\s+pip\s+install|winget\s+install|choco\s+install|scoop\s+install|apt(?:-get)?\s+install|brew\s+install|cargo\s+install|go\s+install|gem\s+install|dotnet\s+tool\s+install)\b/;

/**
 * The commands on one line of a workflow, script or recipe that could run a tool. A `name:` label, an `echo` and an
 * install command mention tools without running them, so they yield nothing.
 */
function commandsOf(line: string): string[] {
  let text = line
    .slice(0, MAX_LINE)
    .replace(/\s#.*$/, "")
    .trim();
  text = text.replace(/^-\s+/, "");
  if (/^name\s*:/.test(text)) return [];
  text = text
    .replace(/^run\s*:\s*/, "")
    .replace(/^[@+-]+/, "")
    .replace(/^["']|["']$/g, "");
  return splitCommands(text).filter((command) => command && !/^(?:echo|printf)\b/.test(command) && !INSTALL.test(command));
}

/** Splits on `&&`, `||`, `;` and `|`, but not inside quotes, so `echo "a && b"` stays one command. */
function splitCommands(text: string): string[] {
  const commands: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) quote = ch === quote ? "" : quote;
    else if (ch === '"' || ch === "'") quote = ch;
    const separator = !quote && (ch === ";" || ch === "|" || (ch === "&" && text[i + 1] === "&"));
    if (!separator) {
      current += ch;
      continue;
    }
    commands.push(current.trim());
    current = "";
    if (text[i + 1] === ch) i++;
  }
  commands.push(current.trim());
  return commands;
}

const CONTINUE_ON_ERROR = /^\s*(?:-\s+)?continue-on-error\s*:\s*["']?true\b/i;

/**
 * The lines of a workflow that can fail the build. A step (a `- ` item and everything indented under it) marked
 * `continue-on-error: true` cannot, so its lines are dropped. This is a heuristic on indentation, not a YAML parse.
 */
function enforcingLines(text: string): string[] {
  const out: string[] = [];
  let block: string[] | null = null;
  let blockIndent = 0;
  const flush = () => {
    if (block && !block.some((line) => CONTINUE_ON_ERROR.test(line))) out.push(...block);
    block = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.slice(0, MAX_LINE);
    if (line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (block && (!line.trim() || indent > blockIndent)) {
      block.push(line);
      continue;
    }
    flush();
    if (/^\s*-(\s|$)/.test(line)) {
      block = [line];
      blockIndent = indent;
    } else out.push(line);
  }
  flush();
  return out;
}

/** Script bodies by name, from every package.json. A name may appear in several workspaces. */
function packageScripts(files: readonly CandidateFile[]): Map<string, string[]> {
  const scripts = new Map<string, string[]>();
  for (const file of files.filter((f) => baseName(f.path) === "package.json")) {
    const found = parseJson(file.content)?.scripts;
    if (!found || typeof found !== "object") continue;
    for (const [name, body] of Object.entries(found)) {
      if (typeof body === "string") scripts.set(name, [...(scripts.get(name) ?? []), body]);
    }
  }
  return scripts;
}

const VARIABLE_REFERENCE = /\$\((\w+)\)|\$\{(\w+)\}/g;

/**
 * Expands `$(VAR)` in one recipe line. Variable values are capped, a line that grows past its cap is skipped, and
 * the total text produced by expansion is budgeted, so a hostile Makefile cannot multiply itself into memory.
 */
function makeExpander(variables: Map<string, string>): (line: string) => string | null {
  let budget = MAX_MAKE_EXPANSION;
  return (line) => {
    let out = line;
    for (let pass = 0; pass < 3 && /\$[({]/.test(out); pass++) {
      out = out.replace(VARIABLE_REFERENCE, (_, a: string, b: string) => variables.get(a ?? b) ?? "");
      if (out.length > MAX_MAKE_LINE) return null;
    }
    if (out !== line && (budget -= out.length) < 0) return null;
    return out;
  };
}

function makeVariables(lines: string[]): Map<string, string> {
  const variables = new Map<string, string>();
  for (const line of lines) {
    const m = /^([A-Za-z_]\w*)\s*[:?]?=\s*(.*)$/.exec(line);
    if (m) variables.set(m[1]!, m[2]!.trim().slice(0, MAX_MAKE_VARIABLE));
  }
  return variables;
}

/** Each recipe line with the targets it belongs to. A target's prerequisites become `make` references. */
function recipeLines(lines: string[], expand: (line: string) => string | null): [string[], string][] {
  const found: [string[], string][] = [];
  let current: string[] = [];
  for (const line of lines) {
    const head = /^([A-Za-z0-9_.%/-]+(?:\s+[A-Za-z0-9_.%/-]+)*)\s*:(?![:=])(.*)$/.exec(line);
    if (head && !line.startsWith("\t")) {
      current = head[1]!.split(/\s+/).filter((t) => !t.startsWith("."));
      const prerequisites = head[2]!.replace(/#.*$/, "").trim();
      if (prerequisites) found.push([current, `make ${prerequisites}`]);
    } else if (line.startsWith("\t")) {
      const expanded = expand(line.trim());
      if (expanded !== null) found.push([current, expanded]);
    } else if (line.trim() && !line.startsWith("#")) {
      current = [];
    }
  }
  return found;
}

/** Recipe lines by target, with simple `$(VAR)` substitution. */
function makeTargets(files: readonly CandidateFile[]): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const file of files.filter((f) => /^(makefile|GNUmakefile)$/i.test(baseName(f.path)))) {
    const lines = file.content.split("\n").filter((l) => l.length <= MAX_MAKE_LINE);
    for (const [names, line] of recipeLines(lines, makeExpander(makeVariables(lines)))) {
      for (const name of names) targets.set(name, [...(targets.get(name) ?? []), line]);
    }
  }
  return targets;
}

const words = (text: string) => text.split(/\s+/).filter((w) => /^[\w:.-]+$/.test(w) && !w.startsWith("-"));

/** `npm run x`, `npm test`, `pnpm -r x`, `pnpm --filter pkg x`, `yarn x`: the script named, with workspace flags skipped. */
const PACKAGE_RUN =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:-r|-w|--recursive|--workspaces?|--filter[= ]\S{1,100}|-F\s+\S{1,100}|-C\s+\S{1,100})\s+){0,4}(?:run(?:-script)?\s+)?([\w:.-]{1,100})/g;

/**
 * Every command a workflow would run, one per entry: its own commands, plus the recipe of each `make` target and the
 * body of each package script it names, followed transitively. This is how `make check` in CI reaches
 * `prettier --check`. The result is capped in total size.
 */
function ciCommands(files: readonly CandidateFile[]): string[] {
  const scripts = packageScripts(files);
  const targets = makeTargets(files);
  const seen = new Set<string>();
  const commands: string[] = [];
  const queue: string[] = [];
  let size = 0;

  const take = (lines: string[]) => {
    for (const command of lines.flatMap(commandsOf)) {
      if ((size += command.length) > MAX_CI_CHARS) return;
      commands.push(command);
      queue.push(command);
    }
  };
  const follow = (kind: "make" | "script", name: string) => {
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    take(kind === "make" ? (targets.get(name) ?? []) : (scripts.get(name) ?? []));
  };

  for (const file of files.filter((f) => WORKFLOW.test(f.path))) take(enforcingLines(file.content));
  for (let command = queue.shift(); command !== undefined; command = queue.shift()) {
    for (const m of command.matchAll(/\bmake\s+([^\n;&|#]{0,200})/g)) words(m[1]!).forEach((w) => follow("make", w));
    for (const m of command.matchAll(PACKAGE_RUN)) follow("script", m[1]!);
    for (const m of command.matchAll(/\bturbo\s+(?:run\s+)?([^\n;&|#]{0,200})/g))
      words(m[1]!).forEach((w) => follow("script", w));
  }
  return commands;
}

const CI_LINTERS: [string, RegExp][] = [
  ["eslint", /\beslint\b/],
  ["biome", /\bbiome\s+(ci|check|lint)\b/],
  ["ruff", /\bruff\s+check\b|\bruff\s+\.(\s|$)/],
  ["flake8", /\bflake8\b/],
  ["pylint", /\bpylint\b/],
  ["golangci-lint", /golangci-lint/],
  ["rubocop", /\brubocop\b/],
  ["clippy", /\bcargo\s+clippy\b/],
  ["ktlint", /\bktlint\b/],
  ["detekt", /\bdetekt\b/],
];

const CI_FORMAT_CHECKS: [string, RegExp][] = [
  ["prettier", /\bprettier\b.{0,200}?(--check\b|\s-c\b)/],
  ["biome", /\bbiome\s+(ci|check)\b/],
  ["black", /\bblack\b.{0,200}?--check\b/],
  ["ruff format", /\bruff\s+format\b.{0,200}?--check\b/],
  ["gofmt", /\bgofmt\s+-l\b/],
  ["rustfmt", /\bcargo\s+fmt\b.{0,200}?--check\b|\brustfmt\b.{0,200}?--check\b/],
];

const CI_TESTS =
  /\b(vitest|jest|pytest)\b|\bgo\s+test\b|\bcargo\s+test\b|\bnpm\s+(run\s+)?test\b|\b(pnpm|yarn)\s+test\b|\bmvn\b.{0,200}?\btest\b|\bgradlew?\s+.{0,200}?\btest\b|\bdotnet\s+test\b/;

const anyCommand = (commands: readonly string[], pattern: RegExp) => commands.some((c) => pattern.test(c));

// ---- configured tools ----------------------------------------------------------------------------------------

const unique = (names: string[]) => [...new Set(names)].sort();

interface ParsedFile {
  name: string;
  content: string;
  /** The parsed package.json, or null for any other file or invalid JSON. */
  pkg: Record<string, unknown> | null;
}

type Predicate = (file: ParsedFile) => boolean;
const named =
  (pattern: RegExp): Predicate =>
  (file) =>
    pattern.test(file.name);
const containing =
  (pattern: RegExp): Predicate =>
  (file) =>
    pattern.test(file.content);
const hasPackageKey =
  (key: string): Predicate =>
  (file) =>
    file.pkg?.[key] !== undefined;
const anyOf =
  (...predicates: Predicate[]): Predicate =>
  (file) =>
    predicates.some((p) => p(file));
const allOf =
  (...predicates: Predicate[]): Predicate =>
  (file) =>
    predicates.every((p) => p(file));

type ToolKind = "linter" | "formatter" | "weak";

const PYPROJECT = named(/^pyproject\.toml$/);
const GRADLE = named(/^build\.gradle(\.kts)?$/);

/** One row per way a tool is configured. A file that satisfies `matches` shows the tool as configured. */
const CONFIG_RULES: { kind: ToolKind; tool: string; matches: Predicate }[] = [
  {
    kind: "linter",
    tool: "eslint",
    matches: anyOf(hasPackageKey("eslintConfig"), named(/^eslint\.config\.\w+$|^\.eslintrc(\.\w+)?$/)),
  },
  {
    kind: "formatter",
    tool: "prettier",
    matches: anyOf(hasPackageKey("prettier"), named(/^\.prettierrc(\.\w+)?$|^prettier\.config\.\w+$/)),
  },
  { kind: "linter", tool: "biome", matches: named(/^biome\.jsonc?$/) },
  { kind: "formatter", tool: "biome", matches: named(/^biome\.jsonc?$/) },
  { kind: "linter", tool: "ruff", matches: anyOf(named(/^\.?ruff\.toml$/), allOf(PYPROJECT, containing(/^\[tool\.ruff[\].]/m))) },
  {
    kind: "formatter",
    tool: "ruff format",
    matches: allOf(named(/^(\.?ruff\.toml|pyproject\.toml)$/), containing(/^\[(tool\.ruff\.)?format\]/m)),
  },
  {
    kind: "linter",
    tool: "flake8",
    matches: anyOf(named(/^\.flake8$/), allOf(named(/^(setup\.cfg|tox\.ini)$/), containing(/^\[flake8\]/m))),
  },
  { kind: "linter", tool: "pylint", matches: anyOf(named(/^\.?pylintrc$/), allOf(PYPROJECT, containing(/^\[tool\.pylint/m))) },
  { kind: "formatter", tool: "black", matches: allOf(PYPROJECT, containing(/^\[tool\.black\]/m)) },
  { kind: "linter", tool: "golangci-lint", matches: named(/^\.golangci\.\w+$/) },
  { kind: "formatter", tool: "gofmt", matches: named(/^go\.mod$/) },
  { kind: "linter", tool: "rubocop", matches: named(/^\.rubocop\.yml$/) },
  { kind: "linter", tool: "clippy", matches: named(/^\.?clippy\.toml$/) },
  { kind: "formatter", tool: "rustfmt", matches: named(/^(\.?rustfmt\.toml|Cargo\.toml)$/) },
  { kind: "linter", tool: "detekt", matches: anyOf(named(/^detekt\.ya?ml$/), allOf(GRADLE, containing(/\bdetekt\b/))) },
  { kind: "linter", tool: "ktlint", matches: allOf(GRADLE, containing(/\bktlint\b/)) },
  { kind: "weak", tool: "editorconfig", matches: named(/^\.editorconfig$/) },
];

/** Tools that need no config file: a CI run of them is the configuration. */
const CI_IMPLIED: { kind: ToolKind; tool: string; pattern: RegExp }[] = [
  { kind: "linter", tool: "clippy", pattern: /\bcargo\s+clippy\b/ },
  { kind: "formatter", tool: "ruff format", pattern: /\bruff\s+format\b/ },
];

function configured(
  files: readonly CandidateFile[],
  ci: readonly string[],
): Pick<ToolingFacts, "linters" | "formatters" | "weakFormatters"> {
  const found: Record<ToolKind, string[]> = { linter: [], formatter: [], weak: [] };
  for (const { path, content } of files) {
    if (WORKFLOW.test(path)) continue;
    const name = baseName(path);
    const file: ParsedFile = { name, content, pkg: name === "package.json" ? parseJson(content) : null };
    for (const rule of CONFIG_RULES) if (rule.matches(file)) found[rule.kind].push(rule.tool);
  }
  for (const rule of CI_IMPLIED) if (anyCommand(ci, rule.pattern)) found[rule.kind].push(rule.tool);
  return { linters: unique(found.linter), formatters: unique(found.formatter), weakFormatters: unique(found.weak) };
}

// ---- coverage floor ------------------------------------------------------------------------------------------

const JS_COVERAGE_CONFIG = /^(vitest|vite|jest)\.config\.\w+$|^vitest\.workspace\.\w+$|^package\.json$/;
const PYTHON_CONFIG = /^(\.coveragerc|pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini)$/;
const MAX_THRESHOLD_BLOCK = 4_096;

/** Where the string that opens at `start` ends. An unterminated one ends at the line break. */
function stringEnd(text: string, start: number): number {
  const quote = text[start]!;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === quote) return i + 1;
    else if (quote !== "`" && text[i] === "\n") return i;
  }
  return text.length;
}

/**
 * Removes `//` and block comments in one linear pass. Strings are skipped whole, because a glob such as
 * `"src/**\/*.test.ts"` contains `/*` without starting a comment.
 */
function withoutJsComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text.startsWith("//", i)) {
      const lineBreak = text.indexOf("\n", i);
      i = lineBreak < 0 ? text.length : lineBreak;
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const withoutIniComments = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*[#;]/.test(line))
    .join("\n");

/** The text between the braces that open at `open`, or null when they do not close within a sensible distance. */
function braceBlock(text: string, open: number): string | null {
  let depth = 0;
  const limit = Math.min(text.length, open + MAX_THRESHOLD_BLOCK);
  for (let i = open; i < limit; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** Line coverage thresholds of vitest (`thresholds`) and jest (`coverageThreshold`), read only inside their own block. */
function jsCoverageFloors(content: string): number[] {
  const text = withoutJsComments(content);
  const floors: number[] = [];
  for (const m of text.matchAll(/\b(?:thresholds|coverageThreshold)\b["']?\s*:\s*\{/g)) {
    const block = braceBlock(text, m.index + m[0].length - 1);
    // Prefer lines, as the plan says; fall back to statements when only that is set.
    const figure =
      block && (/\blines["']?\s*:\s*(\d+(?:\.\d+)?)/.exec(block) ?? /\bstatements["']?\s*:\s*(\d+(?:\.\d+)?)/.exec(block));
    if (figure) floors.push(Number(figure[1]));
  }
  return floors;
}

function coverageFloor(files: readonly CandidateFile[], ci: readonly string[]): number | null {
  const found: number[] = [];
  for (const { path, content } of files) {
    const name = baseName(path);
    if (JS_COVERAGE_CONFIG.test(name)) found.push(...jsCoverageFloors(content));
    if (PYTHON_CONFIG.test(name)) {
      for (const m of withoutIniComments(content).matchAll(/\bfail_under\s*=\s*(\d+(?:\.\d+)?)/g)) found.push(Number(m[1]));
    }
  }
  // A pytest flag counts only when a CI run reaches it.
  for (const command of ci) for (const m of command.matchAll(/--cov-fail-under[= ](\d+(?:\.\d+)?)/g)) found.push(Number(m[1]));
  const set = found.filter((floor) => floor > 0);
  return set.length === 0 ? null : Math.min(...set);
}

/** Reads the facts out of candidate files. Where several files disagree the weakest coverage floor is reported. */
export function detectTooling(files: readonly CandidateFile[]): ToolingFacts {
  const ci = ciCommands(files);
  return {
    ...configured(files, ci),
    ciLinters: unique(CI_LINTERS.filter(([, re]) => anyCommand(ci, re)).map(([name]) => name)),
    ciFormatChecks: unique(CI_FORMAT_CHECKS.filter(([, re]) => anyCommand(ci, re)).map(([name]) => name)),
    ciRunsTests: anyCommand(ci, CI_TESTS),
    coverageFloor: coverageFloor(files, ci),
  };
}
