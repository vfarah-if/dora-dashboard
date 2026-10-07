import type { FunctionMetrics } from "@dora-dashboard/core";

export interface CodeAnalysis {
  /** Every function found, with paths relative to the analysed directory. */
  functions: FunctionMetrics[];
  /**
   * Files that could not be read in full, relative to the analysed directory, so some or all of their functions may
   * be missing from `functions`.
   */
  partlyMeasured: string[];
  /**
   * How many files an analyser would have measured had its tool been found, test files included. None of their
   * functions are in `functions`.
   */
  unmeasuredFiles: number;
}

/** How much of what an analyser knows can be measured now: every language, only some, or none because a tool is missing. */
export type AnalyserReach = "full" | "partial" | "none";

/**
 * Thrown by `analyse` when the analyser's tool cannot be found at all, as opposed to failing while it runs, so that a
 * caller combining analysers can count what this one would have measured instead of failing.
 */
export class AnalyserMissingError extends Error {
  override readonly name = "AnalyserMissingError";
}

/** Static analysis of a directory of source code. */
export interface CodeAnalyser {
  /**
   * The functions found under `dir`, the files read only in part, and how many source files went unread. Rejects with
   * `AnalyserMissingError` when the tool cannot be found.
   */
  analyse(dir: string): Promise<CodeAnalysis>;
  /**
   * How much of what this analyser knows can be measured now, so the caller can explain rather than fail. Rejects
   * when finding out fails for any reason other than the tool being missing.
   */
  reach(): Promise<AnalyserReach>;
  /** True when this analyser measures the file at `path`, judged by its name alone. */
  measures(path: string): boolean;
}
