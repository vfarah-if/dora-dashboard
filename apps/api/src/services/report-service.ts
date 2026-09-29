import { buildReport, type RepoReport, type ReportOptions } from "@dora-dashboard/core";
import { NotFoundError, ValidationError } from "../core/errors.js";
import type { RepoStore } from "../interfaces/repo-store.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ReportService {
  constructor(private readonly store: RepoStore) {}

  report(repoId: number, options: ReportOptions = {}): RepoReport {
    validate(options);
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

function validate(options: ReportOptions): void {
  for (const key of ["from", "to"] as const) {
    const value = options[key];
    if (value !== undefined && !DATE.test(value)) throw new ValidationError(`${key} must be a date as YYYY-MM-DD`);
  }
  if (options.from && options.to && options.from > options.to) throw new ValidationError("from must not be after to");
}
