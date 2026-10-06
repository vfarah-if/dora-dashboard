import { createHash } from "node:crypto";
import type { BoardColumn, TrackerSite, TrackerSpace, TrackerSpaceSummary, TrackerStatus } from "@dora-dashboard/core";
import { ConflictError, NotFoundError, TrackerUnauthorisedError, UnauthorisedError } from "../core/errors.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { WorkItemProvider } from "../interfaces/work-item-provider.js";
import type { JiraAuthService } from "./jira-auth-service.js";
import type { WorkItemCrawlService } from "./work-item-crawl-service.js";

/** Spaces listed live are kept this long, per token and site, in memory only (as the review queue is, ADR 0017). */
export const SPACE_LIST_TTL_MS = 60_000;

export interface SpaceDescription {
  statuses: TrackerStatus[];
  columns: BoardColumn[];
}

/** A linked space with how many of its work items are stored. */
export type LinkedSpace = TrackerSpace & { workItemCount: number };

interface CachedSpaces {
  at: number;
  spaces: TrackerSpaceSummary[];
}

/**
 * What the picker needs from the tracker: live site and space lists, a look at one space, and linking spaces to a
 * repository. The space list is cached for a minute under a hash of the token and site, so no token is kept as a key
 * and nobody receives what another person's grant read.
 */
export class TrackerService {
  private readonly cache = new Map<string, CachedSpaces>();

  constructor(
    private readonly store: RepoStore,
    private readonly provider: WorkItemProvider,
    private readonly auth: JiraAuthService,
    private readonly crawler: WorkItemCrawlService,
    private readonly clock: () => Date = () => new Date(),
    private readonly log: Logger = noopLogger,
    private readonly ttlMs = SPACE_LIST_TTL_MS,
  ) {}

  /** A rejected grant at the tracker means the same to the person as a missing one: connect again. */
  private async withToken<T>(login: string, read: (token: string) => Promise<T>): Promise<T> {
    const token = await this.auth.accessToken(login);
    try {
      return await read(token);
    } catch (error) {
      if (error instanceof UnauthorisedError && !(error instanceof TrackerUnauthorisedError)) {
        throw new TrackerUnauthorisedError("Jira refused the connection. Connect Jira again");
      }
      throw error;
    }
  }

  listSites(login: string): Promise<TrackerSite[]> {
    return this.withToken(login, (token) => this.provider.listSites(token));
  }

  listSpaces(login: string, siteId: string): Promise<TrackerSpaceSummary[]> {
    return this.withToken(login, async (token) => {
      const key = createHash("sha256").update(`${token}\u0000${siteId}`).digest("hex");
      const now = this.clock().getTime();
      const cached = this.cache.get(key);
      if (cached && now - cached.at < this.ttlMs) return cached.spaces;
      const spaces = await this.provider.listSpaces(token, siteId);
      this.prune(now);
      this.cache.set(key, { at: now, spaces });
      return spaces;
    });
  }

  /** Statuses and board columns read live, so the picker shows what the board looks like before anything is linked. */
  describeSpace(login: string, siteId: string, key: string): Promise<SpaceDescription> {
    return this.withToken(login, async (token) => {
      const [statuses, columns] = await Promise.all([
        this.provider.fetchStatuses(token, siteId, key),
        this.provider.fetchBoardColumns(token, siteId, key),
      ]);
      return { statuses, columns };
    });
  }

  /** The repository's linked spaces, with crawl state and how many work items are held. */
  linkedSpaces(repoId: number): LinkedSpace[] {
    this.requireRepo(repoId);
    return this.store.spacesFor(repoId).map((space) => this.withCount(space));
  }

  /**
   * Makes `keys` the repository's spaces on the site, after checking each exists and is visible, and starts a crawl
   * of each in the background. Spaces on other sites stay linked; an empty list unlinks only this site's. Returns
   * every space the repository has linked, across sites.
   */
  async linkSpaces(login: string, repoId: number, siteId: string, keys: string[]): Promise<LinkedSpace[]> {
    this.requireRepo(repoId);
    const wanted = [...new Set(keys)];
    if (wanted.length === 0) {
      this.store.linkSpaces(repoId, siteId, []);
      return this.linkedSpaces(repoId);
    }
    const sites = await this.listSites(login);
    const site = sites.find((s) => s.id === siteId);
    if (!site) throw new NotFoundError("That Jira site was not found, or your account cannot see it");
    const available = new Map((await this.listSpaces(login, siteId)).map((s) => [s.key, s]));
    const missing = wanted.filter((key) => !available.has(key));
    if (missing.length > 0) throw new NotFoundError(`Jira space not found: ${missing.join(", ")}`);

    const linked = this.store.linkSpaces(
      repoId,
      siteId,
      wanted.map((key) => ({ siteId, siteUrl: site.url, key, name: available.get(key)!.name })),
    );
    // A space already being crawled keeps its crawl; linking it again is not a failure.
    for (const space of linked) this.startCrawl(login, space.id, false);
    // The crawls have already marked each space as crawling, so read the spaces back for their current state.
    return this.linkedSpaces(repoId);
  }

  /** Starts a crawl of a stored space in the background; its outcome is read back through the space's crawl state. */
  crawlSpace(login: string, spaceId: number, full: boolean): void {
    if (!this.store.getSpace(spaceId)) throw new NotFoundError(`Unknown space ${spaceId}`);
    if (!this.startCrawl(login, spaceId, full)) throw new ConflictError("A crawl of this space is already running");
  }

  /** Whether a crawl started; false when the space is already being crawled. */
  private startCrawl(login: string, spaceId: number, full: boolean): boolean {
    if (this.crawler.isCrawling(spaceId)) return false;
    this.crawler.crawl(login, spaceId, full).catch((err: unknown) => this.log.warn({ err, spaceId }, "space crawl failed"));
    return true;
  }

  private requireRepo(repoId: number): void {
    if (!this.store.getRepo(repoId)) throw new NotFoundError(`Unknown repository ${repoId}`);
  }

  private withCount(space: TrackerSpace): LinkedSpace {
    return { ...space, workItemCount: this.store.workItemCount(space.id) };
  }

  private prune(now: number): void {
    for (const [key, cached] of this.cache) if (now - cached.at >= this.ttlMs) this.cache.delete(key);
  }
}
