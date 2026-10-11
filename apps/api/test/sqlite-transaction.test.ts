import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { inTransaction } from "../src/infrastructure/sqlite/transaction.js";

describe("inTransaction", () => {
  let db: DatabaseSync;
  const rows = () => (db.prepare("SELECT n FROM t ORDER BY n").all() as { n: number }[]).map((row) => row.n);

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (n INTEGER)");
  });

  it("keeps every write when the work returns", () => {
    inTransaction(db, () => {
      db.exec("INSERT INTO t VALUES (1)");
      db.exec("INSERT INTO t VALUES (2)");
    });

    expect(rows()).toEqual([1, 2]);
  });

  it("undoes every write and raises the work's error when the work throws", () => {
    const failure = new Error("second write refused");

    expect(() =>
      inTransaction(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        throw failure;
      }),
    ).toThrow(failure);
    expect(rows()).toEqual([]);
  });

  it("raises the work's error, not the rollback's, when SQLite has already rolled back", () => {
    // A full disk makes SQLite roll back by itself, after which a ROLLBACK fails with "no transaction is active".
    const failure = new Error("database or disk is full");

    expect(() =>
      inTransaction(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        db.exec("ROLLBACK");
        throw failure;
      }),
    ).toThrow(failure);
    expect(rows()).toEqual([]);
    inTransaction(db, () => db.exec("INSERT INTO t VALUES (3)"));
    expect(rows()).toEqual([3]);
  });
});
