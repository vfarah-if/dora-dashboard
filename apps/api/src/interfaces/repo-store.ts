import type { CodeSnapshot, DeployRun, PullRequest, Repo } from "@dora-dashboard/core";

export interface RepoCounts {
  pullRequests: number;
  deployRuns: number;
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
}
