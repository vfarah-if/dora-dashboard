import type { RepoIssue } from "@dora-dashboard/core";

/** Where an issue read resumes: both are null on the first page of a full read, and `updatedSince` is null for one that wants every issue. */
export interface IssuePageRequest {
  /** Return at least every issue updated at or after this instant (ISO 8601), or all issues when null. */
  updatedSince: string | null;
  /** The `nextCursor` of the previous page, or null for the first. */
  cursor: string | null;
}

/** One page of a repository's issues, most recently updated first. */
export interface IssuePage {
  /** False when the repository has issues switched off; `items` is then empty. */
  enabled: boolean;
  items: RepoIssue[];
  /** How many issues the host holds that match the request, for progress text. */
  totalCount: number;
  /** Opaque cursor for the next page, or null on the last page. */
  nextCursor: string | null;
}

/**
 * The issue tracker that lives on a code host, such as GitHub Issues. It is read with the token the crawl already
 * holds, so it is a different port from `WorkItemProvider`, which is shaped by sites, spaces and per-person grants
 * (ADR 0003).
 *
 * Contract every implementation must honour, because the crawl service relies on it:
 * - `fetchIssuePage` takes `{ updatedSince, cursor }` as one object, so the two cannot be swapped. It returns at
 *   least every issue updated at or after `updatedSince` (all when null), ordered by `updatedAt` descending, so the
 *   incremental crawl can stop at the first page holding nothing newer. Pull requests are never issues.
 * - Issues switched off for the repository answer `{ enabled: false, items: [], totalCount: 0, nextCursor: null }`.
 *   This never raises, so a repository without issues does not fail its crawl.
 * - A closed issue carries a `closeReason`, `completed` when the host recorded none. Each issue's `events` are its
 *   closes and reopens, oldest first, and `eventsTruncated` says when the host held more than were read.
 * - Pull requests that close an issue are qualified by their repository (`closedBy`), so two repositories' #12 never meet.
 * - A rejected credential (HTTP 401) raises `UnauthorisedError`. A repository that is missing, or that the credential
 *   cannot see, raises `NotFoundError`, never an empty page. On GitHub that is HTTP 404, or `data.repository` null
 *   together with a GraphQL error of type `NOT_FOUND` on the `repository` path, or no repository and no errors at all.
 *   Any other GraphQL `errors` raise `UpstreamError`, including a rate limit, which also arrives with a null
 *   repository and must not be reported as not found. A 502 or 504 is retried once with a smaller page; any other
 *   failure raises `UpstreamError`. No message ever carries the token.
 */
export interface IssueProvider {
  readonly kind: string;
  fetchIssuePage(token: string, owner: string, name: string, request: IssuePageRequest): Promise<IssuePage>;
}
