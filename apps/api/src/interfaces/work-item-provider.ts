import type { BoardAccess, BoardColumn, TrackerSite, TrackerSpaceSummary, TrackerStatus, WorkItem } from "@dora-dashboard/core";

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

/** A space's board as read: its columns, and `board` saying why they are empty when they are (see `BoardAccess`). */
export interface BoardRead {
  board: BoardAccess;
  columns: BoardColumn[];
}

/** Where a work item read resumes: both are null on the first page of a full read, and `updatedSince` is null for one that wants every item. */
export interface WorkItemPageRequest {
  /** Return at least every item updated at or after this instant (ISO 8601), or all items when null. */
  updatedSince: string | null;
  /** The `nextCursor` of the previous page, or null for the first. */
  cursor: string | null;
}

/**
 * An issue tracker the dashboard can crawl. Jira Cloud is the first implementation (ADR 0020); a
 * Jira Data Center or Linear adapter would implement the same port so services never learn which
 * tracker they are reading.
 *
 * Contract every implementation must honour, because the crawl service relies on it:
 * - `fetchWorkItemPage` takes `{ updatedSince, cursor }` as one object, so the two cannot be swapped. It returns at
 *   least every item updated at or after `updatedSince` (all when null), ordered by
 *   `updatedAt` descending. Each item's history starts with an entry at its creation for the status it was created in
 *   (from null), followed by every status change, oldest first.
 * - Each item's `level` comes from the issue type's hierarchy level, and is left unset when the tracker does not say.
 * - `fetchBoardColumns` never raises for a missing or refused board. It answers `{ board: "none", columns: [] }` when
 *   the space has no board, and `{ board: "forbidden", columns: [] }` when the tracker refuses the board (a missing
 *   scope or a board the person cannot see), so the two are never confused; `"read"` carries the columns.
 * - A site or space that does not exist or is not visible raises `NotFoundError`, never an empty result. A refusal
 *   (HTTP 403) raises `AccessRefusedError`, whose message says the account may lack permission or the app a scope;
 *   no message ever carries the token.
 * - A 429 is retried once after the wait Jira asks for; a second 429 raises `RateLimitedError`.
 * - A rejected or expired credential raises `UnauthorisedError`, with the tracker's reason appended. Jira answers a
 *   token that lacks a scope with a 401 saying "scope does not match"; no new connection can cure that, so it raises
 *   `AccessRefusedError` (the app lacks a scope) and the grant is kept. Any other failure raises `UpstreamError`.
 */
export interface WorkItemProvider {
  readonly kind: string;
  listSites(token: string): Promise<TrackerSite[]>;
  listSpaces(token: string, siteId: string): Promise<TrackerSpaceSummary[]>;
  fetchStatuses(token: string, siteId: string, spaceKey: string): Promise<TrackerStatus[]>;
  fetchBoardColumns(token: string, siteId: string, spaceKey: string): Promise<BoardRead>;
  fetchWorkItemPage(token: string, siteId: string, spaceKey: string, request: WorkItemPageRequest): Promise<WorkItemPage>;
}
