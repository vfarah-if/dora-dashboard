import type { FunctionMetrics } from "@dora-dashboard/core";

export interface CodeAnalysis {
  /** Every function found, with paths relative to the analysed directory. */
  functions: FunctionMetrics[];
  /** Files the analyser could not read in full, relative to the analysed directory, so some functions may be missing. */
  partlyMeasured: string[];
  /** Source files in a language that no installed tool reads, so none of their functions are in `functions`. */
  unmeasuredFiles: number;
}

/** Static analysis of a directory of source code. */
export interface CodeAnalyser {
  /** The functions found under `dir`, the files read only in part, and how many source files went unread. */
  analyse(dir: string): Promise<CodeAnalysis>;
  /** False when the analysis tool is not installed, so the caller can explain rather than fail. */
  available(): Promise<boolean>;
}
