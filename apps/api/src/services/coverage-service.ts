import {
  COVERAGE_SNAPSHOT_VERSION,
  chooseCoverageRun,
  type CoverageReadFailure,
  type CoverageReport,
  type CoverageRun,
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
  "The coverage artefacts held no report in a format that is read. The files read are lcov.info or a .lcov file, coverage-final.json, coverage-summary.json, and Cobertura XML named coverage.xml or with cobertura in its name. See Coverage in the README.";

const EMPTY_REPORTS = "The coverage files in the artefacts list no files, so the tests may not have run";

/** Said when the search for artefacts stopped at its page limit before reaching one from the deploy branch. */
const NOT_AMONG_NEWEST =
  "No coverage artefact from the deploy branch was among the newest 300 artefacts on GitHub, so its coverage may be older than that. Publish coverage from a run on the deploy branch.";

const ids = (run: CoverageRun | null) => run?.artefacts.map((artefact) => artefact.id) ?? [];

/** The message for a read in which no file could be read: the first reason, and a count of the others. */
function unreadableMessage(messages: readonly string[]): string {
  const [first = ""] = messages;
  const others = messages.length - 1;
  if (others <= 0) return first;
  return `${first.replace(/\.$/, "")}; ${others} other coverage file${others === 1 ? "" : "s"} could not be read`;
}

/**
 * Reads a repository's measured test coverage from the artefacts its CI published, into the store, for display only
 * (ADR 0030). It runs on every crawl while code analysis is on, whether or not the clone is skipped, so coverage that
 * CI publishes after a crawl is picked up by the next one even though the branch head has not moved.
 *
 * A failed read is stored as an error snapshot and logged, and the last good snapshot stays the one the report uses.
 * A repository with no coverage artefact stores nothing, unless the search was cut short (a failure saying so) or an
 * earlier failure is showing (it is cleared, as it no longer describes the repository). Only a rejected credential is
 * rethrown, as it would fail every later step too (ADR 0028); the caller isolates anything else.
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
    let run: CoverageRun | null = null;
    try {
      const analysed = this.store.latestSuccessfulCodeSnapshot(repo.id)?.commitSha || null;
      const search = await this.source.findArtefacts(token, repo.owner, repo.name, repo.deployBranch);
      run = chooseCoverageRun(search.artefacts, analysed);
      if (run === null) {
        this.noRun(repo, search.complete);
        return;
      }
      if (!force && this.alreadyRead(repo.id, run)) return;

      const reports: CoverageReport[] = [];
      const unreadable: string[] = [];
      let empty = 0;
      for (const artefact of run.artefacts) {
        const contents = await this.source.readArtefact(token, repo.owner, repo.name, artefact);
        reports.push(...contents.reports);
        unreadable.push(...contents.unreadable);
        empty += contents.empty;
      }
      if (reports.length > 0) {
        this.store.saveCoverageSnapshot(repo.id, {
          ...this.stamp(),
          ...run,
          reports,
          unreadableFiles: unreadable.length,
          error: null,
        });
        return;
      }
      const error = unreadable.length > 0 ? unreadableMessage(unreadable) : empty > 0 ? EMPTY_REPORTS : NO_REPORTS;
      this.log.warn({ repoId: repo.id, runId: run.runId, artefactIds: ids(run) }, "coverage artefacts held no usable report");
      this.fail(repo.id, run, error);
    } catch (err) {
      if (err instanceof UnauthorisedError) throw err;
      const context = { err, repoId: repo.id, runId: run?.runId ?? null, artefactIds: ids(run) };
      if (err instanceof AppError) this.log.warn(context, "coverage step failed");
      else this.log.error(context, "coverage step failed unexpectedly");
      this.fail(repo.id, run, err instanceof AppError ? err.message : UNEXPECTED_FAILURE);
    }
  }

  /** Nothing was found. An incomplete search says so; a complete one drops an earlier failure that no longer holds. */
  private noRun(repo: Repo, complete: boolean): void {
    if (!complete) {
      this.log.warn({ repoId: repo.id, runId: null, artefactIds: [] }, "no coverage artefact among the newest 300");
      this.fail(repo.id, null, NOT_AMONG_NEWEST);
      return;
    }
    const latest = this.store.latestCoverageSnapshot(repo.id);
    if (latest !== null && latest.error !== null) {
      this.store.clearCoverageFailures(repo.id);
      this.log.info(
        { repoId: repo.id, runId: null, artefactIds: [] },
        "cleared an earlier coverage failure, as no coverage artefact exists",
      );
    }
  }

  /** A failed read is tried again, so only a snapshot that succeeded can stand in for reading. */
  private alreadyRead(repoId: number, run: CoverageRun): boolean {
    const previous = this.store.latestCoverageSnapshot(repoId);
    return (
      previous !== null &&
      previous.error === null &&
      previous.version === COVERAGE_SNAPSHOT_VERSION &&
      previous.runId === run.runId &&
      previous.artefacts.length === run.artefacts.length &&
      previous.artefacts.every((artefact, i) => artefact.id === run.artefacts[i]?.id)
    );
  }

  private stamp(): { fetchedAt: string; version: number } {
    return { fetchedAt: this.now().toISOString(), version: COVERAGE_SNAPSHOT_VERSION };
  }

  private fail(repoId: number, run: CoverageRun | null, error: string): void {
    const snapshot: CoverageReadFailure = {
      ...this.stamp(),
      runId: run?.runId ?? null,
      commitSha: run?.commitSha ?? null,
      artefacts: run?.artefacts ?? [],
      reports: [],
      error,
    };
    this.store.saveCoverageSnapshot(repoId, snapshot);
  }
}
