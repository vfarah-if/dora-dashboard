import {
  codeDetail,
  prepareCodeDetail,
  type CodeDetailResponse,
  type CodeHealthFailure,
  type CodeSnapshot,
  type CoverageSnapshots,
  type PreparedCodeDetail,
} from "@dora-dashboard/core";
import { NotFoundError } from "../core/errors.js";
import type { RepoStore, SnapshotKeys } from "../interfaces/repo-store.js";
import { codeFailure } from "./code-snapshot-state.js";

/** How many repositories keep a prepared analysis in memory. */
export const PREPARED_MEMO_SIZE = 8;

interface Prepared {
  prepared: PreparedCodeDetail;
  lastError?: CodeHealthFailure;
}

/**
 * The detailed code analysis: the last good code snapshot broken down by area, with the last measured coverage.
 *
 * Reading and parsing the snapshots and finding the areas is the expensive part, and it does not depend on which area
 * is asked for. The result is kept in a small in-memory memo, one entry per repository, keyed by the timestamps of the
 * newest and the newest successful code snapshot and coverage read. Those are read with a query that loads no snapshot
 * data, so any new snapshot changes the key and the entry is rebuilt. The memo is never persisted: the rules run again
 * after a restart, which is what ADR 0013 asks for, and the area is applied to the prepared result on every request.
 */
export class CodeDetailService {
  /** Insertion order is recency order; a hit moves the entry to the end and the oldest is dropped when full. */
  private readonly memo = new Map<number, { key: string; value: Prepared }>();

  constructor(
    private readonly store: RepoStore,
    private readonly memoSize = PREPARED_MEMO_SIZE,
  ) {}

  /** `area` is a path from the report's own area list; one that is not in it falls back to the whole repository. */
  detail(repoId: number, area: string | null = null): CodeDetailResponse {
    if (!this.store.getRepo(repoId)) throw new NotFoundError(`Unknown repository ${repoId}`);
    const code = this.store.codeSnapshotKeys(repoId);
    if (code.latest === null) return { status: "none" };
    if (code.good === null) {
      const latest = this.store.latestCodeSnapshot(repoId);
      return latest
        ? { status: "error", ...codeFailure(latest.error ?? "Unknown error", latest.analysedAt) }
        : { status: "none" };
    }
    const coverage = this.store.coverageSnapshotKeys(repoId);
    const { prepared, lastError } = this.prepare(repoId, code, coverage);
    return codeDetail(prepared, { area, ...(lastError ? { lastError } : {}) });
  }

  private prepare(repoId: number, code: SnapshotKeys, coverage: SnapshotKeys): Prepared {
    const key = JSON.stringify([code.latest, code.good, coverage.latest, coverage.good]);
    const hit = this.memo.get(repoId);
    if (hit && hit.key === key) {
      this.memo.delete(repoId);
      this.memo.set(repoId, hit);
      return hit.value;
    }

    const good = this.store.latestSuccessfulCodeSnapshot(repoId);
    if (!good) throw new NotFoundError(`No code snapshot for repository ${repoId}`);
    const value = this.build(repoId, good, code, coverage);
    this.memo.delete(repoId);
    this.memo.set(repoId, { key, value });
    while (this.memo.size > this.memoSize) this.memo.delete(this.memo.keys().next().value!);
    return value;
  }

  private build(repoId: number, good: CodeSnapshot, code: SnapshotKeys, coverage: SnapshotKeys): Prepared {
    // When the newest snapshot is the good one it is already in hand and no newer attempt failed.
    const newer = code.latest === code.good ? null : this.store.latestCodeSnapshot(repoId);
    const lastError = newer?.error ? codeFailure(newer.error, newer.analysedAt) : undefined;
    const snapshots: CoverageSnapshots = { latest: null, good: null };
    if (coverage.latest !== null) {
      snapshots.good = coverage.good === null ? null : this.store.latestSuccessfulCoverageSnapshot(repoId);
      snapshots.latest = coverage.latest === coverage.good ? snapshots.good : this.store.latestCoverageSnapshot(repoId);
    }
    return { prepared: prepareCodeDetail(good, snapshots), ...(lastError ? { lastError } : {}) };
  }
}
