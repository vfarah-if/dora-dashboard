import type { BoardColumn, StatusCategory, TrackerSpaceSummary, TrackerStatus } from "@dora-dashboard/core";

/** The most spaces the API accepts in one link request. */
export const MAX_LINKED_SPACES = 20;

/** The code the API puts in `error` when the Jira grant is missing or has lapsed. */
export const JIRA_UNAUTHORISED = "jira_unauthorised";

export const CATEGORY_ORDER: readonly StatusCategory[] = ["todo", "in_progress", "done"];

/** Spaces whose name or key contains the search text, ignoring case and surrounding spaces. Order is kept. */
export function filterSpaces<T extends Pick<TrackerSpaceSummary, "key" | "name">>(spaces: readonly T[], search: string): T[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...spaces];
  return spaces.filter((s) => s.name.toLowerCase().includes(needle) || s.key.toLowerCase().includes(needle));
}

export interface StatusGroup {
  category: StatusCategory;
  statuses: TrackerStatus[];
}

/** Statuses grouped by category in workflow order (to do, in progress, done). Empty categories are left out. */
export function groupStatusesByCategory(statuses: readonly TrackerStatus[]): StatusGroup[] {
  return CATEGORY_ORDER.map((category) => ({ category, statuses: statuses.filter((s) => s.category === category) })).filter(
    (group) => group.statuses.length > 0,
  );
}

export interface NamedColumn {
  name: string;
  statuses: TrackerStatus[];
}

/** Board columns with each status id replaced by its status. Ids the space no longer has are dropped. */
export function columnsWithStatuses(columns: readonly BoardColumn[], statuses: readonly TrackerStatus[]): NamedColumn[] {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return columns.map((column) => ({
    name: column.name,
    statuses: column.statusIds.flatMap((id) => {
      const status = byId.get(id);
      return status ? [status] : [];
    }),
  }));
}

/** The keys of the spaces already linked on one site. */
export function linkedKeysForSite(linked: readonly { siteId: string; key: string }[], siteId: string): string[] {
  return linked.filter((s) => s.siteId === siteId).map((s) => s.key);
}

/** Adds or removes a key, keeping the order of selection. */
export function toggleKey(keys: readonly string[], key: string, on: boolean): string[] {
  const others = keys.filter((k) => k !== key);
  return on ? [...others, key] : others;
}

/** The longest `returnTo` the API accepts. */
const MAX_RETURN_TO = 200;

/**
 * True when the API's `returnTo` rule would accept the value: a path on this site, no longer than 200 characters,
 * not starting `//` or `/\\`, and holding no whitespace, control character or backslash.
 */
export function isAcceptedReturnTo(value: string): boolean {
  if (value.length > MAX_RETURN_TO || !value.startsWith("/")) return false;
  if (value[1] === "/" || value[1] === "\\") return false;
  return !/[\s\\]/.test(value) && ![...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
}

/** A page's path and query to come back to, without the `jira` outcome a previous attempt left in it. */
export function returnPath(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("jira");
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * The sign-in link for Jira. `returnTo` is where to come back to. When the whole value would be refused by the API
 * the path alone is sent, and when that would be refused too, the root, so the person never meets a raw error.
 */
export function jiraConnectUrl(returnTo: string): string {
  const path = returnTo.split("?")[0]!;
  const safe = [returnTo, path].find(isAcceptedReturnTo) ?? "/";
  return `/api/auth/jira/start?returnTo=${encodeURIComponent(safe)}`;
}

/** True when an error is the API saying the Jira grant is missing or expired. */
export function isJiraUnauthorised(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 401 &&
    (error as { message?: unknown }).message === JIRA_UNAUTHORISED
  );
}

/** True when the API refused a crawl because that space is already being crawled. */
export function isCrawlConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 409;
}
