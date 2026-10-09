import type { Repo } from "@dora-dashboard/core";
import { UpstreamError } from "../core/errors.js";
import type { IssueProvider } from "../interfaces/issue-provider.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import { cursorBefore } from "./crawl-cursor.js";

/**
 * Reads a repository's issues from its code host into the store, as `CrawlService` does for pull requests.
 *
 * Pages come most recently updated first. An incremental read stops after the first page holding an issue no newer
 * than the stored cursor, which sits five minutes behind the newest update the last complete read saw, so a late
 * indexed issue is read again. A full read, and the first read, start from the beginning and ignore the cursor; only
 * such a read removes stored issues the host no longer holds. The cursor moves only when a read completes, full or
 * incremental, so a failure leaves the next read to start where the last good one stopped. A repository with issues
 * switched off has its issues, cursor and issue error cleared together. Whatever fails here is the caller's to isolate.
 */
export class IssueCrawlService {
  constructor(
    private readonly store: RepoStore,
    private readonly provider: IssueProvider,
    private readonly log: Logger = noopLogger,
  ) {}

  async read(token: string, repo: Repo, full: boolean): Promise<void> {
    const stopAt = full ? null : this.store.issueState(repo.id).cursor;
    this.store.setCrawlState(repo.id, "crawling", "Reading issues");

    let cursor: string | null = null;
    let newest: string | null = null;
    let seen = 0;
    const numbers = new Set<number>();
    do {
      const page = await this.provider.fetchIssuePage(token, repo.owner, repo.name, { updatedSince: stopAt, cursor });
      // A repository removed meanwhile has nothing left to finish.
      if (!this.store.getRepo(repo.id)) {
        this.log.warn({ repoId: repo.id }, "repository was removed during its issue read; stopping");
        return;
      }
      if (!page.enabled) {
        this.store.disableIssues(repo.id);
        return;
      }
      // Refuse the page before anything from it is stored: an update time that is not a date cannot be ordered.
      const bad = page.items.find((issue) => Number.isNaN(Date.parse(issue.updatedAt)));
      if (bad) {
        throw new UpstreamError(
          `The code host sent issue #${bad.number} with an update time that is not a date (${JSON.stringify(bad.updatedAt.slice(0, 40))})`,
          502,
        );
      }
      // Instants, not strings: GitHub writes `...:00Z` where the cursor is `...:00.000Z`, and the two sort differently.
      const stopMs = stopAt === null ? null : Date.parse(stopAt);
      const fresh = stopMs === null ? page.items : page.items.filter((issue) => Date.parse(issue.updatedAt) > stopMs);
      newest ??= page.items[0]?.updatedAt ?? null;
      for (const issue of page.items) numbers.add(issue.number);
      this.store.upsertIssues(repo.id, fresh);
      seen += page.items.length;
      this.store.setCrawlState(repo.id, "crawling", `Read ${seen} of ${page.totalCount} issues`);
      cursor = fresh.length < page.items.length ? null : page.nextCursor;
    } while (cursor);

    // Worked out first, so a bad cursor cannot leave a half-finished prune.
    const next = newest === null ? null : cursorBefore(newest, "an issue");
    // Only a read that began at the start saw every issue, so only it can say which are gone.
    if (stopAt === null) this.store.removeIssuesExcept(repo.id, numbers);
    this.store.finishIssueCrawl(repo.id, next);
  }
}
