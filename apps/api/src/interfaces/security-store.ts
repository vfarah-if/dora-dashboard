import type {
  AlertOf,
  AlertSource,
  FindingAcceptance,
  HeldPosture,
  LockedPackage,
  ReadFailure,
  RepoPosture,
  ScorecardResult,
  SecurityAlert,
  SourceState,
  SupplyChainRecord,
} from "@dora-dashboard/core";

/** Timestamps that change whenever something a security report is built from changes, so a cache can tell. */
export interface SecurityKeys {
  /** Every source's last attempt and last read, joined. */
  sources: string;
  /** `readAt` of the supply chain record, or null when there is none. */
  supplyChain: string | null;
  posture: string | null;
  scorecard: string | null;
  /** The last failed clone inspection's time, or null when there is none. */
  supplyChainFailure: string | null;
  /**
   * How many acceptances are held and the highest id among the rows held. AUTOINCREMENT makes an accept raise that id and
   * a removal lowers the count, so the key changes on every accept and every removal.
   */
  acceptances: string;
}

/**
 * What is held about a repository's scorecard. `readAt` and `result` describe the last good read; `failure` the last
 * attempt, when it failed.
 */
export interface StoredScorecard {
  /** Null when no read has ever succeeded, or when the stored result could not be read, so the next crawl reads it again. */
  readAt: string | null;
  /** Null when the project was not in the scan, or nothing usable was read yet. Only a non-null `readAt` says which. */
  result: ScorecardResult | null;
  /** The last attempt's scrubbed message and time when it failed, cleared by the next good read. */
  failure: ReadFailure | null;
}

/** The readable alerts of a repository, and per source how many stored rows were left out as unreadable. */
export interface AlertScan {
  alerts: SecurityAlert[];
  unreadable: Record<AlertSource, number>;
}

/** The readable acceptances of a repository, and how many stored rows were left out as unreadable. */
export interface AcceptanceScan {
  acceptances: FindingAcceptance[];
  unreadable: number;
}

/**
 * How `saveSecurityAlerts` treats the source's alerts the read did not list. `merge` leaves them, for a read that
 * stopped short. `replace` removes them, for a read that saw everything the source holds.
 */
export type SaveMode = "merge" | "replace";

/**
 * Persistence for what the security crawl reads. `SqliteRepoStore` implements it beside `RepoStore`, so the services
 * that need only security data depend on this small port.
 *
 * - Alerts are keyed by repository, source and `key`. A save replaces by key and, only in `replace` mode, removes the
 *   source's alerts the read did not see, in one transaction. A merge therefore never erases alerts. A row that cannot
 *   be parsed or has an unknown shape is left out of `securityAlerts`, counted by `securityAlertScan` and logged, never
 *   thrown, and so is a stored source state, supply chain record, posture or scorecard result that cannot be read, which
 *   answers as not held.
 * - A source never read, or whose stored row is not in the current shape, answers `not_read`.
 * - `supplyChain` never loads the package list, which can be large; `lockedPackages` does.
 * - Acceptances are keyed by repository, check, path and fingerprint. A row that cannot be read is left out and logged
 *   once, which is the safe direction: the finding counts again. `acceptanceScan` also counts those rows, so the report
 *   can say that some were left out.
 * - Everything is removed with its repository.
 */
export interface SecurityStore {
  saveSecurityAlerts<S extends AlertSource>(repoId: number, source: S, alerts: readonly AlertOf<S>[], mode: SaveMode): void;
  /**
   * Removes the source's alerts, for a source the host says is switched off, or for OSV when the lookup is not used. A
   * source that is merely not accessible keeps them.
   */
  clearSecurityAlerts(repoId: number, source: AlertSource): void;
  /** Every stored alert of every source, ordered by source and then key. */
  securityAlerts(repoId: number): SecurityAlert[];
  /** The same alerts, with how many stored rows of each source were left out because they could not be read. */
  securityAlertScan(repoId: number): AlertScan;
  /** The stored alerts of one source, typed as that source's alerts. */
  securityAlertsOf<S extends AlertSource>(repoId: number, source: S): AlertOf<S>[];
  setSourceState(repoId: number, source: AlertSource, state: SourceState): void;
  sourceStates(repoId: number): Record<AlertSource, SourceState>;

  /** Replaces the repository's supply chain record and its public locked packages together. */
  saveSupplyChain(repoId: number, record: SupplyChainRecord, packages: readonly LockedPackage[]): void;
  supplyChain(repoId: number): SupplyChainRecord | null;
  /** Records that the latest clone inspection failed. The stored record is kept; the next good save clears the failure. */
  failSupplyChain(repoId: number, message: string, attemptedAt: string): void;
  supplyChainFailure(repoId: number): ReadFailure | null;
  lockedPackages(repoId: number): LockedPackage[];

  /** A good read, which also clears any earlier failure. */
  savePosture(repoId: number, posture: RepoPosture, readAt: string): void;
  /**
   * Records that a read failed. The last good posture and its read time are kept; the failure stays until the next good
   * read.
   */
  failPosture(repoId: number, message: string, attemptedAt: string): void;
  /** The last good posture; null when none was ever read, even if an attempt failed. */
  posture(repoId: number): HeldPosture | null;
  /** The last attempt's failure, or null when it succeeded or none was made. */
  postureFailure(repoId: number): ReadFailure | null;

  /**
   * `result` is null when the project is not in the scorecard's scan; the read time still says it was asked. A good read
   * clears any failure.
   */
  saveScorecard(repoId: number, readAt: string, result: ScorecardResult | null): void;
  /** Records a failed read against the scorecard, with its time. The last good result and read time are kept. */
  failScorecard(repoId: number, message: string, attemptedAt: string): void;
  scorecard(repoId: number): StoredScorecard | null;

  securityKeys(repoId: number): SecurityKeys;

  /** The repository's readable acceptances, oldest first. A path that is none is read back as null. */
  acceptances(repoId: number): FindingAcceptance[];
  /** The same acceptances, with how many stored rows were left out because they could not be read. */
  acceptanceScan(repoId: number): AcceptanceScan;
  /** Saves an acceptance and returns it with its id, or null when the same finding is already accepted. */
  saveAcceptance(repoId: number, acceptance: Omit<FindingAcceptance, "id">): FindingAcceptance | null;
  /** Removes one acceptance of this repository; false when it holds none with that id. */
  deleteAcceptance(repoId: number, id: number): boolean;
}
