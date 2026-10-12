import type { DatabaseSync } from "node:sqlite";
import {
  ALERT_SOURCES,
  CLOSE_REASONS,
  NOT_USED_REASONS,
  NO_ACCESS_REASONS,
  OFF_REASONS,
  type AlertOf,
  type AlertSource,
  type HeldPosture,
  type LockedPackage,
  type ReadFailure,
  type RepoPosture,
  type ScorecardResult,
  SUPPLY_CHAIN_VERSION,
  type SecurityAlert,
  type SourceState,
  type SupplyChainFacts,
  type SupplyChainRecord,
} from "@dora-dashboard/core";
import type { Logger } from "../../interfaces/logger.js";
import { noopLogger } from "../../interfaces/logger.js";
import type { SaveMode, SecurityKeys, SecurityStore, StoredScorecard } from "../../interfaces/security-store.js";

/**
 * The scorecard table. `read_at` is null until a read succeeds, so a failed first read can be stored; a failure carries
 * the message and the time of the attempt.
 */
const scorecardTable = (name: string) => `CREATE TABLE ${name} (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  read_at TEXT,
  data TEXT,
  error TEXT,
  attempted_at TEXT
)`;

/** The posture table. A failed first read has neither a read time nor a posture, so both are nullable. */
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
  skipped INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS supply_chain_failure (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
${postureTable("IF NOT EXISTS security_posture")};
${scorecardTable("IF NOT EXISTS security_scorecard")};
`;

/**
 * Brings the security tables of a database made by an earlier build up to date, safely to run on every open.
 *
 * - A source table without the `skipped` column gets it, with 0 for the rows already there, and its `error` rows lose
 *   their read time (see below).
 * - A scorecard or posture table that lacks the `error` column (or the scorecard's `attempted_at`), or has `read_at`
 *   NOT NULL, is rebuilt so a failed first read can be stored. SQLite cannot loosen a constraint in place, so each such
 *   table is rebuilt in one transaction, which leaves both as they were if anything fails; a table that is already
 *   current is not touched, and a second run does nothing.
 */
export function migrateSecurityTables(db: DatabaseSync): void {
  const columnsOf = (table: string) =>
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string; notnull: number }[];
  if (!columnsOf("security_sources").some((c) => c.name === "skipped")) {
    db.exec("ALTER TABLE security_sources ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0");
    // An error row of the earlier build kept the read time of whatever came before it, even a `no_access` one that was
    // never graded, so it cannot be told from a good read and would grade months-old alerts again. It has no last good
    // read, and the next crawl writes the state afresh.
    db.exec("UPDATE security_sources SET read_at = NULL WHERE status = 'error'");
  }
  const scorecard = columnsOf("security_scorecard");
  const posture = columnsOf("security_posture");
  const scorecardCurrent =
    scorecard.some((c) => c.name === "error") &&
    scorecard.some((c) => c.name === "attempted_at") &&
    scorecard.find((c) => c.name === "read_at")?.notnull === 0;
  const postureCurrent =
    posture.some((c) => c.name === "error") &&
    posture.some((c) => c.name === "attempted_at") &&
    posture.find((c) => c.name === "read_at")?.notnull === 0;
  if (scorecardCurrent && postureCurrent) return;
  db.exec("BEGIN");
  try {
    if (!scorecardCurrent) rebuild(db, "security_scorecard", scorecardTable, "repo_id, read_at, data", ["error"]);
    if (!postureCurrent) rebuild(db, "security_posture", postureTable, "repo_id, read_at, data", ["error", "attempted_at"]);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Recreates `table` with the current definition and copies `columns` across from the old one, with each of `optional`
 * that the old one has, so a failure the old table already held is kept.
 */
function rebuild(
  db: DatabaseSync,
  table: string,
  definition: (name: string) => string,
  columns: string,
  optional: readonly string[],
): void {
  const had = (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);
  const copied = [columns, ...optional.filter((name) => had.includes(name))].join(", ");
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_earlier`);
  db.exec(definition(table));
  db.exec(`INSERT INTO ${table} (${copied}) SELECT ${copied} FROM ${table}_earlier`);
  db.exec(`DROP TABLE ${table}_earlier`);
}

interface SourceRow {
  source: AlertSource;
  status: string;
  reason: string | null;
  read_at: string | null;
  attempted_at: string | null;
  truncated: number;
  error: string | null;
  skipped: number;
}

const notRead = (): SourceState => ({ status: "not_read" });

const has = (list: readonly string[], value: string | null): boolean => value !== null && list.includes(value);

/**
 * The state a stored row stands for, or null when the row is not in the current shape: a status that is not known, no
 * attempt time, or a reason that does not belong to its status. A row written by an earlier build that used one flat
 * shape for every status, such as OSV's `off` for a lookup that was not used, is read as unknown and rewritten by the
 * next crawl.
 */
function stateOf(row: SourceRow): SourceState | null {
  const attemptedAt = row.attempted_at;
  if (typeof attemptedAt !== "string") return null;
  const reason = row.reason;
  switch (row.status) {
    case "ok":
      return typeof row.read_at === "string"
        ? { status: "ok", readAt: row.read_at, attemptedAt, truncated: row.truncated === 1, skipped: row.skipped }
        : null;
    case "off":
      return has(OFF_REASONS, reason) ? { status: "off", reason: reason as (typeof OFF_REASONS)[number], attemptedAt } : null;
    case "no_access":
      return has(NO_ACCESS_REASONS, reason)
        ? { status: "no_access", reason: reason as (typeof NO_ACCESS_REASONS)[number], attemptedAt }
        : null;
    case "not_used":
      return has(NOT_USED_REASONS, reason)
        ? { status: "not_used", reason: reason as (typeof NOT_USED_REASONS)[number], attemptedAt }
        : null;
    case "error":
      return typeof row.error === "string"
        ? {
            status: "error",
            error: row.error,
            attemptedAt,
            lastGood:
              typeof row.read_at === "string"
                ? { readAt: row.read_at, truncated: row.truncated === 1, skipped: row.skipped }
                : null,
          }
        : null;
    default:
      return null;
  }
}

function parse<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`Stored ${what} is not readable`, { cause });
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";

const ALERT_STATES: readonly string[] = ["open", "fixed", "dismissed"];
/** The part of a stored alert that holds what its source's readers go on to use. */
const ALERT_PARTS: Record<AlertSource, string> = {
  dependabot: "dependency",
  osv: "dependency",
  code_scanning: "code",
  secret_scanning: "exposure",
};

/** A stored alert that has the shape the report reads: its source, a state, a key, a time and the part for its source. */
function isAlert(value: unknown, source: string, key: string): value is SecurityAlert {
  return (
    isObject(value) &&
    value.source === source &&
    ALERT_SOURCES.includes(source as AlertSource) &&
    value.key === key &&
    isString(value.createdAt) &&
    isString(value.state) &&
    ALERT_STATES.includes(value.state) &&
    (value.closeReason === null ||
      (isString(value.closeReason) && (CLOSE_REASONS as readonly string[]).includes(value.closeReason))) &&
    isObject(value[ALERT_PARTS[source as AlertSource]])
  );
}

/** Supply chain facts of this version, whose lists and tables the report reads without checking. */
function isFacts(value: unknown): value is SupplyChainFacts {
  if (!isObject(value) || value.version !== SUPPLY_CHAIN_VERSION) return false;
  const lists = ["workflowsUnread", "dockerfilesUnread", "actions", "findings", "securityTools", "missingLockfiles"];
  const more = ["lockfiles", "keyFiles", "dockerfiles", "ecosystems"];
  // Rows stored before the listing was reported lack `listingComplete`, which reads as an incomplete listing.
  const listing = value.listingComplete === undefined || typeof value.listingComplete === "boolean";
  return listing && [...lists, ...more].every((name) => Array.isArray(value[name])) && isObject(value.manifestsByEcosystem);
}

function isPosture(value: unknown): value is RepoPosture {
  return isObject(value) && isObject(value.branch) && isObject(value.branch.rules) && isObject(value.settings);
}

function isScorecard(value: unknown): value is ScorecardResult {
  return isObject(value) && typeof value.score === "number" && isString(value.date) && Array.isArray(value.checks);
}

/** The `SecurityStore` over an open database, which `SqliteRepoStore` hands its own connection. */
export class SecurityTables implements SecurityStore {
  /** Rows already reported as unreadable, so a polled report does not repeat the warning. */
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

  saveSecurityAlerts<S extends AlertSource>(repoId: number, source: S, alerts: readonly AlertOf<S>[], mode: SaveMode): void {
    const upsert = this.db.prepare(
      "INSERT INTO security_alerts (repo_id, source, key, state, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT (repo_id, source, key) DO UPDATE SET state = excluded.state, data = excluded.data",
    );
    this.transaction(() => {
      for (const alert of alerts) {
        // An alert filed under another source would be pruned or kept by the wrong read.
        if (alert.source !== source) throw new Error(`A ${alert.source} alert cannot be saved as ${source}`);
        upsert.run(repoId, source, alert.key, alert.state, JSON.stringify(alert));
      }
      if (mode === "merge") return;
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

  securityAlertsOf<S extends AlertSource>(repoId: number, source: S): AlertOf<S>[] {
    return this.securityAlerts(repoId).filter((alert): alert is AlertOf<S> => alert.source === source);
  }

  securityAlerts(repoId: number): SecurityAlert[] {
    const rows = this.db
      .prepare("SELECT source, key, data FROM security_alerts WHERE repo_id = ? ORDER BY source, key")
      .all(repoId) as unknown as { source: string; key: string; data: string }[];
    // One corrupt row costs that alert only; it must not turn every report of the repository into a 500.
    return rows.flatMap((row) => {
      try {
        const alert = parse<unknown>(row.data, `${row.source} alert ${row.key} of repository ${repoId}`);
        if (!isAlert(alert, row.source, row.key)) throw new Error(`Stored ${row.source} alert ${row.key} has an unknown shape`);
        return [alert];
      } catch (err) {
        this.warnOnce(
          `${repoId}:${row.source}:${row.key}`,
          { err, repoId, source: row.source },
          "a stored security alert is not readable; leaving it out",
        );
        return [];
      }
    });
  }

  /** Reports a stored row that cannot be read once, so a polled report does not repeat the warning. */
  private warnOnce(id: string, context: Record<string, unknown>, message: string): void {
    if (this.warned.has(id)) return;
    this.warned.add(id);
    this.log.warn(context, message);
  }

  /**
   * The stored value of one kind for a repository, or null with a warning when its row cannot be read, so the failure
   * stays on that repository and that part and never turns the report of every repository into a 500.
   */
  private readOrNull<T>(repoId: number, what: string, text: string, valid: (value: unknown) => value is T): T | null {
    try {
      const value = parse<unknown>(text, `${what} of repository ${repoId}`);
      if (!valid(value)) throw new Error(`Stored ${what} of repository ${repoId} has an unknown shape`);
      return value;
    } catch (err) {
      this.warnOnce(
        `${repoId}:${what}:${text.length}:${text.slice(0, 64)}`,
        { err, repoId },
        `stored ${what} is not readable; leaving it out`,
      );
      return null;
    }
  }

  setSourceState(repoId: number, source: AlertSource, state: SourceState): void {
    if (state.status === "not_read") {
      this.db.prepare("DELETE FROM security_sources WHERE repo_id = ? AND source = ?").run(repoId, source);
      return;
    }
    // The columns carry each status's own fields: a reason for off, no_access and not_used; the read for ok; and for an
    // error the last good read, if it had one, beside the message.
    const read = state.status === "ok" ? state : state.status === "error" ? state.lastGood : null;
    this.db
      .prepare(
        `INSERT INTO security_sources (repo_id, source, status, reason, read_at, attempted_at, truncated, error, skipped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, source) DO UPDATE SET status = excluded.status, reason = excluded.reason,
           read_at = excluded.read_at, attempted_at = excluded.attempted_at, truncated = excluded.truncated,
           error = excluded.error, skipped = excluded.skipped`,
      )
      .run(
        repoId,
        source,
        state.status,
        "reason" in state ? state.reason : null,
        read?.readAt ?? null,
        state.attemptedAt,
        read?.truncated ? 1 : 0,
        state.status === "error" ? state.error : null,
        read?.skipped ?? 0,
      );
  }

  sourceStates(repoId: number): Record<AlertSource, SourceState> {
    const states = Object.fromEntries(ALERT_SOURCES.map((source) => [source, notRead()])) as Record<AlertSource, SourceState>;
    const rows = this.db.prepare("SELECT * FROM security_sources WHERE repo_id = ?").all(repoId) as unknown as SourceRow[];
    for (const row of rows) {
      if (!ALERT_SOURCES.includes(row.source)) continue;
      const state = stateOf(row);
      if (state === null) {
        this.warnOnce(
          `${repoId}:${row.source}:${row.status}:${row.reason}`,
          { repoId, source: row.source },
          "a stored source state is not in the current shape; reading it as not read until the next crawl",
        );
        continue;
      }
      states[row.source] = state;
    }
    return states;
  }

  /** A good inspection, which also clears the failure of an earlier one. */
  saveSupplyChain(repoId: number, record: SupplyChainRecord, packages: readonly LockedPackage[]): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO supply_chain (repo_id, commit_sha, read_at, version, facts, packages) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo_id) DO UPDATE SET commit_sha = excluded.commit_sha, read_at = excluded.read_at,
             version = excluded.version, facts = excluded.facts, packages = excluded.packages`,
        )
        .run(
          repoId,
          record.commitSha,
          record.readAt,
          record.facts.version,
          JSON.stringify(record.facts),
          JSON.stringify(packages),
        );
      this.db.prepare("DELETE FROM supply_chain_failure WHERE repo_id = ?").run(repoId);
    });
  }

  failSupplyChain(repoId: number, message: string, attemptedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO supply_chain_failure (repo_id, message, attempted_at) VALUES (?, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET message = excluded.message, attempted_at = excluded.attempted_at`,
      )
      .run(repoId, message, attemptedAt);
  }

  supplyChainFailure(repoId: number): ReadFailure | null {
    const row = this.db
      .prepare("SELECT message, attempted_at FROM supply_chain_failure WHERE repo_id = ?")
      .get(repoId) as unknown as { message: string; attempted_at: string } | undefined;
    return row ? { message: row.message, attemptedAt: row.attempted_at } : null;
  }

  /** Never selects `packages`, which can run to tens of thousands of entries and is wanted only by the OSV lookup. */
  supplyChain(repoId: number): SupplyChainRecord | null {
    const row = this.db
      .prepare("SELECT commit_sha, read_at, facts FROM supply_chain WHERE repo_id = ?")
      .get(repoId) as unknown as { commit_sha: string; read_at: string; facts: string } | undefined;
    if (!row) return null;
    // Facts of another version, or of a shape the report cannot read, count as not held, so the next crawl reads them again.
    const facts = this.readOrNull(repoId, "supply chain facts", row.facts, isFacts);
    return facts === null ? null : { commitSha: row.commit_sha, readAt: row.read_at, facts };
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
  failPosture(repoId: number, message: string, attemptedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO security_posture (repo_id, read_at, data, error, attempted_at) VALUES (?, NULL, NULL, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET error = excluded.error, attempted_at = excluded.attempted_at`,
      )
      .run(repoId, message, attemptedAt);
  }

  posture(repoId: number): HeldPosture | null {
    const row = this.db.prepare("SELECT read_at, data FROM security_posture WHERE repo_id = ?").get(repoId) as unknown as
      { read_at: string | null; data: string | null } | undefined;
    if (!row?.read_at || !row.data) return null;
    const posture = this.readOrNull(repoId, "posture", row.data, isPosture);
    return posture === null ? null : { readAt: row.read_at, value: posture };
  }

  postureFailure(repoId: number): ReadFailure | null {
    const row = this.db.prepare("SELECT error, attempted_at FROM security_posture WHERE repo_id = ?").get(repoId) as unknown as
      { error: string | null; attempted_at: string | null } | undefined;
    return row?.error && row.attempted_at ? { message: row.error, attemptedAt: row.attempted_at } : null;
  }

  /** A good read, which also clears any earlier failure. */
  saveScorecard(repoId: number, readAt: string, result: ScorecardResult | null): void {
    this.db
      .prepare(
        `INSERT INTO security_scorecard (repo_id, read_at, data, error, attempted_at) VALUES (?, ?, ?, NULL, NULL)
         ON CONFLICT (repo_id) DO UPDATE SET read_at = excluded.read_at, data = excluded.data, error = NULL, attempted_at = NULL`,
      )
      .run(repoId, readAt, result === null ? null : JSON.stringify(result));
  }

  /** Records a failed read and keeps the last good result and its read time, so the daily throttle is unaffected. */
  failScorecard(repoId: number, message: string, attemptedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO security_scorecard (repo_id, read_at, data, error, attempted_at) VALUES (?, NULL, NULL, ?, ?)
         ON CONFLICT (repo_id) DO UPDATE SET error = excluded.error, attempted_at = excluded.attempted_at`,
      )
      .run(repoId, message, attemptedAt);
  }

  scorecard(repoId: number): StoredScorecard | null {
    const row = this.db
      .prepare("SELECT read_at, data, error, attempted_at FROM security_scorecard WHERE repo_id = ?")
      .get(repoId) as unknown as
      { read_at: string | null; data: string | null; error: string | null; attempted_at: string | null } | undefined;
    if (!row) return null;
    return {
      readAt: row.read_at,
      result: row.data === null ? null : this.readOrNull(repoId, "scorecard", row.data, isScorecard),
      // A failure stored without its attempt time, by an earlier build, is not shown; the next attempt stores it again.
      failure: row.error && row.attempted_at ? { message: row.error, attemptedAt: row.attempted_at } : null,
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
      supplyChainFailure: this.supplyChainFailure(repoId)?.attemptedAt ?? null,
    };
  }
}
