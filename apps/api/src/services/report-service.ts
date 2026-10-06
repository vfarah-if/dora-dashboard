import { buildReport, type RepoReport, type ReportOptions } from "@dora-dashboard/core";
import { NotFoundError, ValidationError } from "../core/errors.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import { dayOf, validateDateRange } from "./date-range.js";

export class ReportService {
  constructor(
    private readonly store: RepoStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  report(repoId: number, options: ReportOptions = {}): RepoReport {
    validateDateRange(options, dayOf(this.clock()));
    const repo = this.store.getRepo(repoId);
    if (!repo) throw new NotFoundError(`Unknown repository ${repoId}`);
    return buildReport(repo, this.store.pullRequests(repo.id), this.store.deployRuns(repo.id), options);
  }

  /** One report per repository over the same range, in the order asked for; unknown ids are an error. */
  compare(repoIds: number[], options: ReportOptions = {}): RepoReport[] {
    if (repoIds.length < 1) throw new ValidationError("Choose at least one repository to compare");
    return repoIds.map((id) => this.report(id, options));
  }
}
