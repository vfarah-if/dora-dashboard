import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { coverageFailure, coverageSnapshot, fn } from "./fakes.js";

const code = (analysedAt: string, error: string | null) => ({
  commitSha: error ? "" : "abc1234",
  analysedAt,
  functions: error ? [] : [fn()],
  partlyMeasured: [],
  unmeasuredFiles: 0,
  error,
  tooling: null,
  snapshotVersion: 6,
});

describe("the failed column of the snapshot tables", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dora-migrate-"));
    path = join(dir, "old.db");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A database as an earlier version left it: the snapshot tables have no `failed` column. */
  function oldDatabase(): void {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE code_snapshots (repo_id INTEGER NOT NULL, commit_sha TEXT NOT NULL, analysed_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (repo_id, analysed_at));
      CREATE TABLE coverage_snapshots (repo_id INTEGER NOT NULL, fetched_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (repo_id, fetched_at));
    `);
    const addCode = db.prepare("INSERT INTO code_snapshots (repo_id, commit_sha, analysed_at, data) VALUES (1, ?, ?, ?)");
    for (const s of [code("2026-09-01T10:00:00.000Z", null), code("2026-09-02T10:00:00.000Z", "clone failed")]) {
      addCode.run(s.commitSha, s.analysedAt, JSON.stringify(s));
    }
    const addCover = db.prepare("INSERT INTO coverage_snapshots (repo_id, fetched_at, data) VALUES (1, ?, ?)");
    for (const s of [
      coverageSnapshot({ fetchedAt: "2026-09-01T10:00:00.000Z" }),
      coverageFailure({ fetchedAt: "2026-09-02T10:00:00.000Z", error: "gone" }),
    ]) {
      addCover.run(s.fetchedAt, JSON.stringify(s));
    }
    db.close();
  }

  const failedColumns = (): Record<string, string[]> => {
    const db = new DatabaseSync(path);
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[])
        .filter((c) => c.name === "failed")
        .map((c) => c.name);
    const found = { code_snapshots: columns("code_snapshots"), coverage_snapshots: columns("coverage_snapshots") };
    db.close();
    return found;
  };

  it("adds the column to an old database and backfills it from the stored data", () => {
    oldDatabase();
    expect(failedColumns()).toEqual({ code_snapshots: [], coverage_snapshots: [] });

    const store = new SqliteRepoStore(path);

    expect(failedColumns()).toEqual({ code_snapshots: ["failed"], coverage_snapshots: ["failed"] });
    expect(store.codeSnapshotKeys(1)).toEqual({ latest: "2026-09-02T10:00:00.000Z", good: "2026-09-01T10:00:00.000Z" });
    expect(store.coverageSnapshotKeys(1)).toEqual({ latest: "2026-09-02T10:00:00.000Z", good: "2026-09-01T10:00:00.000Z" });
    expect(store.latestSuccessfulCodeSnapshot(1)).toMatchObject({ commitSha: "abc1234", error: null });
    expect(store.latestSuccessfulCoverageSnapshot(1)).toMatchObject({ fetchedAt: "2026-09-01T10:00:00.000Z", error: null });
    expect(store.latestCodeSnapshot(1)).toMatchObject({ error: "clone failed" });
  });

  it("can be opened again, and keeps writing the column on every save", () => {
    oldDatabase();
    new SqliteRepoStore(path);
    const store = new SqliteRepoStore(path);
    store.saveCoverageSnapshot(1, coverageFailure({ fetchedAt: "2026-09-03T10:00:00.000Z", error: "later" }));
    store.saveCodeSnapshot(1, code("2026-09-03T10:00:00.000Z", null));

    expect(store.coverageSnapshotKeys(1)).toEqual({ latest: "2026-09-03T10:00:00.000Z", good: "2026-09-01T10:00:00.000Z" });
    expect(store.codeSnapshotKeys(1)).toEqual({ latest: "2026-09-03T10:00:00.000Z", good: "2026-09-03T10:00:00.000Z" });
  });

  it("keeps the retention rules on a migrated database", () => {
    oldDatabase();
    const store = new SqliteRepoStore(path);
    for (let day = 3; day <= 9; day++) {
      store.saveCoverageSnapshot(1, coverageFailure({ fetchedAt: `2026-09-0${day}T10:00:00.000Z`, error: `boom ${day}` }));
      store.saveCodeSnapshot(1, code(`2026-09-0${day}T10:00:00.000Z`, `failed ${day}`));
    }

    // The migrated good read is older than every kept failure and is still spared.
    expect(store.latestSuccessfulCoverageSnapshot(1)?.fetchedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(store.latestSuccessfulCodeSnapshot(1)?.analysedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(store.coverageSnapshotKeys(1).latest).toBe("2026-09-09T10:00:00.000Z");
  });

  it("works on a new database, where the column comes with the table", () => {
    const store = new SqliteRepoStore(path);
    const id = store.addRepo("acme", "widgets", [], "main").id;
    store.saveCoverageSnapshot(id, coverageSnapshot());
    store.saveCoverageSnapshot(id, coverageFailure({ fetchedAt: "2026-09-30T10:00:00.000Z" }));

    expect(failedColumns().coverage_snapshots).toEqual(["failed"]);
    expect(store.coverageSnapshotKeys(id)).toEqual({ latest: "2026-09-30T10:00:00.000Z", good: "2026-09-29T10:00:00.000Z" });
  });

  it("treats a row an older build wrote after the migration, with no failed flag, by its stored error", () => {
    oldDatabase();
    const store = new SqliteRepoStore(path);
    const raw = new DatabaseSync(path);
    const failure = coverageFailure({ fetchedAt: "2026-09-04T10:00:00.000Z", error: "rolled back" });
    raw
      .prepare("INSERT INTO coverage_snapshots (repo_id, fetched_at, data) VALUES (1, ?, ?)")
      .run(failure.fetchedAt, JSON.stringify(failure));
    const good = coverageSnapshot({ fetchedAt: "2026-09-05T10:00:00.000Z" });
    raw
      .prepare("INSERT INTO coverage_snapshots (repo_id, fetched_at, data) VALUES (1, ?, ?)")
      .run(good.fetchedAt, JSON.stringify(good));
    const bad = code("2026-09-04T10:00:00.000Z", "rolled back");
    raw
      .prepare("INSERT INTO code_snapshots (repo_id, commit_sha, analysed_at, data) VALUES (1, ?, ?, ?)")
      .run("", bad.analysedAt, JSON.stringify(bad));
    raw.close();

    expect(store.coverageSnapshotKeys(1)).toEqual({ latest: "2026-09-05T10:00:00.000Z", good: "2026-09-05T10:00:00.000Z" });
    expect(store.codeSnapshotKeys(1)).toEqual({ latest: "2026-09-04T10:00:00.000Z", good: "2026-09-01T10:00:00.000Z" });

    store.clearCoverageFailures(1);
    store.saveCoverageSnapshot(1, coverageSnapshot({ fetchedAt: "2026-09-06T10:00:00.000Z" }));
    // The failure with no flag was cleared as a failure, and the migrated good read of 1 September is untouched.
    expect(store.latestSuccessfulCoverageSnapshot(1)?.fetchedAt).toBe("2026-09-06T10:00:00.000Z");
    const check = new DatabaseSync(path);
    const rows = check.prepare("SELECT fetched_at FROM coverage_snapshots ORDER BY fetched_at").all() as unknown as {
      fetched_at: string;
    }[];
    check.close();
    expect(rows.map((r) => r.fetched_at)).toEqual([
      "2026-09-01T10:00:00.000Z",
      "2026-09-05T10:00:00.000Z",
      "2026-09-06T10:00:00.000Z",
    ]);
  });
});
