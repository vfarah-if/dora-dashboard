import type { DeployRun } from "@dora-dashboard/core";
import { AppError, NotFoundError, UnauthorisedError } from "../core/errors.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SourceProvider } from "../interfaces/source-provider.js";
import type { CodeHealthService } from "./code-health-service.js";
import type { CoverageService } from "./coverage-service.js";
import type { IssueCrawlService } from "./issue-crawl-service.js";

/** Stored in place of a failure's own message when it is not one the person can act on; the detail is in the log. */
const UNEXPECTED_ISSUE_FAILURE = "Reading issues failed unexpectedly. See the API log.";

type CrawledRepo = NonNullable<ReturnType<RepoStore["getRepo"]>>;

/**
 * Reads a repository's pull requests and deploy runs from its code host into the store.
 *
 * Incremental by default: the provider returns pages most recently updated first, so the crawl
 * stops at the first page containing a PR no newer than the last complete crawl. A full crawl
 * clears that cursor and re-reads everything. Deploy runs are always replaced whole, because
 * a run's conclusion changes after the fact (a re-run turns a failure into a success).
 */
export class CrawlService {
  private readonly running = new Set<number>();

  constructor(
    private readonly store: RepoStore,
    private readonly provider: SourceProvider,
    private readonly codeHealth?: CodeHealthService,
    private readonly log: Logger = noopLogger,
    private readonly issues?: IssueCrawlService,
    private readonly coverage?: CoverageService,
  ) {}

  isCrawling(repoId: number): boolean {
    return this.running.has(repoId);
  }

  /** Code health is a bonus: whatever goes wrong here is recorded on the snapshot and never fails the crawl. */
  private async analyseCode(token: string, repoId: number, full: boolean): Promise<void> {
    if (!this.codeHealth) return;
    try {
      this.store.setCrawlState(repoId, "crawling", "Analysing code");
      await this.codeHealth.analyse(token, repoId, full);
    } catch (err) {
      this.log.warn({ err, repoId }, "code health step failed");
    }
  }

  /**
   * Coverage is a bonus too, and is read on every crawl, even when the branch head has not moved, so coverage that CI
   * published after the last crawl is found. The service stores its own failures; a rejected credential is the
   * exception and fails the crawl, as for issues.
   */
  private async readCoverage(token: string, repo: CrawledRepo, full: boolean): Promise<void> {
    if (!this.coverage) return;
    try {
      this.store.setCrawlState(repo.id, "crawling", "Reading coverage");
      await this.coverage.read(token, repo, full);
    } catch (err) {
      if (err instanceof UnauthorisedError) throw err;
      this.log.warn({ err, repoId: repo.id }, "coverage step failed");
    }
  }

  /**
   * Issues are a bonus too: a failure is stored on the repository as its issue error and logged, the issue cursor is
   * left where the last complete read put it, and the pull request crawl still finishes. A rejected credential is the
   * exception: it would fail every later step too, so it fails the crawl and the usual sign-in handling applies.
   */
  private async readIssues(token: string, repo: CrawledRepo, full: boolean): Promise<void> {
    if (!this.issues) return;
    try {
      await this.issues.read(token, repo, full);
    } catch (err) {
      if (err instanceof UnauthorisedError) throw err;
      if (err instanceof AppError) this.log.warn({ err, repoId: repo.id }, "issue step failed");
      else this.log.error({ err, repoId: repo.id }, "issue step failed unexpectedly");
      this.store.failIssueCrawl(repo.id, err instanceof AppError ? err.message : UNEXPECTED_ISSUE_FAILURE);
    }
  }

  async crawl(token: string, repoId: number, full = false): Promise<void> {
    if (this.running.has(repoId)) return;
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new NotFoundError(`Unknown repository ${repoId}`);

    this.running.add(repoId);
    try {
      if (full) this.store.resetCrawlCursor(repoId);
      const newest = await this.readPullRequests(token, repoId, repo);
      await this.readDeployRuns(token, repoId, repo);
      await this.readIssues(token, repo, full);
      await this.analyseCode(token, repoId, full);
      await this.readCoverage(token, repo, full);
      this.store.finishCrawl(repoId, newest);
    } catch (error) {
      this.store.setCrawlState(repoId, "failed", null, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.running.delete(repoId);
    }
  }

  /** Pages through pull requests until one is no newer than the last crawl; returns the newest `updatedAt` seen. */
  private async readPullRequests(token: string, repoId: number, repo: CrawledRepo): Promise<string | null> {
    const stopAt = this.store.crawlCursor(repoId);
    this.store.setCrawlState(repoId, "crawling", "Reading pull requests");

    let cursor: string | null = null;
    let newest: string | null = null;
    let seen = 0;
    do {
      const page = await this.provider.fetchPullRequestPage(token, repo.owner, repo.name, cursor);
      const fresh = stopAt ? page.pullRequests.filter((p) => p.updatedAt > stopAt) : page.pullRequests;
      newest ??= page.pullRequests[0]?.updatedAt ?? null;
      this.store.upsertPullRequests(repoId, fresh);
      seen += page.pullRequests.length;
      this.store.setCrawlState(repoId, "crawling", `Read ${seen} of ${page.totalCount} pull requests`);
      cursor = fresh.length < page.pullRequests.length ? null : page.nextCursor;
    } while (cursor);
    return newest;
  }

  /** Deploy runs are replaced whole, since a run's conclusion can change after the fact. */
  private async readDeployRuns(token: string, repoId: number, repo: CrawledRepo): Promise<void> {
    const runs: DeployRun[] = [];
    for (const workflow of repo.deployWorkflows) {
      this.store.setCrawlState(repoId, "crawling", `Reading runs of ${workflow}`);
      runs.push(...(await this.provider.fetchDeployRuns(token, repo.owner, repo.name, workflow)));
    }
    this.store.replaceDeployRuns(repoId, runs);
  }
}
