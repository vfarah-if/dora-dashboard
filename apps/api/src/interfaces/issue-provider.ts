import type { RepoIssue } from "@dora-dashboard/core";

/**
 * Where an issue read resumes: both are null on the first page of a full read, and `updatedSince` is null for one that
 * wants every issue.
 */
export interface IssuePageRequest {
  /** Return at least every issue updated at or after this instant (ISO 8601), or all issues when null. */
  updatedSince: string | null;
  /** The `nextCursor` of the previous page, or null for the first. */
  cursor: string | null;
}

/** One page of a repository's issues, most recently updated first; `enabled` is false when issues are switched off. */
export type IssuePage =
  | { enabled: false }
  | {
      enabled: true;
      items: RepoIssue[];
      /** How many issues the host holds that match the request, for progress text. */
      totalCount: number;
      /** Opaque cursor for the next page, or null on the last page. */
      nextCursor: string | null;
    };

/**
 * The issue tracker that lives on a code host, such as GitHub Issues. It is read with the token the crawl already
 * holds, so it is a different port from `WorkItemProvider`, which is shaped by sites, spaces and per-person grants
 * (ADR 0003, ADR 0028).
 *
 * Contract every implementation must honour, because the crawl service relies on it:
 * - `fetchIssuePage` takes `{ updatedSince, cursor }` as one object, so the two cannot be swapped. It returns at
 *   least every issue updated at or after `updatedSince` (all when null), ordered by `updatedAt` descending, so the
 *   incremental crawl can stop at the first page holding nothing newer. Pull requests are never issues.
 * - A repository with issues switched off answers `{ enabled: false }`. This never raises, so a repository without
 *   issues does not fail its crawl.
 * - A closed issue carries a `closeReason` and a `closedAt`. Each issue's `events` are its closes and reopens, oldest
 *   first, and `eventsTruncated` says when the host held more than were read.
 * - Pull requests that close an issue are qualified by their repository (`closedBy`), so two repositories' #12 never
 *   meet.
 * - A rejected credential raises `UnauthorisedError`. A repository that is missing, or that the credential cannot see,
 *   raises `NotFoundError`. A response with no issues list raises `UpstreamError`, never an empty page. Any other
 *   failure raises `UpstreamError`. No message ever carries the token.
 */
export interface IssueProvider {
  readonly kind: string;
  fetchIssuePage(token: string, owner: string, name: string, request: IssuePageRequest): Promise<IssuePage>;
}
