import type { FunctionMetrics } from "@dora-dashboard/core";

/** Static analysis of a directory of source code. */
export interface CodeAnalyser {
  /** Every function found under `dir`, with paths relative to `dir`. */
  analyse(dir: string): Promise<FunctionMetrics[]>;
  /** False when the analysis tool is not installed, so the caller can explain rather than fail. */
  available(): Promise<boolean>;
}
