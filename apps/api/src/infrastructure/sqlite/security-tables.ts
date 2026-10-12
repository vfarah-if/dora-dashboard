import type { DatabaseSync } from "node:sqlite";
import {
  ALERT_SOURCES,
  type AlertSource,
  type LockedPackage,
  type RepoPosture,
  type ScorecardResult,
  type SecurityAlert,
  type SourceState,
  type SupplyChainFacts,
  type SupplyChainRecord,
} from "@dora-dashboard/core";
import type { Logger } from "../../interfaces/logger.js";
import { noopLogger } from "../../interfaces/logger.js";
import type { SecurityKeys, SecurityStore, StoredScorecard } from "../../interfaces/security-store.js";

/** The scorecard table. Phase one of the feature had `read_at TEXT NOT NULL` and no `error` column. */
const scorecardTable = (name: string) => `CREATE TABLE ${name} (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  read_at TEXT,
  data TEXT,
  error TEXT
)`;

/**
 * The posture table. Phase one had `read_at` and `data` as NOT NULL and no failure columns; a failed first read has
 * neither a read time nor a posture, so both are nullable now.
 */
const postureTable = (name: string) => `CREATE TABLE ${name} (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  read_at TEXT,
  data TEXT,
  error TEXT,
  attempted_at TEXT
)`;

/**
 * The tables behind the security report (ADR 0031 to ADR 0035). Every one is removed with its repository. Alerts hold
 * their whole mapped record as JSON beside the columns the store filters on, so a change to what an alert carries needs
 * no migration. `CREATE TABLE IF NOT EXISTS` adds a missing table but leaves an existing one as it was, so a column
 * added or loosened later is brought in by `migrateSecurityTables`, which the store runs on every open.
 */
export const SECURITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS security_alerts (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (repo_id, source, key)
);
CREATE TABLE IF NOT EXISTS security_sources (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  read_at TEXT,
  attempted_at TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (repo_id, source)
);
CREATE TABLE IF NOT EXISTS supply_chain (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  read_at TEXT NOT NULL,
  version INTEGER NOT NULL,
  facts TEXT NOT NULL,
  packages TEXT NOT NULL
);
${postureTable("IF NOT EXISTS security_posture")};
${scorecardTable("IF NOT EXISTS security_scorecard")};
`;

/**
 * Brings the security tables of a database made by an earlier build up to date, safely to run on every open.
 *
 * - The scorecard table gained an `error` column and `read_at` became nullable (a failed first read has no read time).
 * - The posture table gained `error` and `attempted_at`, and `read_at` and `data` became nullable.
 *
 * SQLite cannot loosen a constraint in place, so each table is rebuilt in one transaction, which leaves it as it was if
 * anything fails; a second run finds the new shape and does nothing. No other security table has changed.
 */
export function migrateSecurityTables(db: DatabaseSync): void {
  const columnsOf = (table: string) =>
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string; notnull: number }[];
  const scorecard = columnsOf("security_scorecard");
  const posture = columnsOf("security_posture");
  const scorecardCurrent =
    scorecard.some((c) => c.name === "error") && scorecard.find((c) => c.name === "read_at")?.notnull === 0;
  const postureCurrent = posture.some((c) => c.name === "error") && posture.find((c) => c.name === "read_at")?.notnull === 0;
  if (scorecardCurrent && postureCurrent) return;
  db.exec("BEGIN");
  try {
    if (!scorecardCurrent) rebuild(db, "security_scorecard", scorecardTable, "repo_id, read_at, data");
    if (!postureCurrent) rebuild(db, "security_posture", postureTable, "repo_id, read_at, data");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Recreates `table` with the current definition and copies `columns` across from the old one. */
function rebuild(db: DatabaseSync, table: string, definition: (name: string) => string, columns: string): void {
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_earlier`);
  db.exec(definition(table));
  db.exec(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table}_earlier`);
  db.exec(`DROP TABLE ${table}_earlier`);
}

interface SourceRow {
  source: AlertSource;
  status: SourceState["status"];
  reason: SourceState["reason"];
  read_at: string | null;
  attempted_at: string | null;
  truncated: number;
  error: string | null;
}

const notRead = (): SourceState => ({
  status: "not_read",
  reason: null,
  readAt: null,
  attemptedAt: null,
  truncated: false,
  error: null,
});

function parse<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`Stored ${what} is not readable`, { cause });
  }
}

/** The `SecurityStore` over an open database, which `SqliteRepoStore` hands its own connection. */
export class SecurityTables implements SecurityStore {
  /** Alerts already reported as unreadable, so a polled report does not repeat the warning. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly log: Logger = noopLogger,
  ) {}

  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveSecurityAlerts(repoId: number, source: AlertSource, alerts: readonly SecurityAlert[], complete: boolean): void {
    const upsert = this.db.prepare(
      "INSERT INTO security_alerts (repo_id, source, key, state, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT (repo_id, source, key) DO UPDATE SET state = excluded.state, data = excluded.data",
    );
    this.transaction(() => {
      for (const alert of alerts) {
        // An alert filed under another source would be pruned or kept by the wrong read.
        if (alert.source !== source) throw new Error(`A ${alert.source} alert cannot be saved as ${source}`);
        upsert.run(repoId, source, alert.key, alert.state, JSON.stringify(alert));
      }
      if (!complete) return;
      const keep = new Set(alerts.map((alert) => alert.key));
      const held = this.db
        .prepare("SELECT key FROM security_alerts WHERE repo_id = ? AND source = ?")
        .all(repoId, source) as unknown as {
        key: string;
      }[];
      const remove = this.db.prepare("DELETE FROM security_alerts WHERE repo_id = ? AND source = ? AND key = ?");
      for (const row of held) if (!keep.has(row.key)) remove.run(repoId, source, row.key);
    });
  }

  clearSecurityAlerts(repoId: number, source: AlertSource): void {
    this.db.prepare("DELETE FROM security_alerts WHERE repo_id = ? AND source = ?").run(repoId, source);
  }

  securityAlerts(repoId: number): SecurityAlert[] {
    const rows = this.db
      .prepare("SELECT source, key, data FROM security_alerts WHERE repo_id = ? ORDER BY source, key")
      .all(repoId) as unknown as { source: string; key: string; data: string }[];
    // One corrupt row costs that alert only; it must not turn every report of the repository into a 500.
    return rows.flatMap((row) => {
      try {
        return [parse<SecurityAlert>(row.data, `${row.source} alert ${row.key} of repository ${repoId}`)];
      } catch (err) {
        const id = `${repoId}:${row.source}:${row.key}`;
        if (!this.warned.has(id)) {
          this.warned.add(id);
          this.log.warn({ err, repoId, source: row.source }, "a stored security alert is not readable; leaving it out");
        }
        return [];
      }
    });
  }

  setSourceState(repoId: number, source: AlertSource, state: SourceState): void {
    this.db
      .prepare(
        `INSERT INTO security_sources (repo_id, source, status, reason, read_at, attempted_at, truncated, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, source) DO UPDATE SET status = excluded.status, reason = excluded.reason,
           read_at = excluded.read_at, attempted_at = excluded.attempted_at, truncated = excluded.truncated, error = excluded.error`,
      )
      .run(repoId, source, state.status, state.reason, state.readAt, state.attemptedAt, state.truncated ? 1 : 0, state.error);
  }

  sourceStates(repoId: number): Record<AlertSource, SourceState> {
    const states = Object.fromEntries(ALERT_SOURCES.map((source) => [source, notRead()])) as Record<AlertSource, SourceState>;
    const rows = this.db.prepare("SELECT * FROM security_sources WHERE repo_id = ?").all(repoId) as unknown as SourceRow[];
    for (const row of rows) {
      if (!ALERT_SOURCES.includes(row.source)) continue;
      states[row.source] = {
        status: row.status,
        reason: row.reason,
        readAt: row.read_at,
        attemptedAt: row.attempted_at,
        truncated: row.truncated === 1,
        error: row.error,
      };
    }
    return states;
  }

  saveSupplyChain(repoId: number, record: SupplyChainRecord, packages: readonly LockedPackage[]): void {
    this.db
      .prepare(
        `INSERT INTO supply_chain (repo_id, commit_sha, read_at, version, facts, packages) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET commit_sha = excluded.commit_sha, read_at = excluded.read_at,
           version = excluded.version, facts = excluded.facts, packages = excluded.packages`,
      )
      .run(repoId, record.commitSha, record.readAt, record.facts.version, JSON.stringify(record.facts), JSON.stringify(packages));
  }

  /** Never selects `packages`, which can run to tens of thousands of entries and is wanted only by the OSV lookup. */
  supplyChain(repoId: number): SupplyChainRecord | null {
    const row = this.db
      .prepare("SELECT commit_sha, read_at, facts FROM supply_chain WHERE repo_id = ?")
      .get(repoId) as unknown as { commit_sha: string; read_at: string; facts: string } | undefined;
    if (!row) return null;
    return {
      commitSha: row.commit_sha,
      readAt: row.read_at,
      facts: parse<SupplyChainFacts>(row.facts, `supply chain facts of repository ${repoId}`),
    };
  }

  lockedPackages(repoId: number): LockedPackage[] {
    const row = this.db.prepare("SELECT packages FROM supply_chain WHERE repo_id = ?").get(repoId) as unknown as
      { packages: string } | undefined;
    return row ? parse<LockedPackage[]>(row.packages, `locked packages of repository ${repoId}`) : [];
  }

  /** A good read, which also clears any earlier failure. */
  savePosture(repoId: number, posture: RepoPosture, readAt: string): void {
    this.db
      .prepare(
        `INSERT INTO security_posture (repo_id, read_at, data, error, attempted_at) VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT (repo_id) DO UPDATE SET read_at = excluded.read_at, data = excluded.data, error = NULL, attempted_at = excluded.attempted_at`,
      )
      .run(repoId, readAt, JSON.stringify(posture), readAt);
  }

  /** Records a failed read and keeps the last good posture and its read time. */
  failPosture(repoId: number, error: string, attemptedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO security_posture (repo_id, read_at, data, error, attempted_at) VALUES (?, NULL, NULL, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET error = excluded.error, attempted_at = excluded.attempted_at`,
      )
      .run(repoId, error, attemptedAt);
  }

  posture(repoId: number): { posture: RepoPosture; readAt: string } | null {
    const row = this.db.prepare("SELECT read_at, data FROM security_posture WHERE repo_id = ?").get(repoId) as unknown as
      { read_at: string | null; data: string | null } | undefined;
    return row?.read_at && row.data
      ? { readAt: row.read_at, posture: parse<RepoPosture>(row.data, `posture of repository ${repoId}`) }
      : null;
  }

  postureFailure(repoId: number): { error: string; attemptedAt: string | null } | null {
    const row = this.db.prepare("SELECT error, attempted_at FROM security_posture WHERE repo_id = ?").get(repoId) as unknown as
      { error: string | null; attempted_at: string | null } | undefined;
    return row?.error ? { error: row.error, attemptedAt: row.attempted_at } : null;
  }

  /** A good read, which also clears any earlier failure. */
  saveScorecard(repoId: number, readAt: string, result: ScorecardResult | null): void {
    this.db
      .prepare(
        `INSERT INTO security_scorecard (repo_id, read_at, data, error) VALUES (?, ?, ?, NULL)
         ON CONFLICT (repo_id) DO UPDATE SET read_at = excluded.read_at, data = excluded.data, error = NULL`,
      )
      .run(repoId, readAt, result === null ? null : JSON.stringify(result));
  }

  /** Records a failed read and keeps the last good result and its read time, so the daily throttle is unaffected. */
  failScorecard(repoId: number, error: string): void {
    this.db
      .prepare(
        "INSERT INTO security_scorecard (repo_id, read_at, data, error) VALUES (?, NULL, NULL, ?) ON CONFLICT (repo_id) DO UPDATE SET error = excluded.error",
      )
      .run(repoId, error);
  }

  scorecard(repoId: number): StoredScorecard | null {
    const row = this.db
      .prepare("SELECT read_at, data, error FROM security_scorecard WHERE repo_id = ?")
      .get(repoId) as unknown as { read_at: string | null; data: string | null; error: string | null } | undefined;
    if (!row) return null;
    return {
      readAt: row.read_at,
      result: row.data === null ? null : parse<ScorecardResult>(row.data, `scorecard of repository ${repoId}`),
      error: row.error,
    };
  }

  securityKeys(repoId: number): SecurityKeys {
    const rows = this.db
      .prepare("SELECT source, attempted_at, read_at FROM security_sources WHERE repo_id = ? ORDER BY source")
      .all(repoId) as unknown as { source: string; attempted_at: string | null; read_at: string | null }[];
    const readAt = (table: "supply_chain" | "security_posture"): string | null => {
      const row = this.db.prepare(`SELECT read_at FROM ${table} WHERE repo_id = ?`).get(repoId) as unknown as
        { read_at: string | null } | undefined;
      return row?.read_at ?? null;
    };
    const failure = this.db
      .prepare("SELECT attempted_at, error FROM security_posture WHERE repo_id = ?")
      .get(repoId) as unknown as { attempted_at: string | null; error: string | null } | undefined;
    const scorecard = this.db
      .prepare("SELECT read_at, error FROM security_scorecard WHERE repo_id = ?")
      .get(repoId) as unknown as { read_at: string | null; error: string | null } | undefined;
    return {
      sources: rows.map((row) => `${row.source}:${row.attempted_at ?? ""}:${row.read_at ?? ""}`).join("|"),
      supplyChain: readAt("supply_chain"),
      // A failure changes the key too, so a report built before it is not served after.
      posture: failure
        ? `${readAt("security_posture") ?? ""}${failure.error === null ? "" : `!${failure.attempted_at ?? ""}`}`
        : null,
      // A failure changes the key too, so a report built before it is not served after.
      scorecard: scorecard ? `${scorecard.read_at ?? ""}${scorecard.error === null ? "" : "!"}` : null,
    };
  }
}
