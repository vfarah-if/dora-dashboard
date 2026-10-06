import { buildSpaceReport, type SpaceReport } from "@dora-dashboard/core";
import { NotFoundError } from "../core/errors.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import { validateDateRange } from "./date-range.js";

/** What a caller asks of a space report; core's SpaceReportOptions adds the instant it is built at. */
export interface SpaceReportQuery {
  from?: string;
  to?: string;
  /** Include assignee display names in the findings. Off unless asked for (ADR 0008). */
  people?: boolean;
}

/** Builds the delivery report for a tracked space from what is stored; no arithmetic here, that is core's (ADR 0021). */
export class SpaceReportService {
  constructor(
    private readonly store: RepoStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  report(spaceId: number, options: SpaceReportQuery = {}): SpaceReport {
    validateDateRange(options);
    const space = this.store.getSpace(spaceId);
    if (!space) throw new NotFoundError(`Unknown space ${spaceId}`);
    const linked = this.store.reposForSpace(spaceId).map((repo) => ({
      repo: { id: repo.id, owner: repo.owner, name: repo.name, deployBranch: repo.deployBranch },
      prs: this.store.pullRequests(repo.id),
      runs: this.store.deployRuns(repo.id),
    }));
    return buildSpaceReport(space, this.store.workItems(spaceId), linked, {
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
      now: this.clock().toISOString(),
      people: options.people === true,
    });
  }
}
