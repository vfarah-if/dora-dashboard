import { AppError, NotFoundError, TrackerUnauthorisedError, UnauthorisedError } from "../core/errors.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { WorkItemProvider } from "../interfaces/work-item-provider.js";
import { cursorBefore } from "./crawl-cursor.js";
import { CRAWL_REFUSED, type JiraAuthService } from "./jira-auth-service.js";

/** Shown in place of a failure's own message when it is not one the person can act on; the detail is in the log. */
const UNEXPECTED_FAILURE = "The crawl failed unexpectedly. See the API log.";

type CrawledSpace = NonNullable<ReturnType<RepoStore["getSpace"]>>;

interface UsedToken {
  token: string | null;
}

interface ReadOutcome {
  newest: string | null;
  keys: Set<string>;
  /** Display names the pages carried, by account id. */
  people: Record<string, string>;
}

/**
 * Reads a tracker space's work items into the store, as `CrawlService` does for pull requests.
 *
 * Incremental by default: pages come most recently updated first, so the crawl stops at the first page holding an
 * item no newer than the last complete crawl. A full crawl clears that cursor and re-reads everything and, once it
 * completes, removes stored items the space no longer holds. The token is asked for per page, so a grant that
 * expires mid-crawl is refreshed.
 */
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
    // The access token the crawl last asked for, so a refusal can be traced to the grant that carried it.
    const used: UsedToken = { token: null };
    try {
      if (full) this.store.resetSpaceCrawlCursor(spaceId);
      await this.readDetails(login, space, used);
      const read = await this.readWorkItems(login, space, used);
      // A space pruned mid-crawl has nothing left to finish.
      if (read && this.store.getSpace(spaceId)) {
        if (full) this.store.removeWorkItemsExcept(spaceId, read.keys);
        this.savePeople(space, read.people, full);
        this.store.finishSpaceCrawl(spaceId, read.newest === null ? null : cursorBefore(read.newest, "a work item"));
      }
    } catch (caught) {
      const error = this.refusedGrant(login, used.token, caught);
      // Only a failure the services raised on purpose carries a message fit for the person; anything else stays in the log.
      if (error instanceof AppError) this.log.warn({ err: error, spaceId }, "space crawl failed");
      else this.log.error({ err: error, spaceId }, "space crawl failed unexpectedly");
      this.recordFailure(spaceId, error);
      throw error;
    } finally {
      this.running.delete(spaceId);
    }
    return true;
  }

  /**
   * Writes the failure onto the space. Were this to fail too, the caller's own catch is quiet and would lose the
   * reason the crawl failed, so it is logged here, at error, and the original failure still reaches the caller.
   */
  private recordFailure(spaceId: number, error: unknown): void {
    try {
      this.store.setSpaceCrawlState(spaceId, "failed", null, error instanceof AppError ? error.message : UNEXPECTED_FAILURE);
    } catch (recordingError) {
      this.log.error({ err: recordingError, crawlError: error, spaceId }, "could not record that the space crawl failed");
    }
  }

  /**
   * A grant Jira rejected mid-crawl is as good as gone, as it is when a read finds out (`TrackerService`): it is
   * dropped, so the person is not left shown as connected, unless it is no longer the grant Jira refused (the person
   * has connected again meanwhile). The failure stored on the space is neutral, because everyone who views the space
   * reads it and only the person whose grant it was has a connection to renew. A failure `JiraAuthService` raised
   * itself is left as it was, and so is any other error.
   */
  private refusedGrant(login: string, token: string | null, error: unknown): unknown {
    if (!(error instanceof UnauthorisedError) || error instanceof TrackerUnauthorisedError) return error;
    const dropped = token !== null && this.auth.dropIfCurrent(login, token);
    this.log.warn({ err: error, dropped }, "jira rejected the grant during a crawl");
    return new TrackerUnauthorisedError(CRAWL_REFUSED, { cause: error });
  }

  /** A full crawl replaces the names with those it read; an incremental one adds to the names already stored. */
  private savePeople(space: CrawledSpace, read: Record<string, string>, full: boolean): void {
    if (full) this.store.setSpacePeople(space.id, read);
    else if (Object.keys(read).length > 0) {
      this.store.setSpacePeople(space.id, { ...this.store.getSpace(space.id)?.people, ...read });
    }
  }

  private async readDetails(login: string, space: CrawledSpace, used: UsedToken): Promise<void> {
    this.store.setSpaceCrawlState(space.id, "crawling", "Reading statuses and board columns");
    const token = (used.token = await this.auth.accessToken(login));
    const [statuses, { columns, board }] = await Promise.all([
      this.provider.fetchStatuses(token, space.siteId, space.key),
      this.provider.fetchBoardColumns(token, space.siteId, space.key),
    ]);
    this.store.setSpaceDetails(space.id, statuses, columns, board);
  }

  /** Pages through work items until one is no newer than the last crawl; returns the newest `updatedAt` and every key seen, or null if the space was removed meanwhile. */
  private async readWorkItems(login: string, space: CrawledSpace, used: UsedToken): Promise<ReadOutcome | null> {
    const stopAt = this.store.spaceCrawlCursor(space.id);
    this.store.setSpaceCrawlState(space.id, "crawling", "Reading work items");

    let cursor: string | null = null;
    let newest: string | null = null;
    let seen = 0;
    const keys = new Set<string>();
    // A map, so an account id such as "__proto__" is kept as a name rather than read as the object's prototype.
    const people = new Map<string, string>();
    do {
      const token = (used.token = await this.auth.accessToken(login));
      const page = await this.provider.fetchWorkItemPage(token, space.siteId, space.key, { updatedSince: stopAt, cursor });
      const fresh = stopAt ? page.items.filter((item) => item.updatedAt > stopAt) : page.items;
      newest ??= page.items[0]?.updatedAt ?? null;
      for (const item of page.items) keys.add(item.key);
      for (const id in page.people) if (Object.hasOwn(page.people, id)) people.set(id, page.people[id]!);
      if (!this.store.getSpace(space.id)) {
        this.log.warn({ spaceId: space.id }, "space was removed during its crawl; stopping");
        return null;
      }
      this.store.upsertWorkItems(space.id, fresh);
      seen += fresh.length;
      this.store.setSpaceCrawlState(space.id, "crawling", `Read ${seen} work items`);
      cursor = fresh.length < page.items.length ? null : page.nextCursor;
    } while (cursor);
    return { newest, keys, people: Object.fromEntries(people) };
  }
}
