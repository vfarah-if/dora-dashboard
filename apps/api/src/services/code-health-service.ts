import {
  CODE_SNAPSHOT_VERSION,
  codeHealth,
  detectTooling,
  toolingCandidates,
  type CandidateFile,
  type CodeHealthFailureReason,
  type CodeHealthRange,
  type CodeHealthResponse,
  type CodeSnapshot,
  type ToolingFacts,
} from "@dora-dashboard/core";
import { NotFoundError } from "../core/errors.js";
import type { CodeAnalyser } from "../interfaces/code-analyser.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SourceCheckout } from "../interfaces/source-checkout.js";
import type { WorkspaceReader } from "../interfaces/workspace-reader.js";
import { validateDateRange } from "./date-range.js";

const MAX_CONFIG_BYTES = 256 * 1024;

export const ANALYSIS_OFF = "Code analysis is switched off. Remove CODE_ANALYSIS=off and crawl again to enable it.";

export const ANALYSER_MISSING =
  "Code analysis needs lizard, which the API cannot find on its PATH. Install it (see Code health in the README), restart the API if it was already running, and crawl again.";

/** Snapshots store only the message, so the reason is recovered from the messages this service writes itself. */
const reasonOf = (message: string): CodeHealthFailureReason =>
  message === ANALYSER_MISSING ? "analyser-missing" : message === ANALYSIS_OFF ? "analysis-off" : "failed";

const failure = (message: string, analysedAt: string) => ({ message, analysedAt, reason: reasonOf(message) });

/** Clones a repository's deploy branch, measures its functions, keeps the result and discards the clone. */
export class CodeHealthService {
  constructor(
    private readonly store: RepoStore,
    private readonly checkout: SourceCheckout | null,
    private readonly analyser: CodeAnalyser | null,
    private readonly now: () => Date = () => new Date(),
    private readonly log: Logger = noopLogger,
    /** Reads linter, formatter and CI configuration from the clone. Without it, snapshots carry no tooling facts and no grade. */
    private readonly reader: WorkspaceReader | null = null,
  ) {}

  /**
   * Never throws for an analysis problem; the problem is stored on the snapshot for the report to explain.
   * Unless `force` is set, a branch whose head is the commit already analysed is not cloned again.
   */
  async analyse(token: string, repoId: number, force = false): Promise<CodeSnapshot> {
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new NotFoundError(`Unknown repository ${repoId}`);

    const outcome = await this.measure(token, repoId, repo.owner, repo.name, repo.deployBranch, force);
    if (outcome.unchanged) return outcome.unchanged;
    this.store.saveCodeSnapshot(repoId, outcome.snapshot);
    return outcome.snapshot;
  }

  /** The last successful figures, with `lastError` when a newer attempt failed; `error` only if none ever succeeded. */
  report(repoId: number, range: CodeHealthRange = {}): CodeHealthResponse {
    validateDateRange(range);
    if (!this.store.getRepo(repoId)) throw new NotFoundError(`Unknown repository ${repoId}`);
    const latest = this.store.latestCodeSnapshot(repoId);
    if (!latest) return { status: "none" };
    const good = this.store.latestSuccessfulCodeSnapshot(repoId);
    if (!good) return { status: "error", ...failure(latest.error ?? "Unknown error", latest.analysedAt) };
    const report = codeHealth(good, this.store.pullRequests(repoId), range);
    return latest.error ? { ...report, lastError: failure(latest.error, latest.analysedAt) } : report;
  }

  private async measure(
    token: string,
    repoId: number,
    owner: string,
    name: string,
    branch: string,
    force: boolean,
  ): Promise<{ snapshot: CodeSnapshot; unchanged?: CodeSnapshot }> {
    const failed = (error: string) => ({
      snapshot: {
        commitSha: "",
        analysedAt: this.now().toISOString(),
        functions: [],
        error,
        snapshotVersion: CODE_SNAPSHOT_VERSION,
      } as CodeSnapshot,
    });
    try {
      if (!this.checkout || !this.analyser) return failed(ANALYSIS_OFF);
      // The combined analyser never reports "none" today, since it can always measure scripts. This message now mainly
      // comes back from snapshots stored before ADR 0025, when lizard was required for everything.
      const reach = await this.analyser.reach();
      if (reach === "none") return failed(ANALYSER_MISSING);

      const previous = this.store.latestCodeSnapshot(repoId);
      // A snapshot from an older version lacks data the current one records, so it is analysed again at the same head.
      // So is one that left files unmeasured once every tool is found, or installing lizard would change nothing. While
      // a tool is still missing the snapshot stands, so the repository is not cloned on every crawl.
      const leftFilesOut = (previous?.unmeasuredFiles ?? 0) > 0 && reach === "full";
      if (!force && previous && !previous.error && previous.snapshotVersion === CODE_SNAPSHOT_VERSION && !leftFilesOut) {
        const head = await this.checkout.headSha(token, owner, name, branch).catch((err: unknown) => {
          this.log.warn({ err, repoId }, "could not read the branch head; analysing anyway");
          return null;
        });
        if (head && head === previous.commitSha) return { snapshot: previous, unchanged: previous };
      }

      const checkout = await this.checkout.checkout(token, owner, name, branch);
      try {
        const { functions, partlyMeasured, unmeasuredFiles } = await this.analyser.analyse(checkout.dir);
        if (unmeasuredFiles > 0) {
          this.log.warn(
            { repoId, unmeasuredFiles },
            "some source files were left unmeasured because their analysis tool was not found",
          );
        }
        const tooling = await this.readTooling(checkout.dir, repoId);
        return {
          snapshot: {
            commitSha: checkout.commitSha,
            analysedAt: this.now().toISOString(),
            functions,
            partlyMeasured,
            unmeasuredFiles,
            error: null,
            tooling,
            snapshotVersion: CODE_SNAPSHOT_VERSION,
          },
        };
      } finally {
        // A clean-up failure must not throw away a finished analysis.
        await checkout.dispose().catch((err: unknown) => this.log.warn({ err, repoId }, "could not remove the checkout"));
      }
    } catch (error) {
      this.log.warn({ err: error, repoId }, "code analysis failed");
      return failed(error instanceof Error ? error.message : String(error));
    }
  }

  /** Reads configuration files only; a failure here costs the grade, not the complexity figures. */
  private async readTooling(dir: string, repoId: number): Promise<ToolingFacts | null> {
    if (!this.reader) return null;
    try {
      const files: CandidateFile[] = [];
      for (const path of toolingCandidates(await this.reader.list(dir))) {
        const content = await this.reader.read(dir, path, MAX_CONFIG_BYTES);
        if (content !== null) files.push({ path, content });
      }
      return detectTooling(files);
    } catch (err) {
      this.log.warn({ err, repoId }, "could not read the repository's tooling files");
      return null;
    }
  }
}
