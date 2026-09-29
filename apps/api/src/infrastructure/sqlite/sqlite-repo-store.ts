import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DeployRun, PullRequest, Repo } from "@dora-dashboard/core";
import type { RepoCounts, RepoStore } from "../../interfaces/repo-store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  deploy_workflows TEXT NOT NULL DEFAULT '[]',
  deploy_branch TEXT NOT NULL DEFAULT 'main',
  added_at TEXT NOT NULL,
  last_crawled_at TEXT,
  crawl_status TEXT NOT NULL DEFAULT 'idle',
  crawl_error TEXT,
  crawl_progress TEXT,
  crawl_cursor TEXT,
  UNIQUE (owner, name)
);
CREATE TABLE IF NOT EXISTS pull_requests (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
);
CREATE TABLE IF NOT EXISTS deploy_runs (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (repo_id, run_id)
);
`;

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  deploy_workflows: string;
  deploy_branch: string;
  added_at: string;
  last_crawled_at: string | null;
  crawl_status: Repo["crawlStatus"];
  crawl_error: string | null;
  crawl_progress: string | null;
  crawl_cursor: string | null;
}

const toRepo = (row: RepoRow): Repo => ({
  id: row.id,
  owner: row.owner,
  name: row.name,
  deployWorkflows: JSON.parse(row.deploy_workflows) as string[],
  deployBranch: row.deploy_branch,
  addedAt: row.added_at,
  lastCrawledAt: row.last_crawled_at,
  crawlStatus: row.crawl_status,
  crawlError: row.crawl_error,
  crawlProgress: row.crawl_progress,
});

/** SQLite on Node's built-in `node:sqlite`, so there is no native module to compile. */
export class SqliteRepoStore implements RepoStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // A crawl interrupted by a restart must not stay "crawling" forever.
    this.db.exec("UPDATE repos SET crawl_status = 'idle', crawl_progress = NULL WHERE crawl_status = 'crawling'");
  }

  listRepos(): Repo[] {
    return (this.db.prepare("SELECT * FROM repos ORDER BY id").all() as unknown as RepoRow[]).map(toRepo);
  }

  getRepo(id: number): Repo | null {
    const row = this.db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as unknown as RepoRow | undefined;
    return row ? toRepo(row) : null;
  }

  findRepo(owner: string, name: string): Repo | null {
    const row = this.db
      .prepare("SELECT * FROM repos WHERE lower(owner) = lower(?) AND lower(name) = lower(?)")
      .get(owner, name) as unknown as RepoRow | undefined;
    return row ? toRepo(row) : null;
  }

  addRepo(owner: string, name: string, deployWorkflows: string[], deployBranch: string): Repo {
    const result = this.db
      .prepare("INSERT INTO repos (owner, name, deploy_workflows, deploy_branch, added_at) VALUES (?, ?, ?, ?, ?)")
      .run(owner, name, JSON.stringify(deployWorkflows), deployBranch, new Date().toISOString());
    return this.getRepo(Number(result.lastInsertRowid))!;
  }

  updateRepoConfig(id: number, deployWorkflows: string[], deployBranch: string): void {
    this.db
      .prepare("UPDATE repos SET deploy_workflows = ?, deploy_branch = ? WHERE id = ?")
      .run(JSON.stringify(deployWorkflows), deployBranch, id);
  }

  deleteRepo(id: number): void {
    this.db.prepare("DELETE FROM repos WHERE id = ?").run(id);
  }

  setCrawlState(id: number, status: Repo["crawlStatus"], progress: string | null, error: string | null = null): void {
    this.db
      .prepare("UPDATE repos SET crawl_status = ?, crawl_progress = ?, crawl_error = ? WHERE id = ?")
      .run(status, progress, error, id);
  }

  finishCrawl(id: number, cursor: string | null): void {
    this.db
      .prepare(
        "UPDATE repos SET crawl_status = 'idle', crawl_progress = NULL, crawl_error = NULL, last_crawled_at = ?, crawl_cursor = COALESCE(?, crawl_cursor) WHERE id = ?",
      )
      .run(new Date().toISOString(), cursor, id);
  }

  /** The newest PR updatedAt seen by the last complete crawl; an incremental crawl stops once it reaches it. */
  crawlCursor(id: number): string | null {
    const row = this.db.prepare("SELECT crawl_cursor FROM repos WHERE id = ?").get(id) as
      { crawl_cursor: string | null } | undefined;
    return row?.crawl_cursor ?? null;
  }

  resetCrawlCursor(id: number): void {
    this.db.prepare("UPDATE repos SET crawl_cursor = NULL WHERE id = ?").run(id);
  }

  upsertPullRequests(repoId: number, prs: PullRequest[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO pull_requests (repo_id, number, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (repo_id, number) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    );
    this.db.exec("BEGIN");
    try {
      for (const pr of prs) stmt.run(repoId, pr.number, JSON.stringify(pr), pr.updatedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertDeployRuns(repoId: number, runs: DeployRun[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO deploy_runs (repo_id, run_id, data) VALUES (?, ?, ?) ON CONFLICT (repo_id, run_id) DO UPDATE SET data = excluded.data",
    );
    this.db.exec("BEGIN");
    try {
      for (const run of runs) stmt.run(repoId, run.runId, JSON.stringify(run));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  replaceDeployRuns(repoId: number, runs: DeployRun[]): void {
    this.db.prepare("DELETE FROM deploy_runs WHERE repo_id = ?").run(repoId);
    this.upsertDeployRuns(repoId, runs);
  }

  pullRequests(repoId: number): PullRequest[] {
    const rows = this.db.prepare("SELECT data FROM pull_requests WHERE repo_id = ?").all(repoId) as unknown as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as PullRequest);
  }

  deployRuns(repoId: number): DeployRun[] {
    const rows = this.db.prepare("SELECT data FROM deploy_runs WHERE repo_id = ?").all(repoId) as unknown as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as DeployRun);
  }

  counts(repoId: number): RepoCounts {
    const pr = this.db.prepare("SELECT count(*) AS n FROM pull_requests WHERE repo_id = ?").get(repoId) as { n: number };
    const dr = this.db.prepare("SELECT count(*) AS n FROM deploy_runs WHERE repo_id = ?").get(repoId) as { n: number };
    return { pullRequests: pr.n, deployRuns: dr.n };
  }
}
