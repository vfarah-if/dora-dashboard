import { buildIssueReport, type IssueReport, type IssueReportOptions } from "@dora-dashboard/core";
import { NotFoundError } from "../core/errors.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import { dayOf, validateDateRange } from "./date-range.js";

/**
 * What a caller asks of an issue report: core's options without the instant it is built at, which the clock gives, and
 * the labels, which the repository holds.
 */
export type IssueReportQuery = Omit<IssueReportOptions, "now" | "labels">;

/**
 * Builds the GitHub Issues report for a repository from what is stored; no arithmetic here, that is core's
 * (ADR 0028).
 */
export class IssueReportService {
  constructor(
    private readonly store: RepoStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  report(repoId: number, options: IssueReportQuery = {}): IssueReport {
    const now = this.clock();
    validateDateRange(options, dayOf(now));
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new NotFoundError(`Unknown repository ${repoId}`);
    return buildIssueReport(repo, this.store.issues(repoId), this.store.pullRequests(repoId), this.store.deployRuns(repoId), {
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
      now: now.toISOString(),
      people: options.people === true,
      labels: this.store.issueState(repoId).labels,
    });
  }
}
