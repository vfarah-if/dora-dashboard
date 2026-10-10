import type { CodeHealthFailure, CodeHealthFailureReason, CodeSnapshot } from "@dora-dashboard/core";
import type { RepoStore } from "../interfaces/repo-store.js";

export const ANALYSIS_OFF = "Code analysis is switched off. Remove CODE_ANALYSIS=off and crawl again to enable it.";

export const ANALYSER_MISSING =
  "Code analysis needs lizard, which the API cannot find on its PATH. Install it (see Code health in the README), restart the API if it was already running, and crawl again.";

/** Snapshots store only the message, so the reason is recovered from the messages the code health service writes itself. */
const reasonOf = (message: string): CodeHealthFailureReason =>
  message === ANALYSER_MISSING ? "analyser-missing" : message === ANALYSIS_OFF ? "analysis-off" : "failed";

export const codeFailure = (message: string, analysedAt: string): CodeHealthFailure => ({
  message,
  analysedAt,
  reason: reasonOf(message),
});

/** Which code snapshot a report is built from, and what to say about a newer attempt that failed. */
export type CodeSnapshotState =
  | { status: "none" }
  /** No analysis has ever succeeded; `failure` describes the latest attempt. */
  | { status: "error"; failure: CodeHealthFailure }
  /** `good` is the newest successful snapshot; `lastError` is set when a newer attempt failed. */
  | { status: "ok"; good: CodeSnapshot; lastError?: CodeHealthFailure };

/** The last successful snapshot with `lastError` when a newer attempt failed; `error` only if none ever succeeded. */
export function codeSnapshotState(store: RepoStore, repoId: number): CodeSnapshotState {
  const latest = store.latestCodeSnapshot(repoId);
  if (!latest) return { status: "none" };
  const good = store.latestSuccessfulCodeSnapshot(repoId);
  if (!good) return { status: "error", failure: codeFailure(latest.error ?? "Unknown error", latest.analysedAt) };
  return latest.error ? { status: "ok", good, lastError: codeFailure(latest.error, latest.analysedAt) } : { status: "ok", good };
}
