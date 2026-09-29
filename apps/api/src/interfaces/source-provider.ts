import type { DeployRun, PullRequest } from "@dora-dashboard/core";

/** One page of change requests, most recently updated first. */
export interface PullRequestPage {
  pullRequests: PullRequest[];
  totalCount: number;
  /** Opaque cursor for the next page, or null on the last page. */
  nextCursor: string | null;
}

export interface Viewer {
  login: string;
  avatarUrl: string;
}

/**
 * A code host the dashboard can crawl. GitHub is the first implementation; a GitLab or Bitbucket
 * provider implements the same port so services never learn which host they are reading.
 *
 * Contract every implementation must honour, because the crawl service relies on it:
 * - `fetchPullRequestPage` returns pages ordered by `updatedAt` descending, so an incremental
 *   crawl can stop at the first item no newer than the previous crawl.
 * - `fetchDeployRuns` returns every run of the named pipeline or workflow, any order.
 * - A repository the credential cannot see raises `NotFoundError`, never an empty page.
 */
export interface SourceProvider {
  readonly kind: string;
  fetchPullRequestPage(token: string, owner: string, name: string, cursor: string | null): Promise<PullRequestPage>;
  fetchDeployRuns(token: string, owner: string, name: string, workflow: string): Promise<DeployRun[]>;
  listWorkflows(token: string, owner: string, name: string): Promise<string[]>;
  fetchViewer(token: string): Promise<Viewer>;
}
