import type {
  BoardAccess,
  BoardColumn,
  CodeSnapshot,
  CoverageRead,
  CoverageSnapshot,
  CrawlStatus,
  DeployRun,
  IssueLabelRules,
  PullRequest,
  RepoIssue,
  Repo,
  TrackerSpace,
  TrackerStatus,
  WorkItem,
} from "@dora-dashboard/core";

/** The timestamps that identify the newest snapshot and the newest successful one, so a cache can tell when either changed. */
export interface SnapshotKeys {
  latest: string | null;
  good: string | null;
}

export interface RepoCounts {
  pullRequests: number;
  deployRuns: number;
  issues: number;
}

/** What the store holds about a repository's issue crawl, apart from the issues themselves. */
export interface IssueState {
  /** Whether the host reported issues switched on at the last crawl; null before issues were first read. */
  enabled: boolean | null;
  /**
   * The newest update the last complete issue read saw, less the overlap (ADR 0028); null before one finished, and
   * after issues were switched off.
   */
  cursor: string | null;
  /** The repository's label override; null when the defaults apply, or when what was saved cannot be read. */
  labels: IssueLabelRules | null;
  /** True when an override was saved but cannot be read (bad JSON or the wrong shape); `labels` is then null. */
  labelsUnreadable: boolean;
  /** Why the last issue read failed; null when it succeeded or never ran. */
  error: string | null;
}

/** Persistence for tracked repositories and everything crawled from them. */
export interface RepoStore {
  listRepos(): Repo[];
  getRepo(id: number): Repo | null;
  findRepo(owner: string, name: string): Repo | null;
  addRepo(owner: string, name: string, deployWorkflows: string[], deployBranch: string): Repo;
  updateRepoConfig(id: number, deployWorkflows: string[], deployBranch: string): void;
  deleteRepo(id: number): void;

  setCrawlState(id: number, status: CrawlStatus, progress: string | null, error?: string | null): void;
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
  /** `analysedAt` of the newest snapshot and of the newest successful one, read without loading either. Null when none. */
  codeSnapshotKeys(repoId: number): SnapshotKeys;

  /**
   * The last 5 coverage reads are kept (plus the newest successful one), so a failed read never erases the last good
   * figures. A read that failed is saved too, with `error` set and no reports.
   */
  saveCoverageSnapshot(repoId: number, snapshot: CoverageSnapshot): void;
  /** The newest coverage read of any kind, including a failed attempt. */
  latestCoverageSnapshot(repoId: number): CoverageSnapshot | null;
  /** The newest coverage read that carries no error. */
  latestSuccessfulCoverageSnapshot(repoId: number): CoverageRead | null;
  /**
   * Deletes the repository's failed coverage reads and keeps the good ones. Used when a complete search finds no
   * coverage artefact at all, so that an old failure, such as a missing permission since granted, is no longer
   * shown as the current state.
   */
  clearCoverageFailures(repoId: number): void;
  /** `fetchedAt` of the newest coverage read and of the newest successful one, read without loading either. Null when none. */
  coverageSnapshotKeys(repoId: number): SnapshotKeys;

  /**
   * Makes `spaces` the repository's linked spaces on `site`: each is created (or has its name and the site's URL
   * refreshed) and the repository's earlier links on that site are replaced. Links on other sites are left alone.
   * Every space belongs to `site`, which is given once so no space can name another. Spaces left linked to no
   * repository are removed with their work items. Returns the given spaces in order.
   */
  linkSpaces(repoId: number, site: { id: string; url: string }, spaces: { key: string; name: string }[]): TrackerSpace[];
  /** The spaces linked to a repository, ordered by site then key. */
  spacesFor(repoId: number): TrackerSpace[];
  /** Every tracked space, ordered by site then key. */
  listSpaces(): TrackerSpace[];
  /** The repositories a space is linked to, ordered by owner then name. */
  reposForSpace(spaceId: number): Repo[];
  getSpace(id: number): TrackerSpace | null;
  /** Replaces the space's assignee display names (account id to name). A space never given any reads back without `people`. */
  setSpacePeople(id: number, people: Record<string, string>): void;
  /** Records the statuses and board columns read, and `board`, which says why the columns are empty when they are. */
  setSpaceDetails(id: number, statuses: TrackerStatus[], columns: BoardColumn[], board: BoardAccess): void;
  setSpaceCrawlState(id: number, status: CrawlStatus, progress: string | null, error?: string | null): void;
  /** Marks the crawl complete. A null `cursor` keeps the cursor already stored rather than clearing it. */
  finishSpaceCrawl(id: number, cursor: string | null): void;
  /** The point a complete crawl leaves for the next: the newest `updatedAt` it saw less a small overlap. An incremental crawl stops once it reaches it. */
  spaceCrawlCursor(id: number): string | null;
  resetSpaceCrawlCursor(id: number): void;

  upsertWorkItems(spaceId: number, items: WorkItem[]): void;
  /** Deletes the space's work items whose keys are not in `keep`; returns how many went. */
  removeWorkItemsExcept(spaceId: number, keep: ReadonlySet<string>): number;
  workItems(spaceId: number): WorkItem[];
  workItemCount(spaceId: number): number;

  /** Inserts or replaces each issue by number. */
  upsertIssues(repoId: number, issues: RepoIssue[]): void;
  /** Deletes the repository's issues whose numbers are not in `keep`; returns how many went. */
  removeIssuesExcept(repoId: number, keep: ReadonlySet<number>): number;
  /** The repository's issues, most recently updated first (by the stored `updated_at`), then by number. */
  issues(repoId: number): RepoIssue[];
  issueState(repoId: number): IssueState;
  /**
   * Records the read as complete with issues switched on and clears any earlier failure. A null `cursor` keeps the
   * stored one.
   */
  finishIssueCrawl(repoId: number, cursor: string | null): void;
  /** Deletes the issues, clears the cursor and the issue error and records issues as switched off, in one transaction. */
  disableIssues(repoId: number): void;
  /** Records why the issue read failed. Neither the cursor nor the stored issues are touched. */
  failIssueCrawl(repoId: number, message: string): void;
  /** Saves the repository's label override, or the defaults again when null. Starts no crawl. */
  setIssueLabels(repoId: number, rules: IssueLabelRules | null): void;
}
