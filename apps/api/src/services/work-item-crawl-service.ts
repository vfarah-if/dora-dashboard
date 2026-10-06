import { NotFoundError } from "../core/errors.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { WorkItemProvider } from "../interfaces/work-item-provider.js";
import type { JiraAuthService } from "./jira-auth-service.js";

function cursorBefore(newest: string): string {
  const at = Date.parse(newest);
  return Number.isNaN(at) ? newest : new Date(at - CURSOR_OVERLAP_MS).toISOString();
}

type CrawledSpace = NonNullable<ReturnType<RepoStore["getSpace"]>>;

/**
 * Reads a tracker space's work items into the store, as `CrawlService` does for pull requests.
 *
 * Incremental by default: pages come most recently updated first, so the crawl stops at the first page
 * holding an item no newer than the last complete crawl. A full crawl clears that cursor and re-reads
 * everything and, once it completes, removes stored items the space no longer holds. The token is asked for per page, so a grant that expires mid-crawl is refreshed.
 */
/** How far behind the newest item the stored cursor sits, so late-indexed and same-millisecond items are re-read. */
export const CURSOR_OVERLAP_MS = 5 * 60_000;

interface ReadOutcome {
  newest: string | null;
  keys: Set<string>;
}

export class WorkItemCrawlService {
  private readonly running = new Set<number>();

  constructor(
    private readonly store: RepoStore,
    private readonly provider: WorkItemProvider,
    private readonly auth: JiraAuthService,
    private readonly log: Logger = noopLogger,
  ) {}

  /** Whether the given space is being crawled, or any space when none is given. */
  isCrawling(spaceId?: number): boolean {
    return spaceId === undefined ? this.running.size > 0 : this.running.has(spaceId);
  }

  /** Resolves `false`, having done nothing, when the space is already being crawled. */
  async crawl(login: string, spaceId: number, full = false): Promise<boolean> {
    if (this.running.has(spaceId)) return false;
    const space = this.store.getSpace(spaceId);
    if (!space) throw new NotFoundError(`Unknown space ${spaceId}`);

    this.running.add(spaceId);
    try {
      if (full) this.store.resetSpaceCrawlCursor(spaceId);
      await this.readDetails(login, space);
      const read = await this.readWorkItems(login, space);
      // A space pruned mid-crawl has nothing left to finish.
      if (read && this.store.getSpace(spaceId)) {
        if (full) this.store.removeWorkItemsExcept(spaceId, read.keys);
        this.store.finishSpaceCrawl(spaceId, read.newest === null ? null : cursorBefore(read.newest));
      }
    } catch (error) {
      this.log.warn({ err: error, spaceId }, "space crawl failed");
      this.store.setSpaceCrawlState(spaceId, "failed", null, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.running.delete(spaceId);
    }
    return true;
  }

  private async readDetails(login: string, space: CrawledSpace): Promise<void> {
    this.store.setSpaceCrawlState(space.id, "crawling", "Reading statuses and board columns");
    const token = await this.auth.accessToken(login);
    const [statuses, columns] = await Promise.all([
      this.provider.fetchStatuses(token, space.siteId, space.key),
      this.provider.fetchBoardColumns(token, space.siteId, space.key),
    ]);
    this.store.setSpaceDetails(space.id, statuses, columns);
  }

  /** Pages through work items until one is no newer than the last crawl; returns the newest `updatedAt` and every key seen, or null if the space was removed meanwhile. */
  private async readWorkItems(login: string, space: CrawledSpace): Promise<ReadOutcome | null> {
    const stopAt = this.store.spaceCrawlCursor(space.id);
    this.store.setSpaceCrawlState(space.id, "crawling", "Reading work items");

    let cursor: string | null = null;
    let newest: string | null = null;
    let seen = 0;
    const keys = new Set<string>();
    do {
      const token = await this.auth.accessToken(login);
      const page = await this.provider.fetchWorkItemPage(token, space.siteId, space.key, stopAt, cursor);
      const fresh = stopAt ? page.items.filter((item) => item.updatedAt > stopAt) : page.items;
      newest ??= page.items[0]?.updatedAt ?? null;
      for (const item of page.items) keys.add(item.key);
      if (!this.store.getSpace(space.id)) {
        this.log.warn({ spaceId: space.id }, "space was removed during its crawl; stopping");
        return null;
      }
      this.store.upsertWorkItems(space.id, fresh);
      seen += fresh.length;
      this.store.setSpaceCrawlState(space.id, "crawling", `Read ${seen} work items`);
      cursor = fresh.length < page.items.length ? null : page.nextCursor;
    } while (cursor);
    return { newest, keys };
  }
}
