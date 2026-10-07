import { isCodeFile } from "@dora-dashboard/core";
import type { CodeAnalyser, CodeAnalysis } from "../../interfaces/code-analyser.js";
import type { WorkspaceReader } from "../../interfaces/workspace-reader.js";
import { isScriptPath } from "./languages.js";

/**
 * JavaScript and TypeScript go to one analyser and every other language to another (ADR 0025). The second is optional:
 * without it the scripts are still measured, and the files it would have read are counted as unmeasured.
 */
export class CombinedAnalyser implements CodeAnalyser {
  constructor(
    private readonly scripts: CodeAnalyser,
    private readonly others: CodeAnalyser,
    private readonly reader: WorkspaceReader,
  ) {}

  available(): Promise<boolean> {
    return this.scripts.available();
  }

  async analyse(dir: string): Promise<CodeAnalysis> {
    const othersAvailable = await this.others.available();
    // Lizard runs in a child process, so it works while the scripts are parsed here. Both settle before a failure is
    // passed on, so the caller never removes the clone under a lizard that is still reading it.
    const [scripts, others] = await Promise.allSettled([
      this.scripts.analyse(dir),
      othersAvailable ? this.others.analyse(dir) : this.unmeasured(dir),
    ]);
    if (scripts.status === "rejected") throw scripts.reason;
    if (others.status === "rejected") throw others.reason;
    return {
      functions: [...scripts.value.functions, ...others.value.functions].sort(
        (a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine,
      ),
      partlyMeasured: [...scripts.value.partlyMeasured, ...others.value.partlyMeasured].sort(),
      unmeasuredFiles: scripts.value.unmeasuredFiles + others.value.unmeasuredFiles,
    };
  }

  /** What is left when the other analyser is missing: a count of the source files it would have read. */
  private async unmeasured(dir: string): Promise<CodeAnalysis> {
    const files = await this.reader.list(dir);
    return { functions: [], partlyMeasured: [], unmeasuredFiles: files.filter((f) => isCodeFile(f) && !isScriptPath(f)).length };
  }
}
