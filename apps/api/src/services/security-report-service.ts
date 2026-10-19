import {
  ALERT_SOURCES,
  BAND_RANK,
  DAY_MS,
  securityReport,
  securitySummary,
  type AlertSource,
  type Repo,
  type ScorecardState,
  type SecurityReport,
  type SecuritySummary,
  type SourceState,
} from "@dora-dashboard/core";
import { NotFoundError } from "../core/errors.js";
import { noopLogger, type Logger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SecurityStore, StoredScorecard } from "../interfaces/security-store.js";
import { rulesOf } from "./saved-override.js";
import { dayOf, validateDateRange } from "./date-range.js";

/**
 * The days back from today of the range each summary's report is built for. No field of a summary follows a range, so
 * this is not a window the list page shows and changing it changes none of its figures.
 */
export const SUMMARY_WINDOW_DAYS = 90;

export interface SecurityReportQuery {
  from?: string | undefined;
  to?: string | undefined;
}

/** What the report service needs to know about how the app is wired, so stored data is described honestly. */
export interface SecurityReportOptions {
  /** Whether code analysis is on, which decides why supply chain facts might be missing. */
  codeAnalysis: boolean;
  /** Whether a Scorecard source is wired. Without one the report says Scorecard is off. */
  scorecardLookup: boolean;
  /**
   * The host's page where an administrator switches security features on, from the alert source's own port. Empty
   * when no source is wired, so the report names no host it knows nothing about and the page shows no link.
   */
  settingsUrl: (owner: string, name: string) => string;
  /**
   * The host's page for a file at the commit the clone was read from, from the alert source's own port. Null when no
   * source is wired or the host builds none, so a finding is shown without a link.
   */
  fileUrl: (owner: string, name: string, commitSha: string, path: string, line: number | null) => string | null;
}

/**
 * Builds security reports from what the crawl stored, so they work whether or not anything is wired. No arithmetic
 * here: the grade, the actions and every figure come from core (ADR 0033).
 */
export class SecurityReportService {
  /** One summary per repository, rebuilt when its key changes. Entries for deleted repositories are dropped in `summaries`. */
  private readonly memo = new Map<number, { key: string; summary: SecuritySummary }>();

  constructor(
    private readonly store: RepoStore,
    private readonly securityStore: SecurityStore,
    private readonly options: SecurityReportOptions,
    private readonly clock: () => Date = () => new Date(),
    private readonly log: Logger = noopLogger,
  ) {}

  report(repoId: number, query: SecurityReportQuery = {}): SecurityReport {
    const now = this.clock();
    validateDateRange(query, dayOf(now));
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new NotFoundError(`Unknown repository ${repoId}`);
    return this.build(repo, query, now, false);
  }

  /** Every repository's summary, or those of `ids`, worst first with ungraded last. */
  summaries(ids?: readonly number[]): SecuritySummary[] {
    const now = this.clock();
    const repos = ids ? [...new Set(ids)].map((id) => this.existing(id)) : this.store.listRepos();
    const rows = repos.map((repo) => this.summary(repo, now));
    for (const id of [...this.memo.keys()]) if (!this.store.getRepo(id)) this.memo.delete(id);
    return rows.sort(compareSummaries);
  }

  private existing(id: number): Repo {
    const repo = this.store.getRepo(id);
    if (!repo) throw new NotFoundError(`Unknown repository ${id}`);
    return repo;
  }

  /** Rebuilt only when the crawl, a stored security part or the hour changes; the crawl status is always the live one. */
  private summary(repo: Repo, now: Date): SecuritySummary {
    const key = JSON.stringify([
      repo.lastCrawledAt,
      repo.deployBranch,
      this.securityStore.securityKeys(repo.id),
      now.toISOString().slice(0, 13),
    ]);
    const hit = this.memo.get(repo.id);
    if (hit && hit.key === key) return { ...hit.summary, repo: { ...hit.summary.repo, crawlStatus: repo.crawlStatus } };
    const from = dayOf(new Date(now.getTime() - SUMMARY_WINDOW_DAYS * DAY_MS));
    const summary = securitySummary(this.build(repo, { from, to: dayOf(now) }, now, true), repo.crawlStatus);
    this.memo.set(repo.id, { key, summary });
    return summary;
  }

  /**
   * `lenient` is for the list, where one repository's unreadable pull request or issue row must not fail every row (F8).
   * Only the stale update count and the issue figures read those, so the repository is still graded from its alerts and
   * the fault is logged. The repository's own report is not lenient, so its page says something is wrong.
   */
  private build(repo: Repo, query: SecurityReportQuery, now: Date, lenient: boolean): SecurityReport {
    const { securityStore, options } = this;
    const pullRequests = lenient
      ? this.tolerate(repo, "pull requests", () => this.store.pullRequests(repo.id), [])
      : this.store.pullRequests(repo.id);
    const issues = lenient ? this.tolerate(repo, "issues", () => this.store.issues(repo.id), null) : this.store.issues(repo.id);
    const supplyChain = securityStore.supplyChain(repo.id);
    const posture = securityStore.posture(repo.id);
    const scorecard = securityStore.scorecard(repo.id);
    const { alerts, unreadable } = securityStore.securityAlertScan(repo.id);
    const held = securityStore.acceptanceScan(repo.id);
    const sources = withUnreadable(securityStore.sourceStates(repo.id), unreadable);
    const shown = this.scorecardOf(posture?.value.visibility ?? null, scorecard);
    return securityReport(
      {
        repo,
        alerts,
        sources,
        ...(supplyChain
          ? { supplyChain, supplyChainMissing: null }
          : { supplyChain: null, supplyChainMissing: options.codeAnalysis ? "not_read" : "analysis_off" }),
        pullRequests,
        settingsUrl: options.settingsUrl(repo.owner, repo.name),
        fileUrl: (commitSha, path, line) => options.fileUrl(repo.owner, repo.name, commitSha, path, line),
        acceptances: held.acceptances,
        unreadableAcceptances: held.unreadable,
        posture,
        postureFailure: securityStore.postureFailure(repo.id),
        supplyChainFailure: securityStore.supplyChainFailure(repo.id),
        scorecard: shown,
        issues,
        issueLabels: rulesOf(this.store.issueState(repo.id).labels),
      },
      {
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        now: now.toISOString(),
      },
    );
  }

  private tolerate<T>(repo: Repo, what: string, read: () => T, fallback: T): T {
    try {
      return read();
    } catch (err) {
      this.log.error(
        { err, repoId: repo.id },
        `the stored ${what} of a repository could not be read; building its summary without them`,
      );
      return fallback;
    }
  }

  /**
   * What the Scorecard panel shows. A repository that is not known to be public is never looked up, and one whose
   * visibility is unread is not looked up (ADR 0035), so any stored result is not shown unless the current posture says
   * `public`. Unread visibility is `not_read`, because calling the repository not public would contradict the posture
   * failure shown beside it. A failed read shows `error`, with its message and the last good result beside it, until the
   * next good read. Nothing held, or a stored result that could not be read, is `not_read`, and only a lookup that found
   * the project absent from the scan is `not_scanned`.
   */
  private scorecardOf(visibility: "public" | "private" | "internal" | null, held: StoredScorecard | null): ScorecardState {
    if (!this.options.scorecardLookup) return { status: "off" };
    if (visibility === null) return { status: "not_read" };
    if (visibility !== "public") return { status: "not_public" };
    if (held === null) return { status: "not_read" };
    if (held.failure) return { status: "error", ...held.failure, lastGood: held.result };
    if (held.readAt === null) return { status: "not_read" };
    if (held.result) return { status: "ok", result: held.result };
    return { status: "not_scanned" };
  }
}

/**
 * The source states with the stored alerts that could not be read added to each read's `skipped` count, so the page says
 * that some alerts are missing from the figures in the way it does for alerts the host listed that could not be mapped.
 * Only a state whose alerts are in use is changed, because the others show no figures.
 */
function withUnreadable(
  states: Record<AlertSource, SourceState>,
  unreadable: Record<AlertSource, number>,
): Record<AlertSource, SourceState> {
  const next = { ...states };
  for (const source of ALERT_SOURCES) {
    const state = states[source];
    const missing = unreadable[source];
    if (missing === 0) continue;
    if (state.status === "ok") next[source] = { ...state, skipped: state.skipped + missing };
    else if (state.status === "error" && state.lastGood) {
      next[source] = { ...state, lastGood: { ...state.lastGood, skipped: state.lastGood.skipped + missing } };
    }
  }
  return next;
}

/** Worst band first, ungraded last; then past fix-by, open critical and open high, most first; then by name. */
function compareSummaries(a: SecuritySummary, b: SecuritySummary): number {
  const rank = (s: SecuritySummary) => (s.band === null ? Object.keys(BAND_RANK).length : BAND_RANK[s.band]);
  return (
    rank(a) - rank(b) ||
    b.pastFix - a.pastFix ||
    b.open.critical - a.open.critical ||
    b.open.high - a.open.high ||
    a.repo.owner.localeCompare(b.repo.owner) ||
    a.repo.name.localeCompare(b.repo.name)
  );
}

/** A one-line account of a repository's security for the terminal, such as after a crawl from the command line. */
export function describeSecurity(summary: SecuritySummary): string {
  if (summary.band === null) {
    return summary.gradeMissing === "not_crawled"
      ? "security: not graded, the repository has not been crawled"
      : "security: not graded, nothing could be measured yet";
  }
  const { critical, high } = summary.open;
  const failed = summary.failed ? ", with at least one source that could not be read" : "";
  return `security: ${summary.band} band, ${critical} critical and ${high} high alerts open, ${summary.pastFix} past their fix-by date${failed}`;
}
