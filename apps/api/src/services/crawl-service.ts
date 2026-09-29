import type { DeployRun } from "@dora-dashboard/core";
import { NotFoundError } from "../core/errors.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SourceProvider } from "../interfaces/source-provider.js";

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
  ) {}

  isCrawling(repoId: number): boolean {
    return this.running.has(repoId);
  }

  async crawl(token: string, repoId: number, full = false): Promise<void> {
    if (this.running.has(repoId)) return;
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new NotFoundError(`Unknown repository ${repoId}`);

    this.running.add(repoId);
    try {
      if (full) this.store.resetCrawlCursor(repoId);
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

      const runs: DeployRun[] = [];
      for (const workflow of repo.deployWorkflows) {
        this.store.setCrawlState(repoId, "crawling", `Reading runs of ${workflow}`);
        runs.push(...(await this.provider.fetchDeployRuns(token, repo.owner, repo.name, workflow)));
      }
      this.store.replaceDeployRuns(repoId, runs);
      this.store.finishCrawl(repoId, newest);
    } catch (error) {
      this.store.setCrawlState(repoId, "failed", null, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.running.delete(repoId);
    }
  }
}
