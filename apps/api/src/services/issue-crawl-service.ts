import type { Repo } from "@dora-dashboard/core";
import type { IssueProvider } from "../interfaces/issue-provider.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import { cursorBefore } from "./crawl-cursor.js";

/**
 * Reads a repository's issues from its code host into the store, as `CrawlService` does for pull requests.
 *
 * Incremental by default: pages come most recently updated first, so the read stops at the first page holding an
 * issue no newer than the last complete read. A full read clears that cursor and re-reads everything and, once it
 * completes, removes stored issues the host no longer holds. A repository with issues switched off has its stored
 * issues cleared and is recorded as such. Whatever fails here is the caller's to isolate: the cursor is only moved
 * by a read that completes, so a failure leaves the next read to start where the last good one stopped.
 */
export class IssueCrawlService {
  constructor(
    private readonly store: RepoStore,
    private readonly provider: IssueProvider,
    private readonly log: Logger = noopLogger,
  ) {}

  async read(token: string, repo: Repo, full: boolean): Promise<void> {
    if (full) this.store.resetIssueCursor(repo.id);
    const stopAt = this.store.issueState(repo.id).cursor;
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
        this.store.clearIssues(repo.id);
        // Issues switched back on later must be read from the start, not from a cursor older than the cleared ones.
        this.store.resetIssueCursor(repo.id);
        this.store.finishIssueCrawl(repo.id, false, null);
        return;
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

    // Only a read that began at the start saw every issue, so only it can say which are gone.
    if (stopAt === null) this.store.removeIssuesExcept(repo.id, numbers);
    this.store.finishIssueCrawl(repo.id, true, newest === null ? null : cursorBefore(newest, "issue"));
  }
}
