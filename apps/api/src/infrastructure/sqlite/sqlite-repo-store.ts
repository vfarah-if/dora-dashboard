import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import type { RepoCounts, RepoStore, SpaceLink } from "../../interfaces/repo-store.js";

const SNAPSHOTS_KEPT = 10;

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
CREATE TABLE IF NOT EXISTS code_snapshots (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  analysed_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (repo_id, analysed_at)
);
CREATE TABLE IF NOT EXISTS tracker_spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  site_url TEXT NOT NULL,
  space_key TEXT NOT NULL,
  name TEXT NOT NULL,
  statuses TEXT NOT NULL DEFAULT '[]',
  columns TEXT NOT NULL DEFAULT '[]',
  last_crawled_at TEXT,
  crawl_status TEXT NOT NULL DEFAULT 'idle',
  crawl_error TEXT,
  crawl_progress TEXT,
  crawl_cursor TEXT,
  people TEXT,
  UNIQUE (site_id, space_key)
);
CREATE TABLE IF NOT EXISTS repo_spaces (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  space_id INTEGER NOT NULL REFERENCES tracker_spaces(id) ON DELETE CASCADE,
  PRIMARY KEY (repo_id, space_id)
);
CREATE TABLE IF NOT EXISTS work_items (
  space_id INTEGER NOT NULL REFERENCES tracker_spaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (space_id, key)
);
`;

interface SpaceRow {
  id: number;
  site_id: string;
  site_url: string;
  space_key: string;
  name: string;
  statuses: string;
  columns: string;
  last_crawled_at: string | null;
  crawl_status: TrackerSpace["crawlStatus"];
  crawl_error: string | null;
  crawl_progress: string | null;
  people: string | null;
}

const toSpace = (row: SpaceRow): TrackerSpace => ({
  id: row.id,
  siteId: row.site_id,
  siteUrl: row.site_url,
  key: row.space_key,
  name: row.name,
  statuses: JSON.parse(row.statuses) as TrackerStatus[],
  columns: JSON.parse(row.columns) as BoardColumn[],
  lastCrawledAt: row.last_crawled_at,
  crawlStatus: row.crawl_status,
  crawlError: row.crawl_error,
  crawlProgress: row.crawl_progress,
  // Null until a crawl has recorded names; the key is then left off rather than set to an empty map.
  ...peopleOf(row.people),
});

/** Saved names as a map, or nothing when none were saved or what was saved cannot be read; names are never worth a failed read. */
function peopleOf(saved: string | null): { people?: Record<string, string> } {
  if (saved === null) return {};
  try {
    const people: unknown = JSON.parse(saved);
    return typeof people === "object" && people !== null && !Array.isArray(people)
      ? { people: people as Record<string, string> }
      : {};
  } catch {
    return {};
  }
}

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

const RESTARTED_DURING_CRAWL = "The API restarted during this crawl. Crawl again.";

/** SQLite on Node's built-in `node:sqlite`, so there is no native module to compile. */
export class SqliteRepoStore implements RepoStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
    // A crawl interrupted by a restart must not stay "crawling" forever.
    this.db.exec("UPDATE repos SET crawl_status = 'idle', crawl_progress = NULL WHERE crawl_status = 'crawling'");
    // A space is told so, because a full crawl cut short never got to prune what the tracker no longer holds.
    this.db
      .prepare(
        "UPDATE tracker_spaces SET crawl_status = 'failed', crawl_progress = NULL, crawl_error = ? WHERE crawl_status = 'crawling'",
      )
      .run(RESTARTED_DURING_CRAWL);
  }

  /**
   * Brings a database made by an earlier version up to date. `CREATE TABLE IF NOT EXISTS` leaves an existing table
   * as it was, so a column added later has to be added here. Each step checks first, so running it twice is safe.
   */
  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(tracker_spaces)").all() as unknown as { name: string }[];
    // Assignee display names, recorded on a crawl (ADR 0021). Null means no crawl has recorded them yet.
    if (!columns.some((c) => c.name === "people")) this.db.exec("ALTER TABLE tracker_spaces ADD COLUMN people TEXT");
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
    this.pruneSpaces();
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

  saveCodeSnapshot(repoId: number, snapshot: CodeSnapshot): void {
    this.db
      .prepare("INSERT OR REPLACE INTO code_snapshots (repo_id, commit_sha, analysed_at, data) VALUES (?, ?, ?, ?)")
      .run(repoId, snapshot.commitSha, snapshot.analysedAt, JSON.stringify(snapshot));
    // Keep the newest few, and always the newest good one so a run of failures cannot erase the last real figures.
    this.db
      .prepare(
        `DELETE FROM code_snapshots WHERE repo_id = ?
           AND analysed_at NOT IN (SELECT analysed_at FROM code_snapshots WHERE repo_id = ? ORDER BY analysed_at DESC LIMIT ${SNAPSHOTS_KEPT})
           AND analysed_at NOT IN (SELECT analysed_at FROM code_snapshots WHERE repo_id = ? AND json_extract(data, '$.error') IS NULL ORDER BY analysed_at DESC LIMIT 1)`,
      )
      .run(repoId, repoId, repoId);
  }

  latestCodeSnapshot(repoId: number): CodeSnapshot | null {
    return this.snapshotWhere(repoId, "");
  }

  latestSuccessfulCodeSnapshot(repoId: number): CodeSnapshot | null {
    return this.snapshotWhere(repoId, "AND json_extract(data, '$.error') IS NULL");
  }

  private snapshotWhere(repoId: number, condition: string): CodeSnapshot | null {
    const row = this.db
      .prepare(`SELECT data FROM code_snapshots WHERE repo_id = ? ${condition} ORDER BY analysed_at DESC LIMIT 1`)
      .get(repoId) as unknown as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as CodeSnapshot) : null;
  }

  /** Spaces no repository links to any more are dropped, with their work items, so no unreachable data lingers. */
  private pruneSpaces(): void {
    this.db.exec("DELETE FROM tracker_spaces WHERE id NOT IN (SELECT space_id FROM repo_spaces)");
  }

  linkSpaces(repoId: number, siteId: string, spaces: SpaceLink[]): TrackerSpace[] {
    const upsert = this.db.prepare(
      `INSERT INTO tracker_spaces (site_id, site_url, space_key, name) VALUES (?, ?, ?, ?)
       ON CONFLICT (site_id, space_key) DO UPDATE SET site_url = excluded.site_url, name = excluded.name
       RETURNING id`,
    );
    const link = this.db.prepare("INSERT OR IGNORE INTO repo_spaces (repo_id, space_id) VALUES (?, ?)");
    const ids: number[] = [];
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM repo_spaces WHERE repo_id = ? AND space_id IN (SELECT id FROM tracker_spaces WHERE site_id = ?)")
        .run(repoId, siteId);
      for (const space of spaces) {
        const row = upsert.get(space.siteId, space.siteUrl, space.key, space.name) as unknown as { id: number };
        link.run(repoId, row.id);
        ids.push(row.id);
      }
      this.pruneSpaces();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return [...new Set(ids)].map((id) => this.getSpace(id)!);
  }

  spacesFor(repoId: number): TrackerSpace[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM tracker_spaces s JOIN repo_spaces r ON r.space_id = s.id
         WHERE r.repo_id = ? ORDER BY s.site_id, s.space_key`,
      )
      .all(repoId) as unknown as SpaceRow[];
    return rows.map(toSpace);
  }

  listSpaces(): TrackerSpace[] {
    const rows = this.db.prepare("SELECT * FROM tracker_spaces ORDER BY site_id, space_key").all() as unknown as SpaceRow[];
    return rows.map(toSpace);
  }

  reposForSpace(spaceId: number): Repo[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM repos r JOIN repo_spaces l ON l.repo_id = r.id
         WHERE l.space_id = ? ORDER BY r.owner, r.name`,
      )
      .all(spaceId) as unknown as RepoRow[];
    return rows.map(toRepo);
  }

  setSpacePeople(id: number, people: Record<string, string>): void {
    this.db.prepare("UPDATE tracker_spaces SET people = ? WHERE id = ?").run(JSON.stringify(people), id);
  }

  getSpace(id: number): TrackerSpace | null {
    const row = this.db.prepare("SELECT * FROM tracker_spaces WHERE id = ?").get(id) as unknown as SpaceRow | undefined;
    return row ? toSpace(row) : null;
  }

  setSpaceDetails(id: number, statuses: TrackerStatus[], columns: BoardColumn[]): void {
    this.db
      .prepare("UPDATE tracker_spaces SET statuses = ?, columns = ? WHERE id = ?")
      .run(JSON.stringify(statuses), JSON.stringify(columns), id);
  }

  setSpaceCrawlState(
    id: number,
    status: TrackerSpace["crawlStatus"],
    progress: string | null,
    error: string | null = null,
  ): void {
    this.db
      .prepare("UPDATE tracker_spaces SET crawl_status = ?, crawl_progress = ?, crawl_error = ? WHERE id = ?")
      .run(status, progress, error, id);
  }

  finishSpaceCrawl(id: number, cursor: string | null): void {
    this.db
      .prepare(
        "UPDATE tracker_spaces SET crawl_status = 'idle', crawl_progress = NULL, crawl_error = NULL, last_crawled_at = ?, crawl_cursor = COALESCE(?, crawl_cursor) WHERE id = ?",
      )
      .run(new Date().toISOString(), cursor, id);
  }

  spaceCrawlCursor(id: number): string | null {
    const row = this.db.prepare("SELECT crawl_cursor FROM tracker_spaces WHERE id = ?").get(id) as
      { crawl_cursor: string | null } | undefined;
    return row?.crawl_cursor ?? null;
  }

  resetSpaceCrawlCursor(id: number): void {
    this.db.prepare("UPDATE tracker_spaces SET crawl_cursor = NULL WHERE id = ?").run(id);
  }

  upsertWorkItems(spaceId: number, items: WorkItem[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO work_items (space_id, key, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT (space_id, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    );
    this.db.exec("BEGIN");
    try {
      for (const item of items) stmt.run(spaceId, item.key, item.updatedAt, JSON.stringify(item));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeWorkItemsExcept(spaceId: number, keep: ReadonlySet<string>): number {
    const held = this.db.prepare("SELECT key FROM work_items WHERE space_id = ?").all(spaceId) as unknown as { key: string }[];
    const gone = held.filter((row) => !keep.has(row.key));
    const stmt = this.db.prepare("DELETE FROM work_items WHERE space_id = ? AND key = ?");
    this.db.exec("BEGIN");
    try {
      for (const row of gone) stmt.run(spaceId, row.key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return gone.length;
  }

  workItems(spaceId: number): WorkItem[] {
    const rows = this.db.prepare("SELECT data FROM work_items WHERE space_id = ?").all(spaceId) as unknown as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as WorkItem);
  }

  workItemCount(spaceId: number): number {
    const row = this.db.prepare("SELECT count(*) AS n FROM work_items WHERE space_id = ?").get(spaceId) as { n: number };
    return row.n;
  }
}
