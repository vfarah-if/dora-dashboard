import { setImmediate as nextTurn } from "node:timers/promises";
import type { FunctionMetrics } from "@dora-dashboard/core";
import type { CodeAnalyser, CodeAnalysis } from "../../interfaces/code-analyser.js";
import type { WorkspaceReader } from "../../interfaces/workspace-reader.js";
import { isScriptPath } from "../analysis/languages.js";
import { measureSource } from "./measure-source.js";

const ANALYSE_TIMEOUT_MS = 10 * 60_000;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

// Declaration files hold types only, and minified files are build output, as lizard's `*.min.js` exclusion assumed.
const SKIPPED = /\.d\.[mc]?ts$|\.min\.[mc]?js$/i;

/**
 * Measures JavaScript and TypeScript in process with `@babel/parser`, which reads JSX, decorators and every TypeScript
 * construct that made lizard lose function boundaries (ADR 0025). The source is parsed, never run.
 */
export class BabelAnalyser implements CodeAnalyser {
  constructor(
    private readonly reader: WorkspaceReader,
    private readonly now: () => number = Date.now,
  ) {}

  async available(): Promise<boolean> {
    return true;
  }

  async analyse(dir: string): Promise<CodeAnalysis> {
    const deadline = this.now() + ANALYSE_TIMEOUT_MS;
    const functions: FunctionMetrics[] = [];
    const partlyMeasured: string[] = [];
    // The reader already skips .git, node_modules, vendor, dist, build and symbolic links.
    for (const path of await this.reader.list(dir)) {
      if (!isScriptPath(path) || SKIPPED.test(path)) continue;
      // Parsing runs on the API's own thread, so each file gives way to requests waiting behind it.
      await nextTurn();
      if (this.now() > deadline) throw new Error("Code analysis took longer than 10 minutes and was stopped.");
      const source = await this.reader.read(dir, path, MAX_SOURCE_BYTES);
      const measured = source === null ? null : measureSource(path, source);
      // A loop rather than push(...all): a generated file can hold more functions than a call can take as arguments.
      for (const fn of measured?.functions ?? []) functions.push(fn);
      if (!measured?.complete) partlyMeasured.push(path);
    }
    return {
      functions: functions.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine),
      partlyMeasured: partlyMeasured.sort(),
      unmeasuredFiles: 0,
    };
  }
}
