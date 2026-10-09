import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BoardAccess,
  BoardColumn,
  CodeSnapshot,
  CrawlStatus,
  DeployRun,
  IssueLabelRules,
  PullRequest,
  Repo,
  RepoIssue,
  TrackerSpace,
  TrackerStatus,
  WorkItem,
} from "@dora-dashboard/core";
import type { Logger } from "../../interfaces/logger.js";
import { noopLogger } from "../../interfaces/logger.js";
import { ISSUE_LABEL_KINDS, ISSUE_PRIORITIES } from "@dora-dashboard/core";
import type { IssueState, RepoCounts, RepoStore } from "../../interfaces/repo-store.js";

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
  issues_enabled INTEGER,
  issue_cursor TEXT,
  issue_labels TEXT,
  issue_error TEXT,
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
CREATE TABLE IF NOT EXISTS issues (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_repo_updated ON issues (repo_id, updated_at DESC, number);
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
  board TEXT,
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
  /** Null until a crawl has read the board. */
  board: BoardAccess | null;
  last_crawled_at: string | null;
  crawl_status: CrawlStatus;
  crawl_error: string | null;
  crawl_progress: string | null;
  people: string | null;
}

const toSpace = (row: SpaceRow, log: Logger): TrackerSpace => ({
  id: row.id,
  siteId: row.site_id,
  siteUrl: row.site_url,
  key: row.space_key,
  name: row.name,
  statuses: JSON.parse(row.statuses) as TrackerStatus[],
  columns: JSON.parse(row.columns) as BoardColumn[],
  board: row.board,
  lastCrawledAt: row.last_crawled_at,
  crawlStatus: row.crawl_status,
  crawlError: row.crawl_error,
  crawlProgress: row.crawl_progress,
  // Left off, not set to an empty map, when none were recorded or they cannot be read.
  ...withPeople(peopleOf(row.people, row.id, log)),
});

const withPeople = (people: Record<string, string> | undefined): { people?: Record<string, string> } =>
  people === undefined ? {} : { people };

/**
 * Saved names as a map, or nothing when none were saved or what was saved cannot be read; names are never worth a
 * failed read. Unreadable names read back as a space whose names were never recorded, so its assigned items show as
 * "Assigned, name not recorded" rather than a space with names recorded, and the next full crawl restores them. The
 * space id is logged so the unreadable row can be found. Only string names are kept.
 */
function peopleOf(saved: string | null, spaceId: number, log: Logger): Record<string, string> | undefined {
  if (saved === null) return undefined;
  let people: unknown;
  try {
    people = JSON.parse(saved);
  } catch (err) {
    log.warn({ err, spaceId }, "saved assignee names are not readable JSON; ignoring them");
    return undefined;
  }
  if (typeof people !== "object" || people === null || Array.isArray(people)) {
    log.warn({ spaceId }, "saved assignee names are not a map; ignoring them");
    return undefined;
  }
  const names = Object.entries(people).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(names);
}

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  deploy_workflows: string;
  deploy_branch: string;
  added_at: string;
  last_crawled_at: string | null;
  crawl_status: CrawlStatus;
  crawl_error: string | null;
  crawl_progress: string | null;
  crawl_cursor: string | null;
  issues_enabled: number | null;
  issue_cursor: string | null;
  issue_labels: string | null;
  issue_error: string | null;
}

const LABEL_KINDS: ReadonlySet<string> = new Set(ISSUE_LABEL_KINDS);
const LABEL_PRIORITIES: ReadonlySet<string> = new Set(ISSUE_PRIORITIES);

/** True for an object whose keys are all in `known` and whose values are all arrays of strings. */
function isRuleGroup(value: unknown, known: ReadonlySet<string>): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, names]) => known.has(key) && Array.isArray(names) && names.every((name) => typeof name === "string"),
  );
}

/**
 * A saved label override. `rules` is null when none was saved or what was saved cannot be used; an override is never
 * worth a failed read, and a wrong shape would make every report throw, so unusable rules read back as the defaults
 * with `unreadable` set, which lets the person be told. The repository id is logged so the row can be found, once per
 * repository in `warned`, because the list is polled.
 */
function labelsOf(
  saved: string | null,
  repoId: number,
  log: Logger,
  warned: Set<number>,
): { rules: IssueLabelRules | null; unreadable: boolean } {
  if (saved === null) return { rules: null, unreadable: false };
  const refuse = (context: Record<string, unknown>, message: string) => {
    if (!warned.has(repoId)) {
      warned.add(repoId);
      log.warn({ ...context, repoId }, message);
    }
    return { rules: null, unreadable: true };
  };
  let rules: unknown;
  try {
    rules = JSON.parse(saved);
  } catch (err) {
    return refuse({ err }, "saved issue labels are not readable JSON; using the defaults");
  }
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
    return refuse({}, "saved issue labels are not an object; using the defaults");
  }
  const { kinds, priorities, ...rest } = rules as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !isRuleGroup(kinds, LABEL_KINDS) || !isRuleGroup(priorities, LABEL_PRIORITIES)) {
    return refuse({}, "saved issue labels do not have the expected shape; using the defaults");
  }
  return { rules: rules as IssueLabelRules, unreadable: false };
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

/**
 * SQLite on Node's built-in `node:sqlite`, so there is no native module to compile. `now` stamps every time the store
 * records itself (`added_at`, `last_crawled_at`), so a test can pin them.
 */
export class SqliteRepoStore implements RepoStore {
  private db: DatabaseSync;
  /** Repositories whose unusable saved labels were already reported, so a polled list does not repeat it. */
  private readonly warnedLabels = new Set<number>();

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date(),
    private readonly log: Logger = noopLogger,
  ) {
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

  private readonly toSpace = (row: SpaceRow): TrackerSpace => toSpace(row, this.log);

  /**
   * Brings a database made by an earlier version up to date. `CREATE TABLE IF NOT EXISTS` leaves an existing table
   * as it was, so a column added later has to be added here. Each step checks first, so running it twice is safe.
   */
  private migrate(): void {
    const repoColumns = this.db.prepare("PRAGMA table_info(repos)").all() as unknown as { name: string }[];
    // Issues read from the code host (ADR 0028): whether they are switched on, where the next read resumes, the
    // label override and why the last read failed. Null means no issue read has recorded them yet.
    for (const [column, type] of [
      ["issues_enabled", "INTEGER"],
      ["issue_cursor", "TEXT"],
      ["issue_labels", "TEXT"],
      ["issue_error", "TEXT"],
    ] as const) {
      if (!repoColumns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE repos ADD COLUMN ${column} ${type}`);
    }
    const columns = this.db.prepare("PRAGMA table_info(tracker_spaces)").all() as unknown as { name: string; notnull: number }[];
    // Assignee display names, recorded on a crawl (ADR 0021). Null means no crawl has recorded them yet.
    if (!columns.some((c) => c.name === "people")) this.db.exec("ALTER TABLE tracker_spaces ADD COLUMN people TEXT");
    // How the board was read; null means not read yet. An earlier build of this column was NOT NULL and defaulted to
    // 'none', which said "no board" of spaces never read. That column is set aside, its `read` and `forbidden` kept
    // (a `none` may only be the default), and dropped once copied. Existing rows become `read` when they hold columns,
    // `none` when a crawl has finished with none, and otherwise stay null. All in one transaction, so a failure
    // part-way leaves the table as it was; a second run finds a nullable column and does nothing.
    const board = columns.find((c) => c.name === "board");
    if (board === undefined || board.notnull === 1) {
      const earlier = board === undefined ? "NULL" : "board_earlier";
      this.db.exec("BEGIN");
      try {
        if (board !== undefined) this.db.exec("ALTER TABLE tracker_spaces RENAME COLUMN board TO board_earlier");
        this.db.exec("ALTER TABLE tracker_spaces ADD COLUMN board TEXT");
        this.db.exec(
          `UPDATE tracker_spaces SET board = CASE
             WHEN columns <> '[]' THEN 'read'
             WHEN ${earlier} = 'forbidden' THEN 'forbidden'
             WHEN last_crawled_at IS NOT NULL THEN 'none'
             ELSE NULL END`,
        );
        if (board !== undefined) this.db.exec("ALTER TABLE tracker_spaces DROP COLUMN board_earlier");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
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
      .run(owner, name, JSON.stringify(deployWorkflows), deployBranch, this.now().toISOString());
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

  setCrawlState(id: number, status: CrawlStatus, progress: string | null, error: string | null = null): void {
    this.db
      .prepare("UPDATE repos SET crawl_status = ?, crawl_progress = ?, crawl_error = ? WHERE id = ?")
      .run(status, progress, error, id);
  }

  finishCrawl(id: number, cursor: string | null): void {
    this.db
      .prepare(
        "UPDATE repos SET crawl_status = 'idle', crawl_progress = NULL, crawl_error = NULL, last_crawled_at = ?, crawl_cursor = COALESCE(?, crawl_cursor) WHERE id = ?",
      )
      .run(this.now().toISOString(), cursor, id);
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
    const issues = this.db.prepare("SELECT count(*) AS n FROM issues WHERE repo_id = ?").get(repoId) as { n: number };
    return { pullRequests: pr.n, deployRuns: dr.n, issues: issues.n };
  }

  upsertIssues(repoId: number, issues: RepoIssue[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO issues (repo_id, number, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT (repo_id, number) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    );
    this.db.exec("BEGIN");
    try {
      for (const issue of issues) stmt.run(repoId, issue.number, issue.updatedAt, JSON.stringify(issue));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  removeIssuesExcept(repoId: number, keep: ReadonlySet<number>): number {
    const held = this.db.prepare("SELECT number FROM issues WHERE repo_id = ?").all(repoId) as unknown as { number: number }[];
    const gone = held.filter((row) => !keep.has(row.number));
    const stmt = this.db.prepare("DELETE FROM issues WHERE repo_id = ? AND number = ?");
    this.db.exec("BEGIN");
    try {
      for (const row of gone) stmt.run(repoId, row.number);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return gone.length;
  }

  issues(repoId: number): RepoIssue[] {
    const rows = this.db
      .prepare("SELECT number, data FROM issues WHERE repo_id = ? ORDER BY updated_at DESC, number ASC")
      .all(repoId) as unknown as { number: number; data: string }[];
    return rows.map((r) => {
      let issue: RepoIssue;
      try {
        issue = JSON.parse(r.data) as RepoIssue;
      } catch (err) {
        throw new Error(`Stored issue #${r.number} of repository ${repoId} is not readable`, { cause: err });
      }
      // A closed row stored by an earlier build may lack its close time, which would drop it from every figure. It
      // takes its last update instead, as the adapter does for a closed issue GitHub sent without one.
      return issue.state === "closed" && !issue.closedAt ? { ...issue, closedAt: issue.updatedAt } : issue;
    });
  }

  issueState(repoId: number): IssueState {
    const row = this.db
      .prepare("SELECT issues_enabled, issue_cursor, issue_labels, issue_error FROM repos WHERE id = ?")
      .get(repoId) as unknown as Pick<RepoRow, "issues_enabled" | "issue_cursor" | "issue_labels" | "issue_error"> | undefined;
    const { rules, unreadable } = labelsOf(row?.issue_labels ?? null, repoId, this.log, this.warnedLabels);
    return {
      enabled: row?.issues_enabled == null ? null : row.issues_enabled === 1,
      cursor: row?.issue_cursor ?? null,
      labels: rules,
      labelsUnreadable: unreadable,
      error: row?.issue_error ?? null,
    };
  }

  finishIssueCrawl(repoId: number, cursor: string | null): void {
    this.db
      .prepare("UPDATE repos SET issues_enabled = 1, issue_error = NULL, issue_cursor = COALESCE(?, issue_cursor) WHERE id = ?")
      .run(cursor, repoId);
  }

  disableIssues(repoId: number): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM issues WHERE repo_id = ?").run(repoId);
      this.db.prepare("UPDATE repos SET issues_enabled = 0, issue_cursor = NULL, issue_error = NULL WHERE id = ?").run(repoId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  failIssueCrawl(repoId: number, message: string): void {
    this.db.prepare("UPDATE repos SET issue_error = ? WHERE id = ?").run(message, repoId);
  }

  setIssueLabels(repoId: number, rules: IssueLabelRules | null): void {
    this.warnedLabels.delete(repoId);
    this.db.prepare("UPDATE repos SET issue_labels = ? WHERE id = ?").run(rules === null ? null : JSON.stringify(rules), repoId);
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

  linkSpaces(repoId: number, site: { id: string; url: string }, spaces: { key: string; name: string }[]): TrackerSpace[] {
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
        .run(repoId, site.id);
      for (const space of spaces) {
        const row = upsert.get(site.id, site.url, space.key, space.name) as unknown as { id: number };
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
    return rows.map(this.toSpace);
  }

  listSpaces(): TrackerSpace[] {
    const rows = this.db.prepare("SELECT * FROM tracker_spaces ORDER BY site_id, space_key").all() as unknown as SpaceRow[];
    return rows.map(this.toSpace);
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
    return row ? this.toSpace(row) : null;
  }

  setSpaceDetails(id: number, statuses: TrackerStatus[], columns: BoardColumn[], board: BoardAccess): void {
    this.db
      .prepare("UPDATE tracker_spaces SET statuses = ?, columns = ?, board = ? WHERE id = ?")
      .run(JSON.stringify(statuses), JSON.stringify(columns), board, id);
  }

  setSpaceCrawlState(id: number, status: CrawlStatus, progress: string | null, error: string | null = null): void {
    this.db
      .prepare("UPDATE tracker_spaces SET crawl_status = ?, crawl_progress = ?, crawl_error = ? WHERE id = ?")
      .run(status, progress, error, id);
  }

  finishSpaceCrawl(id: number, cursor: string | null): void {
    this.db
      .prepare(
        "UPDATE tracker_spaces SET crawl_status = 'idle', crawl_progress = NULL, crawl_error = NULL, last_crawled_at = ?, crawl_cursor = COALESCE(?, crawl_cursor) WHERE id = ?",
      )
      .run(this.now().toISOString(), cursor, id);
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
