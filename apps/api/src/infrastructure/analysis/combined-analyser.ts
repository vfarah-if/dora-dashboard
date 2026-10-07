import {
  AnalyserMissingError,
  type AnalyserReach,
  type CodeAnalyser,
  type CodeAnalysis,
} from "../../interfaces/code-analyser.js";
import type { WorkspaceReader } from "../../interfaces/workspace-reader.js";

const byFileThenLine = (a: { file: string; startLine: number }, b: { file: string; startLine: number }): number =>
  a.file.localeCompare(b.file) || a.startLine - b.startLine;

/**
 * JavaScript and TypeScript go to one analyser and every other language to another (ADR 0025). The class enforces the
 * split itself: it keeps a script analyser's results only for files that analyser measures, and the other analyser's
 * only for the rest, whatever either one returns. The second analyser is optional in practice: when its tool is
 * missing the scripts are still measured, and the files it would have read are counted as unmeasured.
 */
export class CombinedAnalyser implements CodeAnalyser {
  private readonly scripts: CodeAnalyser;
  private readonly others: CodeAnalyser;
  private readonly reader: WorkspaceReader;

  /** Named so the two analysers cannot be swapped. */
  constructor(parts: { scripts: CodeAnalyser; others: CodeAnalyser; reader: WorkspaceReader }) {
    ({ scripts: this.scripts, others: this.others, reader: this.reader } = parts);
  }

  async reach(): Promise<AnalyserReach> {
    return combine(await this.scripts.reach(), await this.others.reach());
  }

  measures(path: string): boolean {
    return this.scripts.measures(path) || this.others.measures(path);
  }

  async analyse(dir: string): Promise<CodeAnalysis> {
    // Lizard runs in a child process, so it works while the scripts are parsed here. Both settle before a failure is
    // passed on, so the caller never removes the clone under a lizard that is still reading it. A side whose tool is
    // missing says so by rejecting with AnalyserMissingError, which costs no separate check before the run.
    const [scripts, others] = await Promise.allSettled([this.scripts.analyse(dir), this.others.analyse(dir)]);
    const missing = { scripts: isMissing(scripts), others: isMissing(others) };
    const failures = [scripts, others].flatMap((r) => (r.status === "rejected" && !isMissing(r) ? [r.reason] : []));
    if (failures.length > 1) {
      throw new AggregateError(failures, failures.map((f) => (f instanceof Error ? f.message : String(f))).join(" "));
    }
    if (failures.length === 1) throw failures[0];
    const unmeasuredFiles = missing.scripts || missing.others ? await this.countUnmeasured(dir, missing) : 0;

    const ownScripts = (file: string) => this.scripts.measures(file);
    const ownOthers = (file: string) => !this.scripts.measures(file);
    const fromScripts = valueOf(scripts);
    const fromOthers = valueOf(others);
    return {
      functions: [
        ...fromScripts.functions.filter((f) => ownScripts(f.file)),
        ...fromOthers.functions.filter((f) => ownOthers(f.file)),
      ].sort(byFileThenLine),
      partlyMeasured: [...fromScripts.partlyMeasured.filter(ownScripts), ...fromOthers.partlyMeasured.filter(ownOthers)].sort(),
      unmeasuredFiles: unmeasuredFiles + fromScripts.unmeasuredFiles + fromOthers.unmeasuredFiles,
    };
  }

  /** The files the missing sides would have measured, from one listing of the directory. */
  private async countUnmeasured(dir: string, missing: { scripts: boolean; others: boolean }): Promise<number> {
    let count = 0;
    for (const file of await this.reader.list(dir)) {
      const forScripts = this.scripts.measures(file);
      if (missing.scripts && forScripts) count += 1;
      else if (missing.others && !forScripts && this.others.measures(file)) count += 1;
    }
    return count;
  }
}

const EMPTY: CodeAnalysis = { functions: [], partlyMeasured: [], unmeasuredFiles: 0 };

const isMissing = (result: PromiseSettledResult<CodeAnalysis>): boolean =>
  result.status === "rejected" && result.reason instanceof AnalyserMissingError;

/** A side's figures, or none when its tool was missing; any other failure has been thrown before this is asked. */
const valueOf = (result: PromiseSettledResult<CodeAnalysis>): CodeAnalysis =>
  result.status === "fulfilled" ? result.value : EMPTY;

function combine(scripts: AnalyserReach, others: AnalyserReach): AnalyserReach {
  if (scripts === "full" && others === "full") return "full";
  if (scripts === "none" && others === "none") return "none";
  return "partial";
}
