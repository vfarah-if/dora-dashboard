import {
  BAND_RANK,
  DAY_MS,
  securityReport,
  securitySummary,
  type Repo,
  type ScorecardResult,
  type ScorecardStatus,
  type SecurityReport,
  type SecuritySummary,
} from "@dora-dashboard/core";
import { NotFoundError } from "../core/errors.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SecurityStore, StoredScorecard } from "../interfaces/security-store.js";
import { dayOf, validateDateRange } from "./date-range.js";

/** The list page's window: this many days back from today. */
export const SUMMARY_WINDOW_DAYS = 90;

/** The page where GitHub lets an administrator switch its security features on; used when no alert source is wired. */
export const githubSettingsUrl = (owner: string, name: string): string =>
  `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/settings/security_analysis`;

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
  settingsUrl?: (owner: string, name: string) => string;
}

/**
 * Builds security reports from what the crawl stored, so they work whether or not anything is wired. No arithmetic
 * here: the grade, the actions and every figure come from core (ADR 0033).
 */
export class SecurityReportService {
  /** Insertion order is recency order, as in `CodeDetailService`. */
  private readonly memo = new Map<number, { key: string; summary: SecuritySummary }>();

  constructor(
    private readonly store: RepoStore,
    private readonly securityStore: SecurityStore,
    private readonly options: SecurityReportOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  report(repoId: number, query: SecurityReportQuery = {}): SecurityReport {
    const now = this.clock();
    validateDateRange(query, dayOf(now));
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new NotFoundError(`Unknown repository ${repoId}`);
    return this.build(repo, query, now);
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
    const summary = securitySummary(this.build(repo, { from, to: dayOf(now) }, now), repo.crawlStatus);
    this.memo.set(repo.id, { key, summary });
    return summary;
  }

  private build(repo: Repo, query: SecurityReportQuery, now: Date): SecurityReport {
    const { securityStore, options } = this;
    const supplyChain = securityStore.supplyChain(repo.id);
    const posture = securityStore.posture(repo.id);
    const scorecard = securityStore.scorecard(repo.id);
    const shown = this.scorecardOf(posture?.posture.visibility ?? null, scorecard);
    return securityReport(
      {
        repo,
        alerts: securityStore.securityAlerts(repo.id),
        sources: securityStore.sourceStates(repo.id),
        supplyChain,
        supplyChainMissing: supplyChain ? null : options.codeAnalysis ? "not_read" : "analysis_off",
        pullRequests: this.store.pullRequests(repo.id),
        settingsUrl: (options.settingsUrl ?? githubSettingsUrl)(repo.owner, repo.name),
        posture: posture?.posture ?? null,
        postureReadAt: posture?.readAt ?? null,
        postureError: securityStore.postureFailure(repo.id)?.error ?? null,
        scorecard: shown.result,
        scorecardStatus: shown.status,
        issues: this.store.issues(repo.id),
        issueLabels: this.store.issueState(repo.id).labels,
      },
      {
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        now: now.toISOString(),
      },
    );
  }

  /**
   * What the Scorecard panel shows. A repository that is not known to be public is never looked up, and one whose
   * visibility is unread counts as not public (ADR 0035), so any stored result is not shown unless the current posture
   * says `public`. A failed read shows `error` until the next good one, with the last good result beside it.
   */
  private scorecardOf(
    visibility: "public" | "private" | "internal" | null,
    held: StoredScorecard | null,
  ): { status: ScorecardStatus; result: ScorecardResult | null } {
    if (!this.options.scorecardLookup) return { status: "off", result: null };
    if (visibility !== "public") return { status: "not_public", result: null };
    if (held?.error) return { status: "error", result: held.result };
    if (held?.result) return { status: "ok", result: held.result };
    return { status: "not_scanned", result: null };
  }
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
