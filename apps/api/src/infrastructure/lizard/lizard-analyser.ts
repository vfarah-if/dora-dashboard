import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FunctionMetrics } from "@dora-dashboard/core";
import {
  AnalyserMissingError,
  type AnalyserReach,
  type CodeAnalyser,
  type CodeAnalysis,
} from "../../interfaces/code-analyser.js";
import { extensionOf, languageOf, type ScriptExtension } from "../analysis/languages.js";

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

/** The extensions lizard 1.24.0 reads, taken from that version's installed readers. A newer lizard may read more. */
export const LIZARD_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "c cc cjs cpp cs cxx erl es escript f f03 f08 f70 f90 f95 for fpp ftn gd go h hpp hrl java js jsx kt kts lua m mjs mm " +
    "pck php pkb pks pl plb pls pm py r rb rs scala sol sql st swift ts tsx ttcn ttcnpp vue zig"
  ).split(" "),
);

/**
 * A glob for `*.ext` that ignores letter case. Lizard's `-x` uses fnmatch, which is case-sensitive on POSIX, while it
 * picks its reader for a file case-insensitively, so `Legacy.JSX` would otherwise be read by lizard as well.
 */
const caseInsensitiveGlob = (extension: string): string =>
  `*.${[...extension].map((c) => (c.toLowerCase() === c.toUpperCase() ? c : `[${c.toLowerCase()}${c.toUpperCase()}]`)).join("")}`;

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
    const [, nloc, ccn, , params, , , file, name, , start, end] = m;
    if (!file || !name) continue;
    const path = relativeTo(file, rootDir);
    functions.push({
      file: path,
      language: languageOf(path),
      name,
      startLine: Number(start),
      endLine: Number(end),
      ccn: Number(ccn),
      nloc: Number(nloc),
      params: Number(params),
    });
  }
  return functions;
}

/**
 * Runs the `lizard` command line tool (`uv tool install lizard` or `pipx install lizard`), which reads more than 25
 * languages. Extensions in `skip` are left to another analyser: lizard loses function boundaries in JavaScript and
 * TypeScript, so those go to the Babel analyser instead (ADR 0025).
 */
export class LizardAnalyser implements CodeAnalyser {
  constructor(
    private readonly skip: readonly ScriptExtension[] = [],
    private readonly exec: Exec = defaultExec,
  ) {}

  async reach(): Promise<AnalyserReach> {
    try {
      await this.exec("lizard", ["--version"], { maxBuffer: 1024 * 1024, timeout: 30_000, killSignal: "SIGKILL" });
      return "full";
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return "none";
      throw new Error("Lizard was found but did not run. Check that `lizard --version` works on the machine that runs the API.", {
        cause: error,
      });
    }
  }

  measures(path: string): boolean {
    const extension = extensionOf(path);
    // Lizard's own `*.min.js` exclusion is case-sensitive, so this one is too.
    return LIZARD_EXTENSIONS.has(extension) && !(this.skip as readonly string[]).includes(extension) && !path.endsWith(".min.js");
  }

  async analyse(dir: string): Promise<CodeAnalysis> {
    let stdout: string;
    try {
      const excludes = [...EXCLUDES, ...this.skip.map(caseInsensitiveGlob)];
      ({ stdout } = await this.exec("lizard", ["--csv", ...excludes.flatMap((x) => ["-x", x]), "."], {
        // Running inside the clone keeps the exclusion patterns from matching the temporary directory's own path.
        cwd: dir,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: ANALYSE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }));
    } catch (error) {
      const failure = error as { code?: unknown; killed?: boolean; message?: string };
      // The clone exists by now, so a spawn that cannot find its file means lizard itself is missing.
      if (failure.code === "ENOENT") throw new AnalyserMissingError("Lizard was not found on the API's PATH.", { cause: error });
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new Error("This repository is too large to analyse.", { cause: error });
      }
      if (failure.killed) throw new Error("Lizard took longer than 10 minutes and was stopped.", { cause: error });
      throw error;
    }
    return { functions: parseLizardCsv(stdout, dir), partlyMeasured: [], unmeasuredFiles: 0 };
  }
}
