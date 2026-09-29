import { codeHealth, type CodeHealthResponse, type CodeSnapshot } from "@dora-dashboard/core";
import { NotFoundError } from "../core/errors.js";
import type { CodeAnalyser } from "../interfaces/code-analyser.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SourceCheckout } from "../interfaces/source-checkout.js";

export const ANALYSIS_OFF = "Code analysis is switched off. Remove CODE_ANALYSIS=off and crawl again to enable it.";

export const ANALYSER_MISSING =
  "Code analysis needs lizard, which is not installed. Install it with `pipx install lizard` and crawl again.";

/** Clones a repository's deploy branch, measures its functions, keeps the result and discards the clone. */
export class CodeHealthService {
  constructor(
    private readonly store: RepoStore,
    private readonly checkout: SourceCheckout | null,
    private readonly analyser: CodeAnalyser | null,
    private readonly now: () => Date = () => new Date(),
    private readonly log: Logger = noopLogger,
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
  report(repoId: number): CodeHealthResponse {
    if (!this.store.getRepo(repoId)) throw new NotFoundError(`Unknown repository ${repoId}`);
    const latest = this.store.latestCodeSnapshot(repoId);
    if (!latest) return { status: "none" };
    const good = this.store.latestSuccessfulCodeSnapshot(repoId);
    if (!good) return { status: "error", message: latest.error ?? "Unknown error", analysedAt: latest.analysedAt };
    const report = codeHealth(good);
    return latest.error ? { ...report, lastError: { message: latest.error, analysedAt: latest.analysedAt } } : report;
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
      snapshot: { commitSha: "", analysedAt: this.now().toISOString(), functions: [], error } as CodeSnapshot,
    });
    try {
      if (!this.checkout || !this.analyser) return failed(ANALYSIS_OFF);
      if (!(await this.analyser.available())) return failed(ANALYSER_MISSING);

      const previous = this.store.latestCodeSnapshot(repoId);
      if (!force && previous && !previous.error) {
        const head = await this.checkout.headSha(token, owner, name, branch).catch((err: unknown) => {
          this.log.warn({ err, repoId }, "could not read the branch head; analysing anyway");
          return null;
        });
        if (head && head === previous.commitSha) return { snapshot: previous, unchanged: previous };
      }

      const checkout = await this.checkout.checkout(token, owner, name, branch);
      try {
        const functions = await this.analyser.analyse(checkout.dir);
        return { snapshot: { commitSha: checkout.commitSha, analysedAt: this.now().toISOString(), functions, error: null } };
      } finally {
        // A clean-up failure must not throw away a finished analysis.
        await checkout.dispose().catch((err: unknown) => this.log.warn({ err, repoId }, "could not remove the checkout"));
      }
    } catch (error) {
      this.log.warn({ err: error, repoId }, "code analysis failed");
      return failed(error instanceof Error ? error.message : String(error));
    }
  }
}
