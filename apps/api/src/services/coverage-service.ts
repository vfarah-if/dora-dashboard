import {
  COVERAGE_SNAPSHOT_VERSION,
  chooseCoverageRun,
  type CoverageArtefact,
  type CoverageReport,
  type CoverageSnapshot,
  type Repo,
} from "@dora-dashboard/core";
import { AppError, UnauthorisedError } from "../core/errors.js";
import type { CoverageSource } from "../interfaces/coverage-source.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";

/** Stored in place of a failure's own message when it is not one the person can act on; the detail is in the log. */
const UNEXPECTED_FAILURE = "Reading coverage failed unexpectedly. See the API log.";

const NO_REPORTS =
  "The coverage artefacts held no report in a format that is read (lcov, Istanbul or Cobertura). See Coverage in the README.";

const sameArtefacts = (a: readonly CoverageArtefact[], b: readonly CoverageArtefact[]) =>
  a.length === b.length && a.every((artefact, i) => artefact.id === b[i]?.id);

/**
 * Reads a repository's measured test coverage from the artefacts its CI published, into the store, for display only
 * (ADR 0013). It runs on every crawl, apart from the clone skip, so coverage that CI publishes after a crawl is picked
 * up by the next one even though the branch head has not moved.
 *
 * A repository with no coverage artefact is left as it is. A failed read is stored as an error snapshot and logged,
 * and the last good snapshot stays the one the report uses. Only a rejected credential is rethrown, as it would fail
 * every later step too (ADR 0028); the caller isolates anything else.
 */
export class CoverageService {
  constructor(
    private readonly store: RepoStore,
    private readonly source: CoverageSource,
    private readonly now: () => Date = () => new Date(),
    private readonly log: Logger = noopLogger,
  ) {}

  /** Unless `force` is set, a run, artefact set and snapshot version that were already read are not read again. */
  async read(token: string, repo: Repo, force = false): Promise<void> {
    let chosen: CoverageArtefact[] = [];
    try {
      const analysed = this.store.latestSuccessfulCodeSnapshot(repo.id)?.commitSha || null;
      const found = await this.source.findArtefacts(token, repo.owner, repo.name, repo.deployBranch);
      chosen = chooseCoverageRun(found, analysed);
      if (chosen.length === 0) return;
      if (!force && this.alreadyRead(repo.id, chosen)) return;

      const reports: CoverageReport[] = [];
      for (const artefact of chosen) reports.push(...(await this.source.readArtefact(token, repo.owner, repo.name, artefact)));
      if (reports.length === 0) {
        this.save(repo.id, chosen, [], NO_REPORTS);
        return;
      }
      this.save(repo.id, chosen, reports, null);
    } catch (err) {
      if (err instanceof UnauthorisedError) throw err;
      if (err instanceof AppError) this.log.warn({ err, repoId: repo.id }, "coverage step failed");
      else this.log.error({ err, repoId: repo.id }, "coverage step failed unexpectedly");
      this.save(repo.id, chosen, [], err instanceof AppError ? err.message : UNEXPECTED_FAILURE);
    }
  }

  /** A failed read is tried again, so only a snapshot that succeeded can stand in for reading. */
  private alreadyRead(repoId: number, chosen: readonly CoverageArtefact[]): boolean {
    const previous = this.store.latestCoverageSnapshot(repoId);
    return (
      previous !== null &&
      !previous.error &&
      previous.version === COVERAGE_SNAPSHOT_VERSION &&
      previous.runId === chosen[0]!.runId &&
      sameArtefacts(previous.artefacts, chosen)
    );
  }

  private save(repoId: number, chosen: CoverageArtefact[], reports: CoverageReport[], error: string | null): void {
    const snapshot: CoverageSnapshot = {
      fetchedAt: this.now().toISOString(),
      version: COVERAGE_SNAPSHOT_VERSION,
      artefacts: chosen,
      runId: chosen[0]?.runId ?? null,
      commitSha: chosen[0]?.commitSha ?? null,
      reports,
      error,
    };
    this.store.saveCoverageSnapshot(repoId, snapshot);
  }
}
