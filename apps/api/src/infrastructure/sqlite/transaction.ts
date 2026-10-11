import type { DatabaseSync } from "node:sqlite";

/**
 * Runs `work` in one transaction, committed when it returns and rolled back when it throws. SQLite rolls some failures
 * back by itself, such as a full disk, and a rollback after that fails too, so the error `work` threw is the one raised.
 */
export function inTransaction(db: DatabaseSync, work: () => void): void {
  db.exec("BEGIN");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nothing is left to roll back, and this failure would only hide the one that matters.
    }
    throw error;
  }
}
