import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FunctionMetrics } from "@dora-dashboard/core";
import type { CodeAnalyser, CodeAnalysis } from "../../interfaces/code-analyser.js";
import type { WorkspaceReader } from "../../interfaces/workspace-reader.js";

export interface ExecOptions {
  cwd?: string;
  maxBuffer: number;
  timeout: number;
  killSignal: "SIGKILL";
}

export type Exec = (file: string, args: string[], options: ExecOptions) => Promise<{ stdout: string }>;

const ANALYSE_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const defaultExec: Exec = (file, args, options) => promisify(execFile)(file, args, options);

const EXCLUDES = ["*/node_modules/*", "*/vendor/*", "*/dist/*", "*/build/*", "*.min.js"];

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  swift: "Swift",
  scala: "Scala",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  hh: "C++",
  m: "Objective-C",
  mm: "Objective-C",
  lua: "Lua",
  pl: "Perl",
  sol: "Solidity",
  vue: "Vue",
  erl: "Erlang",
  zig: "Zig",
  dart: "Dart",
};

export const languageOf = (file: string): string => {
  const ext = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "";
  return LANGUAGES[ext] ?? (ext ? ext.toUpperCase() : "Other");
};

/** Path of `file` relative to `rootDir`, whether lizard printed it absolute or as `./x`. */
function relativeTo(file: string, rootDir: string): string {
  const root = rootDir.replace(/\/+$/, "");
  if (file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  return file.replace(/^\.\//, "");
}

/**
 * One row of `lizard --csv`. Columns, in order: nloc, ccn, token, param, length, location, file, function,
 * long_name, start, end. Lizard does not escape quotes inside the quoted fields, so a signature may contain
 * a stray `"` or a comma; the anchored pattern lets those fields absorb them.
 */
const ROW = /^(\d+),(\d+),(\d+),(\d+),(\d+),"(.*)","(.*)","(.*)","(.*)",(\d+),(\d+)$/;

/** Parses `lizard --csv` output. Rows that do not match are skipped rather than failing the whole analysis. */
export function parseLizardCsv(csv: string, rootDir: string): FunctionMetrics[] {
  const functions: FunctionMetrics[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = ROW.exec(line);
    if (!m) continue;
    const [, nloc, ccn, , params, , , file, name, , start] = m;
    if (!file || !name) continue;
    const path = relativeTo(file, rootDir);
    functions.push({
      file: path,
      language: languageOf(path),
      name,
      startLine: Number(start),
      ccn: Number(ccn),
      nloc: Number(nloc),
      params: Number(params),
    });
  }
  return functions;
}

/**
 * Replaces comments and string literals with empty placeholders (`""`), so that text inside them cannot look like
 * code while a string attribute value still counts as a token. Quotes do not span lines, which keeps an apostrophe
 * in JSX text from swallowing the rest of the file. It does not understand regular expression literals or template
 * literals nested inside `${}`, so a backtick or quote in either can blank the rest of the file; that only hides a
 * spread, so the file goes unflagged rather than wrongly flagged.
 */
function blankCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const pair = source.slice(i, i + 2);
    if (pair === "//") {
      i = endOfLine(source, i);
    } else if (pair === "/*") {
      i = endOfBlockComment(source, i);
      out += " ";
    } else if (QUOTES.has(source[i]!)) {
      i = endOfQuoted(source, i);
      out += '""';
    } else {
      out += source[i++];
    }
  }
  return out;
}

const QUOTES = new Set(['"', "'", "`"]);

/** The index of the newline that ends a `//` comment, which stays in the text, or the end of the source. */
function endOfLine(source: string, from: number): number {
  const end = source.indexOf("\n", from);
  return end === -1 ? source.length : end;
}

/** The index just past the `*\/` that closes a block comment, or the end of the source when it is unclosed. */
function endOfBlockComment(source: string, from: number): number {
  const end = source.indexOf("*/", from + 2);
  return end === -1 ? source.length : end + 2;
}

/** The index just past a quoted literal starting at `from`. Only a template literal may span lines. */
function endOfQuoted(source: string, from: number): number {
  const quote = source[from];
  let i = from + 1;
  while (i < source.length && source[i] !== quote && (quote === "`" || source[i] !== "\n")) i += source[i] === "\\" ? 2 : 1;
  return source[i] === quote ? i + 1 : i;
}

/** Characters after which `{...` starts an object or array spread in plain code rather than a JSX attribute. */
const NOT_JSX_BEFORE = new Set(["=", "(", "[", ",", ":", "?", "{", "&", "|", ";"]);

/**
 * True when the text holds a JSX spread attribute such as `<div {...props}>`, which lizard's TSX and JSX parser
 * cannot read: it drops the enclosing function and the one after it. A heuristic: object spreads in plain code
 * (after `=`, `(`, `,`, `=>`, `return` and similar) and destructuring after `const`, `let` or `var` are not counted.
 */
export function hasJsxSpread(source: string): boolean {
  if (!source.includes("...")) return false;
  const text = blankCommentsAndStrings(source);
  const spread = /\{\s*\.\.\./g;
  for (let m = spread.exec(text); m; m = spread.exec(text)) {
    const before = text.slice(0, m.index).trimEnd();
    const prev = before.slice(-1);
    if (prev === "") continue;
    if (prev === ">" && before.endsWith("=>")) continue;
    if (NOT_JSX_BEFORE.has(prev)) continue;
    if (/\b(return|default|yield|const|let|var)$/.test(before)) continue;
    return true;
  }
  return false;
}

const JSX_FILE = /\.(tsx|jsx)$/i;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Runs the `lizard` command line tool (`uv tool install lizard` or `pipx install lizard`), which reads more than 25 languages. */
export class LizardAnalyser implements CodeAnalyser {
  constructor(
    private readonly reader: WorkspaceReader,
    private readonly exec: Exec = defaultExec,
  ) {}

  async available(): Promise<boolean> {
    try {
      await this.exec("lizard", ["--version"], { maxBuffer: 1024 * 1024, timeout: 30_000, killSignal: "SIGKILL" });
      return true;
    } catch {
      return false;
    }
  }

  async analyse(dir: string): Promise<CodeAnalysis> {
    let stdout: string;
    try {
      ({ stdout } = await this.exec("lizard", ["--csv", ...EXCLUDES.flatMap((x) => ["-x", x]), "."], {
        // Running inside the clone keeps the exclusion patterns from matching the temporary directory's own path.
        cwd: dir,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: ANALYSE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }));
    } catch (error) {
      const failure = error as { code?: unknown; killed?: boolean; message?: string };
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new Error("This repository is too large to analyse.", { cause: error });
      }
      if (failure.killed) throw new Error("Code analysis took longer than 10 minutes and was stopped.", { cause: error });
      throw error;
    }
    return { functions: parseLizardCsv(stdout, dir), partlyMeasured: await this.findPartlyMeasured(dir) };
  }

  /** Reads `.tsx` and `.jsx` files (the reader already skips node_modules, vendor, dist and build) for JSX spreads. */
  private async findPartlyMeasured(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const path of await this.reader.list(dir)) {
      if (!JSX_FILE.test(path)) continue;
      const text = await this.reader.read(dir, path, MAX_SOURCE_BYTES);
      if (text !== null && hasJsxSpread(text)) found.push(path);
    }
    return found.sort();
  }
}
