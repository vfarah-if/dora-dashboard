import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FunctionMetrics } from "@dora-dashboard/core";
import type { CodeAnalyser, CodeAnalysis } from "../../interfaces/code-analyser.js";
import { languageOf } from "../analysis/languages.js";

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
 * Runs the `lizard` command line tool (`uv tool install lizard` or `pipx install lizard`), which reads more than 25
 * languages. Extensions in `skip` are left to another analyser: lizard loses function boundaries in JavaScript and
 * TypeScript, so those go to the Babel analyser instead (ADR 0025).
 */
export class LizardAnalyser implements CodeAnalyser {
  constructor(
    private readonly skip: readonly string[] = [],
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
      const excludes = [...EXCLUDES, ...this.skip.map((ext) => `*.${ext}`)];
      ({ stdout } = await this.exec("lizard", ["--csv", ...excludes.flatMap((x) => ["-x", x]), "."], {
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
    return { functions: parseLizardCsv(stdout, dir), partlyMeasured: [], unmeasuredFiles: 0 };
  }
}
