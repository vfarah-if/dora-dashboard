import { setImmediate as nextTurn } from "node:timers/promises";
import type { FunctionMetrics } from "@dora-dashboard/core";
import type { AnalyserReach, CodeAnalyser, CodeAnalysis } from "../../interfaces/code-analyser.js";
import { noopLogger, type Logger } from "../../interfaces/logger.js";
import type { WorkspaceReader } from "../../interfaces/workspace-reader.js";
import { isScriptPath } from "../analysis/languages.js";
import { measureSource, type SourceMeasurement } from "./measure-source.js";

const ANALYSE_TIMEOUT_MS = 10 * 60_000;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_LOGGED_FILES = 20;

// Declaration files hold types only, and minified files are build output, as lizard's `*.min.js` exclusion assumes.
const SKIPPED = /\.d\.[mc]?ts$|\.min\.[mc]?js$/i;

/**
 * Measures JavaScript and TypeScript in process with `@babel/parser`, which reads JSX, decorators and every TypeScript
 * construct that made lizard lose function boundaries (ADR 0025). The source is parsed, never run.
 */
export class BabelAnalyser implements CodeAnalyser {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly measure: (path: string, source: string) => SourceMeasurement;

  /** `now` and `measure` can be replaced so a test need not wait ten minutes or parse a vast file. */
  constructor(
    private readonly reader: WorkspaceReader,
    options: { log?: Logger; now?: () => number; measure?: (path: string, source: string) => SourceMeasurement } = {},
  ) {
    this.log = options.log ?? noopLogger;
    this.now = options.now ?? Date.now;
    this.measure = options.measure ?? measureSource;
  }

  async reach(): Promise<AnalyserReach> {
    return "full";
  }

  measures(path: string): boolean {
    return isScriptPath(path) && !SKIPPED.test(path);
  }

  async analyse(dir: string): Promise<CodeAnalysis> {
    const deadline = this.now() + ANALYSE_TIMEOUT_MS;
    const functions: FunctionMetrics[] = [];
    const partlyMeasured: { path: string; problem: string }[] = [];
    // The reader already skips .git, node_modules, vendor, dist, build and symbolic links.
    for (const path of await this.reader.list(dir)) {
      if (!this.measures(path)) continue;
      // Parsing runs on the API's own thread, so each file gives way to requests waiting behind it.
      await nextTurn();
      if (this.now() > deadline) {
        throw new Error("Measuring JavaScript and TypeScript took longer than 10 minutes and was stopped.");
      }
      const source = await this.reader.read(dir, path, MAX_SOURCE_BYTES);
      const measured = source === null ? null : this.measure(path, source);
      // A loop rather than push(...all): a generated file can hold more functions than a call can take as arguments.
      for (const fn of measured?.functions ?? []) functions.push(fn);
      if (!measured) partlyMeasured.push({ path, problem: "larger than 2 MiB or could not be read" });
      else if (!measured.complete) partlyMeasured.push({ path, problem: measured.problem ?? "could not be read in full" });
    }
    if (partlyMeasured.length > 0) {
      this.log.info(
        { total: partlyMeasured.length, files: partlyMeasured.slice(0, MAX_LOGGED_FILES) },
        "some JavaScript and TypeScript files were measured only in part",
      );
    }
    return {
      functions: functions.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine),
      partlyMeasured: partlyMeasured.map((f) => f.path).sort(),
      unmeasuredFiles: 0,
    };
  }
}
