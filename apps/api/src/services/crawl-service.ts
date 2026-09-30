import type { DeployRun } from "@dora-dashboard/core";
import { NotFoundError } from "../core/errors.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SourceProvider } from "../interfaces/source-provider.js";
import type { CodeHealthService } from "./code-health-service.js";

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

  async crawl(token: string, repoId: number, full = false): Promise<void> {
    if (this.running.has(repoId)) return;
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new NotFoundError(`Unknown repository ${repoId}`);

    this.running.add(repoId);
    try {
      if (full) this.store.resetCrawlCursor(repoId);
      const newest = await this.readPullRequests(token, repoId, repo);
      await this.readDeployRuns(token, repoId, repo);
      await this.analyseCode(token, repoId, full);
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
