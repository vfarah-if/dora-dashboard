import type { FunctionMetrics } from "@dora-dashboard/core";

export interface CodeAnalysis {
  /** Every function found, with paths relative to the analysed directory. */
  functions: FunctionMetrics[];
  /** Files the tool may have read only in part, relative to the analysed directory. */
  partlyMeasured: string[];
}

/** Static analysis of a directory of source code. */
export interface CodeAnalyser {
  /** The functions found under `dir`, and the files that may have been read only in part. */
  analyse(dir: string): Promise<CodeAnalysis>;
  /** False when the analysis tool is not installed, so the caller can explain rather than fail. */
  available(): Promise<boolean>;
}
