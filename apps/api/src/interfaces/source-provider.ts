import type { DeployRun, OpenPullRequest, PullRequest } from "@dora-dashboard/core";

/** One page of change requests, most recently updated first. */
export interface PullRequestPage {
  pullRequests: PullRequest[];
  totalCount: number;
  /** Opaque cursor for the next page, or null on the last page. */
  nextCursor: string | null;
}

/** Open change requests, most recently updated first when the host can order them. */
export interface OpenPullRequestsResult {
  pullRequests: OpenPullRequest[];
  /** True when the host has more open change requests than were read, so the list is only the most recently updated. */
  truncated: boolean;
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
 * - `fetchOpenPullRequests` returns open change requests read live, most recently updated first, and says when it stopped
 *   before the last one.
 * - A repository the credential cannot see raises `NotFoundError`, never an empty page.
 */
export interface SourceProvider {
  readonly kind: string;
  fetchPullRequestPage(token: string, owner: string, name: string, cursor: string | null): Promise<PullRequestPage>;
  fetchOpenPullRequests(token: string, owner: string, name: string): Promise<OpenPullRequestsResult>;
  fetchDeployRuns(token: string, owner: string, name: string, workflow: string): Promise<DeployRun[]>;
  listWorkflows(token: string, owner: string, name: string): Promise<string[]>;
  fetchViewer(token: string): Promise<Viewer>;
}
