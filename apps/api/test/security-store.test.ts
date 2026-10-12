import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SourceState } from "@dora-dashboard/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import {
  codeScanningAlert,
  dependabotAlert,
  lockedPackage,
  osvAlert,
  repoPosture,
  scorecardResult,
  secretScanningAlert,
  supplyChainFacts,
  supplyChainRecord,
} from "./fakes.js";

const rawDb = (store: SqliteRepoStore) => (store as unknown as { db: DatabaseSync }).db;

const okState = (overrides: Partial<SourceState> = {}): SourceState => ({
  status: "ok",
  reason: null,
  readAt: "2026-09-29T10:00:00.000Z",
  attemptedAt: "2026-09-29T10:00:00.000Z",
  truncated: false,
  error: null,
  ...overrides,
});

describe("security alerts in the store", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("reads each kind of alert back exactly as it was stored", () => {
    const all = [dependabotAlert({ key: "1" }), codeScanningAlert({ key: "2" }), secretScanningAlert({ key: "3" })];
    store.saveSecurityAlerts(repoId, "dependabot", [all[0]!], true);
    store.saveSecurityAlerts(repoId, "code_scanning", [all[1]!], true);
    store.saveSecurityAlerts(repoId, "secret_scanning", [all[2]!], true);

    // Ordered by source, then key.
    expect(store.securityAlerts(repoId)).toEqual([all[1], all[0], all[2]]);
  });

  it("replaces an alert by source and key, so the same number under two sources is two alerts", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1", severity: "high" })], true);
    store.saveSecurityAlerts(repoId, "osv", [osvAlert({ key: "1" })], true);
    store.saveSecurityAlerts(
      repoId,
      "dependabot",
      [dependabotAlert({ key: "1", severity: "low", state: "fixed", closedAt: "2026-09-05T00:00:00Z" })],
      true,
    );

    const held = store.securityAlerts(repoId);

    expect(held).toHaveLength(2);
    expect(held.find((a) => a.source === "dependabot")).toMatchObject({ severity: "low", state: "fixed" });
  });

  it("removes the alerts a complete read did not see, and only those of the same source and repository", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    store.saveSecurityAlerts(
      repoId,
      "dependabot",
      [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" }), dependabotAlert({ key: "3" })],
      true,
    );
    store.saveSecurityAlerts(repoId, "code_scanning", [codeScanningAlert({ key: "1" })], true);
    store.saveSecurityAlerts(other, "dependabot", [dependabotAlert({ key: "9" })], true);

    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "2" })], true);

    expect(store.securityAlerts(repoId).map((a) => `${a.source}:${a.key}`)).toEqual(["code_scanning:1", "dependabot:2"]);
    expect(store.securityAlerts(other)).toHaveLength(1);
  });

  it("keeps the alerts a partial read did not see", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })], true);

    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "2", severity: "low" })], false);

    expect(store.securityAlerts(repoId).map((a) => a.key)).toEqual(["1", "2"]);
    expect(store.securityAlerts(repoId)[1]).toMatchObject({ severity: "low" });
  });

  it("empties a complete read that found nothing", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert()], true);
    store.saveSecurityAlerts(repoId, "dependabot", [], true);
    expect(store.securityAlerts(repoId)).toEqual([]);
  });

  it("saves and prunes in one transaction, so an alert that cannot be saved leaves everything as it was", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })], true);
    // The second alert is filed under the wrong source, which the store refuses after saving the first.
    const wrong = codeScanningAlert({ key: "5" });

    expect(() =>
      store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1", severity: "low" }), wrong as never], true),
    ).toThrow("cannot be saved as dependabot");

    const held = store.securityAlerts(repoId);
    expect(held.map((a) => a.key)).toEqual(["1", "2"]);
    expect(held[0]).toMatchObject({ severity: "high" });
  });

  it("rolls back a prune that fails part way", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1" }), dependabotAlert({ key: "2" })], true);
    rawDb(store).exec(
      "CREATE TRIGGER stop_deletes BEFORE DELETE ON security_alerts BEGIN SELECT RAISE(ABORT, 'no deleting'); END",
    );

    expect(() => store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert({ key: "1", severity: "low" })], true)).toThrow(
      "no deleting",
    );

    expect(store.securityAlerts(repoId).map((a) => `${a.key}:${a.source === "dependabot" ? a.severity : ""}`)).toEqual([
      "1:high",
      "2:high",
    ]);
  });

  it("clears one source's alerts and no other's", () => {
    store.saveSecurityAlerts(repoId, "dependabot", [dependabotAlert()], true);
    store.saveSecurityAlerts(repoId, "code_scanning", [codeScanningAlert()], true);

    store.clearSecurityAlerts(repoId, "dependabot");

    expect(store.securityAlerts(repoId).map((a) => a.source)).toEqual(["code_scanning"]);
  });

  it("leaves out an alert whose stored record cannot be read, and logs it once, so the others still show", () => {
    const warnings: Record<string, unknown>[] = [];
    const log = {
      info: () => undefined,
      error: () => undefined,
      warn: (context: object) => void warnings.push(context as never),
    };
    const logged = new SqliteRepoStore(":memory:", () => new Date(), log);
    const id = logged.addRepo("acme", "widgets", [], "main").id;
    logged.saveSecurityAlerts(id, "dependabot", [dependabotAlert({ key: "41" }), dependabotAlert({ key: "42" })], true);
    rawDb(logged).exec("UPDATE security_alerts SET data = '{broken' WHERE key = '41'");

    expect(logged.securityAlerts(id).map((a) => a.key)).toEqual(["42"]);
    expect(logged.securityAlerts(id).map((a) => a.key)).toEqual(["42"]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ repoId: id, source: "dependabot" });
    expect(String((warnings[0]!.err as Error).message)).toContain("Stored dependabot alert 41 of repository");
  });

  it("stores no field called secret and no login, whatever an alert carries", () => {
    store.saveSecurityAlerts(repoId, "secret_scanning", [secretScanningAlert()], true);
    const row = rawDb(store).prepare("SELECT data FROM security_alerts").get() as unknown as { data: string };
    expect(row.data).not.toMatch(/"secret"|login/);
  });
});

describe("source states in the store", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("answers not_read for every source that was never read, with no times", () => {
    const notRead = { status: "not_read", reason: null, readAt: null, attemptedAt: null, truncated: false, error: null };
    expect(store.sourceStates(repoId)).toEqual({
      dependabot: notRead,
      code_scanning: notRead,
      secret_scanning: notRead,
      osv: notRead,
    });
  });

  it("round trips a state and replaces it on the next save, leaving the other sources alone", () => {
    store.setSourceState(repoId, "dependabot", okState({ truncated: true }));
    store.setSourceState(repoId, "code_scanning", {
      status: "off",
      reason: "needs_advanced_security",
      readAt: null,
      attemptedAt: "2026-09-29T10:00:00.000Z",
      truncated: false,
      error: null,
    });
    store.setSourceState(
      repoId,
      "dependabot",
      okState({ status: "error", error: "GitHub could not be reached", readAt: "2026-09-28T10:00:00.000Z" }),
    );

    const states = store.sourceStates(repoId);

    expect(states.dependabot).toEqual({
      status: "error",
      reason: null,
      readAt: "2026-09-28T10:00:00.000Z",
      attemptedAt: "2026-09-29T10:00:00.000Z",
      truncated: false,
      error: "GitHub could not be reached",
    });
    expect(states.code_scanning).toMatchObject({ status: "off", reason: "needs_advanced_security", readAt: null });
    expect(states.secret_scanning.status).toBe("not_read");
  });

  it("keeps states apart per repository", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    store.setSourceState(repoId, "osv", okState());
    expect(store.sourceStates(other).osv.status).toBe("not_read");
  });

  it("ignores a row for a source this build does not know", () => {
    rawDb(store).prepare("INSERT INTO security_sources (repo_id, source, status) VALUES (?, 'future', 'ok')").run(repoId);
    expect(Object.keys(store.sourceStates(repoId))).toEqual(["dependabot", "code_scanning", "secret_scanning", "osv"]);
  });
});

describe("supply chain facts, posture and scorecard in the store", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("answers null and no packages before anything was read", () => {
    expect(store.supplyChain(repoId)).toBeNull();
    expect(store.lockedPackages(repoId)).toEqual([]);
    expect(store.posture(repoId)).toBeNull();
    expect(store.scorecard(repoId)).toBeNull();
  });

  it("round trips the record and its packages, and replaces both together", () => {
    const record = supplyChainRecord({
      facts: supplyChainFacts({ workflowsRead: 2, ecosystems: ["npm"], updateConfig: ".github/dependabot.yml" }),
    });
    store.saveSupplyChain(repoId, record, [lockedPackage(), lockedPackage({ name: "left-pad", version: "1.3.0" })]);

    expect(store.supplyChain(repoId)).toEqual(record);
    expect(store.lockedPackages(repoId).map((p) => p.name)).toEqual(["lodash", "left-pad"]);

    store.saveSupplyChain(repoId, supplyChainRecord({ commitSha: "def5678" }), []);

    expect(store.supplyChain(repoId)!.commitSha).toBe("def5678");
    expect(store.lockedPackages(repoId)).toEqual([]);
  });

  it("never returns packages from supplyChain(), and never reads them", () => {
    store.saveSupplyChain(repoId, supplyChainRecord(), [lockedPackage()]);

    expect(Object.keys(store.supplyChain(repoId)!).sort()).toEqual(["commitSha", "facts", "readAt"]);
    expect(JSON.stringify(store.supplyChain(repoId))).not.toContain("lodash");
    // Packages that cannot be parsed do not matter to a caller that does not ask for them.
    rawDb(store).exec("UPDATE supply_chain SET packages = '{broken'");
    expect(store.supplyChain(repoId)).not.toBeNull();
    expect(() => store.lockedPackages(repoId)).toThrow("Stored locked packages of repository");
  });

  it("names the repository when stored facts cannot be read", () => {
    store.saveSupplyChain(repoId, supplyChainRecord(), []);
    rawDb(store).exec("UPDATE supply_chain SET facts = 'nope'");
    expect(() => store.supplyChain(repoId)).toThrow("Stored supply chain facts of repository");
  });

  it("round trips posture with its read time", () => {
    const posture = repoPosture({ visibility: "public", advisories: { draft: 0, triage: 1, published: 2, closed: 3 } });
    store.savePosture(repoId, posture, "2026-09-29T10:00:00.000Z");
    store.savePosture(repoId, { ...posture, isAdmin: true }, "2026-09-30T10:00:00.000Z");

    expect(store.posture(repoId)).toEqual({ posture: { ...posture, isAdmin: true }, readAt: "2026-09-30T10:00:00.000Z" });
  });

  it("round trips a scorecard, and records that a project was asked about and not scanned", () => {
    store.saveScorecard(repoId, "2026-09-29T10:00:00.000Z", scorecardResult());
    expect(store.scorecard(repoId)).toEqual({ readAt: "2026-09-29T10:00:00.000Z", result: scorecardResult(), error: null });

    store.saveScorecard(repoId, "2026-09-30T10:00:00.000Z", null);
    expect(store.scorecard(repoId)).toEqual({ readAt: "2026-09-30T10:00:00.000Z", result: null, error: null });
  });

  it("records a failed scorecard read beside the last good one, until the next good read clears it", () => {
    store.failScorecard(repoId, "Scorecard is not answering");
    expect(store.scorecard(repoId)).toEqual({ readAt: null, result: null, error: "Scorecard is not answering" });

    store.saveScorecard(repoId, "2026-09-29T10:00:00.000Z", scorecardResult());
    store.failScorecard(repoId, "Scorecard is not answering");
    expect(store.scorecard(repoId)).toEqual({
      readAt: "2026-09-29T10:00:00.000Z",
      result: scorecardResult(),
      error: "Scorecard is not answering",
    });

    store.saveScorecard(repoId, "2026-09-30T10:00:00.000Z", scorecardResult({ score: 8 }));
    expect(store.scorecard(repoId)).toMatchObject({ readAt: "2026-09-30T10:00:00.000Z", error: null });
  });

  it("changes the scorecard memo key when a read fails", () => {
    store.saveScorecard(repoId, "2026-09-29T10:00:00.000Z", null);
    const good = store.securityKeys(repoId).scorecard;
    store.failScorecard(repoId, "down");
    expect(store.securityKeys(repoId).scorecard).not.toBe(good);
  });

  it("keeps the last good posture beside a failed read, and a good read clears the failure", () => {
    store.savePosture(repoId, repoPosture({ visibility: "public" }), "2026-09-29T10:00:00.000Z");
    store.failPosture(repoId, "GitHub answered 500", "2026-09-30T10:00:00.000Z");

    expect(store.posture(repoId)).toMatchObject({ readAt: "2026-09-29T10:00:00.000Z" });
    expect(store.postureFailure(repoId)).toEqual({ error: "GitHub answered 500", attemptedAt: "2026-09-30T10:00:00.000Z" });

    store.savePosture(repoId, repoPosture(), "2026-10-01T10:00:00.000Z");
    expect(store.postureFailure(repoId)).toBeNull();
  });

  it("accepts a first failed posture read, which has no posture and no read time", () => {
    store.failPosture(repoId, "down", "2026-09-30T10:00:00.000Z");

    expect(store.posture(repoId)).toBeNull();
    expect(store.postureFailure(repoId)).toEqual({ error: "down", attemptedAt: "2026-09-30T10:00:00.000Z" });
    expect(store.securityKeys(repoId).posture).toBe("!2026-09-30T10:00:00.000Z");
  });

  it("changes the posture memo key when a read fails", () => {
    store.savePosture(repoId, repoPosture(), "2026-09-29T10:00:00.000Z");
    const good = store.securityKeys(repoId).posture;
    store.failPosture(repoId, "down", "2026-09-30T10:00:00.000Z");
    expect(store.securityKeys(repoId).posture).not.toBe(good);
  });

  it("names the repository when a stored posture or scorecard cannot be read", () => {
    store.savePosture(repoId, repoPosture(), "t");
    store.saveScorecard(repoId, "t", scorecardResult());
    rawDb(store).exec("UPDATE security_posture SET data = 'x'; UPDATE security_scorecard SET data = 'x'");
    expect(() => store.posture(repoId)).toThrow("Stored posture of repository");
    expect(() => store.scorecard(repoId)).toThrow("Stored scorecard of repository");
  });

  it("gives memo keys that change when any of the parts is written", () => {
    const keys = () => JSON.stringify(store.securityKeys(repoId));
    const empty = keys();
    expect(store.securityKeys(repoId)).toEqual({ sources: "", supplyChain: null, posture: null, scorecard: null });

    store.setSourceState(repoId, "dependabot", okState());
    const afterSource = keys();
    store.saveSupplyChain(repoId, supplyChainRecord(), []);
    const afterSupply = keys();
    store.savePosture(repoId, repoPosture(), "2026-09-29T11:00:00.000Z");
    const afterPosture = keys();
    store.saveScorecard(repoId, "2026-09-29T12:00:00.000Z", null);
    const afterScorecard = keys();

    expect(new Set([empty, afterSource, afterSupply, afterPosture, afterScorecard]).size).toBe(5);
    expect(store.securityKeys(repoId)).toEqual({
      sources: "dependabot:2026-09-29T10:00:00.000Z:2026-09-29T10:00:00.000Z",
      supplyChain: "2026-09-29T10:00:00.000Z",
      posture: "2026-09-29T11:00:00.000Z",
      scorecard: "2026-09-29T12:00:00.000Z",
    });
    store.setSourceState(repoId, "dependabot", okState({ attemptedAt: "2026-09-30T10:00:00.000Z" }));
    expect(keys()).not.toBe(afterScorecard);
  });
});

describe("deleting a repository removes its security data", () => {
  it("cascades to every security table and leaves another repository's data", () => {
    const store = new SqliteRepoStore(":memory:");
    const gone = store.addRepo("acme", "widgets", [], "main").id;
    const kept = store.addRepo("acme", "gadgets", [], "main").id;
    for (const id of [gone, kept]) {
      store.saveSecurityAlerts(id, "dependabot", [dependabotAlert()], true);
      store.setSourceState(id, "dependabot", okState());
      store.saveSupplyChain(id, supplyChainRecord(), [lockedPackage()]);
      store.savePosture(id, repoPosture(), "t");
      store.saveScorecard(id, "t", scorecardResult());
    }

    store.deleteRepo(gone);

    for (const table of ["security_alerts", "security_sources", "supply_chain", "security_posture", "security_scorecard"]) {
      const rows = rawDb(store).prepare(`SELECT repo_id FROM ${table}`).all() as unknown as { repo_id: number }[];
      expect(
        rows.map((r) => r.repo_id),
        table,
      ).toEqual([kept]);
    }
  });
});

describe("opening a database made before security was read", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dora-security-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the security tables, keeps the repository, and lets security data be stored and survive a reopen", () => {
    const path = join(dir, "old.db");
    const first = new SqliteRepoStore(path);
    const id = first.addRepo("acme", "widgets", [], "main").id;
    // What a database written before this feature looks like: every table of the feature missing.
    const db = rawDb(first);
    for (const table of ["security_alerts", "security_sources", "supply_chain", "security_posture", "security_scorecard"]) {
      db.exec(`DROP TABLE ${table}`);
    }
    db.close();

    const store = new SqliteRepoStore(path);
    const tables = (
      rawDb(store).prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["security_alerts", "security_sources", "supply_chain", "security_posture", "security_scorecard"]),
    );
    expect(store.findRepo("acme", "widgets")!.id).toBe(id);
    expect(store.sourceStates(id).dependabot.status).toBe("not_read");

    store.saveSecurityAlerts(id, "dependabot", [dependabotAlert()], true);
    rawDb(store).close();
    expect(new SqliteRepoStore(path).securityAlerts(id)).toHaveLength(1);
  });
});

describe("migrating a database made by phase one of the security feature", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dora-migrate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** The security tables exactly as phase one made them: the scorecard table had a NOT NULL read time and no error column. */
  function phaseOneDatabase(path: string): void {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, name TEXT NOT NULL,
      deploy_workflows TEXT NOT NULL DEFAULT '[]', deploy_branch TEXT NOT NULL DEFAULT 'main', added_at TEXT NOT NULL,
      last_crawled_at TEXT, crawl_status TEXT NOT NULL DEFAULT 'idle', crawl_error TEXT, crawl_progress TEXT,
      crawl_cursor TEXT, UNIQUE (owner, name)
    );
    CREATE TABLE security_alerts (
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, source TEXT NOT NULL, key TEXT NOT NULL,
      state TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (repo_id, source, key)
    );
    CREATE TABLE security_sources (
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE, source TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT, read_at TEXT, attempted_at TEXT, truncated INTEGER NOT NULL DEFAULT 0, error TEXT,
      PRIMARY KEY (repo_id, source)
    );
    CREATE TABLE supply_chain (
      repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, commit_sha TEXT NOT NULL,
      read_at TEXT NOT NULL, version INTEGER NOT NULL, facts TEXT NOT NULL, packages TEXT NOT NULL
    );
    CREATE TABLE security_posture (
      repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, read_at TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE security_scorecard (
      repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE, read_at TEXT NOT NULL, data TEXT
    );`);
    db.prepare("INSERT INTO repos (owner, name, added_at) VALUES ('acme', 'widgets', '2026-09-01T00:00:00Z')").run();
    db.prepare("INSERT INTO security_scorecard (repo_id, read_at, data) VALUES (1, '2026-09-28T00:00:00.000Z', ?)").run(
      JSON.stringify(scorecardResult()),
    );
    db.prepare("INSERT INTO security_posture (repo_id, read_at, data) VALUES (1, '2026-09-27T00:00:00.000Z', ?)").run(
      JSON.stringify(repoPosture({ visibility: "public" })),
    );
    db.close();
  }

  const scorecardColumns = (path: string) => {
    const db = new DatabaseSync(path);
    const columns = db.prepare("PRAGMA table_info(security_scorecard)").all() as unknown as { name: string; notnull: number }[];
    db.close();
    return columns.map((c) => `${c.name}:${c.notnull}`);
  };

  it("adds the error column, loosens the read time, keeps the stored scorecard and works end to end", () => {
    const path = join(dir, "dora.db");
    phaseOneDatabase(path);

    const store = new SqliteRepoStore(path);
    expect(store.securityKeys(1).scorecard).toBe("2026-09-28T00:00:00.000Z");
    expect(store.scorecard(1)).toEqual({ readAt: "2026-09-28T00:00:00.000Z", result: scorecardResult(), error: null });
    store.failScorecard(1, "down");
    expect(store.scorecard(1)).toMatchObject({ error: "down", result: scorecardResult() });
    store.saveScorecard(1, "2026-09-29T00:00:00.000Z", null);
    expect(store.scorecard(1)).toEqual({ readAt: "2026-09-29T00:00:00.000Z", result: null, error: null });

    expect(scorecardColumns(path)).toEqual(["repo_id:0", "read_at:0", "data:0", "error:0"]);
  });

  it("adds the posture failure columns, keeps the stored posture and accepts a failure", () => {
    const path = join(dir, "dora.db");
    phaseOneDatabase(path);

    const store = new SqliteRepoStore(path);
    expect(store.posture(1)).toEqual({ posture: repoPosture({ visibility: "public" }), readAt: "2026-09-27T00:00:00.000Z" });
    expect(store.postureFailure(1)).toBeNull();
    store.failPosture(1, "down", "2026-09-30T00:00:00.000Z");
    expect(store.postureFailure(1)).toEqual({ error: "down", attemptedAt: "2026-09-30T00:00:00.000Z" });
    expect(store.posture(1)!.readAt).toBe("2026-09-27T00:00:00.000Z");

    const db = new DatabaseSync(path);
    const columns = db.prepare("PRAGMA table_info(security_posture)").all() as unknown as { name: string; notnull: number }[];
    db.close();
    expect(columns.map((c) => `${c.name}:${c.notnull}`)).toEqual([
      "repo_id:0",
      "read_at:0",
      "data:0",
      "error:0",
      "attempted_at:0",
    ]);
    // A second open finds the new shape and keeps what was stored.
    expect(new SqliteRepoStore(path).postureFailure(1)).toMatchObject({ error: "down" });
  });

  it("accepts a first failed read, which has no read time", () => {
    const path = join(dir, "dora.db");
    phaseOneDatabase(path);
    const raw = new DatabaseSync(path);
    raw.exec("DELETE FROM security_scorecard");
    raw.close();

    const store = new SqliteRepoStore(path);
    store.failScorecard(1, "down");

    expect(store.scorecard(1)).toEqual({ readAt: null, result: null, error: "down" });
  });

  it("changes nothing on a second open", () => {
    const path = join(dir, "dora.db");
    phaseOneDatabase(path);
    const first = new SqliteRepoStore(path);
    first.failScorecard(1, "down");
    const columns = scorecardColumns(path);

    const second = new SqliteRepoStore(path);

    expect(scorecardColumns(path)).toEqual(columns);
    expect(second.scorecard(1)).toEqual({ readAt: "2026-09-28T00:00:00.000Z", result: scorecardResult(), error: "down" });
  });

  it("leaves the other security tables as phase one made them", () => {
    const path = join(dir, "dora.db");
    phaseOneDatabase(path);
    new SqliteRepoStore(path);
    const db = new DatabaseSync(path);
    const names = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((c) => c.name);

    expect(names("security_sources")).toEqual([
      "repo_id",
      "source",
      "status",
      "reason",
      "read_at",
      "attempted_at",
      "truncated",
      "error",
    ]);
    expect(names("supply_chain")).toEqual(["repo_id", "commit_sha", "read_at", "version", "facts", "packages"]);
    expect(names("security_alerts")).toEqual(["repo_id", "source", "key", "state", "data"]);
    db.close();
  });
});
