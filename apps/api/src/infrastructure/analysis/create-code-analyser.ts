import type { CodeAnalyser } from "../../interfaces/code-analyser.js";
import type { Logger } from "../../interfaces/logger.js";
import type { WorkspaceReader } from "../../interfaces/workspace-reader.js";
import { BabelAnalyser } from "../babel/babel-analyser.js";
import { LizardAnalyser, type Exec } from "../lizard/lizard-analyser.js";
import { CombinedAnalyser } from "./combined-analyser.js";
import { SCRIPT_EXTENSIONS } from "./languages.js";

/**
 * The analyser the application runs: JavaScript and TypeScript measured in process, every other language by lizard,
 * which is left the scripts' extensions to skip (ADR 0025). `exec` replaces the command runner in tests.
 */
export function createCodeAnalyser(reader: WorkspaceReader, log: Logger, exec?: Exec): CodeAnalyser {
  return new CombinedAnalyser({
    scripts: new BabelAnalyser(reader, { log }),
    others: new LizardAnalyser(SCRIPT_EXTENSIONS, exec),
    reader,
  });
}
