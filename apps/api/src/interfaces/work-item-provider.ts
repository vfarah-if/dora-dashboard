import type { BoardColumn, TrackerSite, TrackerSpaceSummary, TrackerStatus, WorkItem } from "@dora-dashboard/core";

/** One page of work items, most recently updated first. */
export interface WorkItemPage {
  items: WorkItem[];
  /** Opaque cursor for the next page, or null on the last page. */
  nextCursor: string | null;
  /**
   * Display names by account id for the assignees on this page. Kept off `WorkItem` so names travel separately
   * and are shown only behind the "Show people" toggle (ADR 0008). Never carries an email address.
   */
  people: Record<string, string>;
}

/**
 * An issue tracker the dashboard can crawl. Jira Cloud is the first implementation (ADR 0020); a
 * Jira Data Center or Linear adapter would implement the same port so services never learn which
 * tracker they are reading.
 *
 * Contract every implementation must honour, because the crawl service relies on it:
 * - `fetchWorkItemPage` returns at least every item updated at or after `updatedSince` (all when null), ordered by
 *   `updatedAt` descending. Each item's history starts with an entry at its creation for the status it was created in
 *   (from null), followed by every status change, oldest first.
 * - Each item's `level` comes from the issue type's hierarchy level, and is left unset when the tracker does not say.
 * - `fetchBoardColumns` returns an empty list when the space has no board, never an error.
 * - A site or space the credential cannot see raises `NotFoundError`, never an empty result. A 403 raises it too,
 *   with a message saying the space cannot be seen or the app lacks a scope; no message ever carries the token.
 * - A 429 is retried once after the wait Jira asks for; a second 429 raises `RateLimitedError`.
 * - A rejected or expired credential raises `UnauthorisedError`; any other failure raises `UpstreamError`.
 */
export interface WorkItemProvider {
  readonly kind: string;
  listSites(token: string): Promise<TrackerSite[]>;
  listSpaces(token: string, siteId: string): Promise<TrackerSpaceSummary[]>;
  fetchStatuses(token: string, siteId: string, spaceKey: string): Promise<TrackerStatus[]>;
  fetchBoardColumns(token: string, siteId: string, spaceKey: string): Promise<BoardColumn[]>;
  fetchWorkItemPage(
    token: string,
    siteId: string,
    spaceKey: string,
    updatedSince: string | null,
    cursor: string | null,
  ): Promise<WorkItemPage>;
}
