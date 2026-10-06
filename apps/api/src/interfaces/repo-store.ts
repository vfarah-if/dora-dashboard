import type {
  BoardColumn,
  CodeSnapshot,
  DeployRun,
  PullRequest,
  Repo,
  TrackerSpace,
  TrackerStatus,
  WorkItem,
} from "@dora-dashboard/core";

export interface RepoCounts {
  pullRequests: number;
  deployRuns: number;
}

/** A tracker space to link to a repository; the store assigns its id. */
export interface SpaceLink {
  siteId: string;
  siteUrl: string;
  key: string;
  name: string;
}

/** Persistence for tracked repositories and everything crawled from them. */
export interface RepoStore {
  listRepos(): Repo[];
  getRepo(id: number): Repo | null;
  findRepo(owner: string, name: string): Repo | null;
  addRepo(owner: string, name: string, deployWorkflows: string[], deployBranch: string): Repo;
  updateRepoConfig(id: number, deployWorkflows: string[], deployBranch: string): void;
  deleteRepo(id: number): void;

  setCrawlState(id: number, status: Repo["crawlStatus"], progress: string | null, error?: string | null): void;
  finishCrawl(id: number, cursor: string | null): void;
  /** The newest `updatedAt` a complete crawl saw; an incremental crawl stops once it reaches it. */
  crawlCursor(id: number): string | null;
  resetCrawlCursor(id: number): void;

  upsertPullRequests(repoId: number, prs: PullRequest[]): void;
  replaceDeployRuns(repoId: number, runs: DeployRun[]): void;
  pullRequests(repoId: number): PullRequest[];
  deployRuns(repoId: number): DeployRun[];
  counts(repoId: number): RepoCounts;

  /** The last 10 snapshots are kept (plus the newest successful one), so a trend can be drawn later. */
  saveCodeSnapshot(repoId: number, snapshot: CodeSnapshot): void;
  /** The newest snapshot of any kind, including a failed attempt. */
  latestCodeSnapshot(repoId: number): CodeSnapshot | null;
  /** The newest snapshot that carries no error. */
  latestSuccessfulCodeSnapshot(repoId: number): CodeSnapshot | null;

  /**
   * Makes `spaces` the repository's linked spaces on the site `siteId`: each is created (or has its name and site URL
   * refreshed) and the repository's earlier links on that site are replaced. Links on other sites are left alone.
   * Spaces left linked to no repository are removed with their work items. Returns the given spaces in order.
   */
  linkSpaces(repoId: number, siteId: string, spaces: SpaceLink[]): TrackerSpace[];
  /** The spaces linked to a repository, ordered by site then key. */
  spacesFor(repoId: number): TrackerSpace[];
  getSpace(id: number): TrackerSpace | null;
  setSpaceDetails(id: number, statuses: TrackerStatus[], columns: BoardColumn[]): void;
  setSpaceCrawlState(id: number, status: TrackerSpace["crawlStatus"], progress: string | null, error?: string | null): void;
  finishSpaceCrawl(id: number, cursor: string | null): void;
  /** The point a complete crawl leaves for the next: the newest `updatedAt` it saw less a small overlap. An incremental crawl stops once it reaches it. */
  spaceCrawlCursor(id: number): string | null;
  resetSpaceCrawlCursor(id: number): void;

  upsertWorkItems(spaceId: number, items: WorkItem[]): void;
  /** Deletes the space's work items whose keys are not in `keep`; returns how many went. */
  removeWorkItemsExcept(spaceId: number, keep: ReadonlySet<string>): number;
  workItems(spaceId: number): WorkItem[];
  workItemCount(spaceId: number): number;
}
