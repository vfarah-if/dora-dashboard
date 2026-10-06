import type {
  BoardAccess,
  StatusCategory,
  TrackerSite,
  TrackerSpaceSummary,
  TrackerStatus,
  WorkItem,
  WorkItemLevel,
  WorkItemTransition,
} from "@dora-dashboard/core";
import {
  AccessRefusedError,
  NotFoundError,
  RateLimitedError,
  UnauthorisedError,
  UpstreamError,
  ValidationError,
} from "../../core/errors.js";
import type { BoardRead, WorkItemPage, WorkItemPageRequest, WorkItemProvider } from "../../interfaces/work-item-provider.js";

const PAGE_SIZE = 50;
const SPACE_PAGE_SIZE = 50;
const DEFAULT_RETRY_SECONDS = 1;
const MAX_RETRY_SECONDS = 30;
const MAX_REASON_LENGTH = 200;
const DAY_MS = 86_400_000;
/** How long a space's status categories are reused, so one crawl asks Jira for them once rather than per page. */
export const STATUS_CACHE_TTL_MS = 5 * 60_000;
const FIELDS = ["summary", "issuetype", "status", "created", "updated", "resolutiondate", "assignee", "parent", "labels"];

const CATEGORIES: Record<string, StatusCategory> = { new: "todo", indeterminate: "in_progress", done: "done" };

interface RawStatus {
  id?: string;
  name?: string;
  statusCategory?: { key?: string };
}

interface RawIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    issuetype?: { name?: string; hierarchyLevel?: number };
    status?: RawStatus;
    created: string;
    updated: string;
    resolutiondate?: string | null;
    assignee?: { accountId?: string; displayName?: string } | null;
    parent?: { key?: string } | null;
    labels?: string[];
  };
}

interface RawChangeItem {
  field?: string;
  fieldId?: string;
  from?: string | null;
  fromString?: string | null;
  to?: string | null;
  toString?: string | null;
}

interface RawChangelog {
  /** The bulk changelog sends `created` as epoch milliseconds, unlike the issue fields. */
  issueChangeLogs?: { issueId: string; changeHistories?: { created: string | number; items?: RawChangeItem[] }[] }[];
  nextPageToken?: string | null;
}

/** Jira's hierarchy level: -1 is a sub-task, 0 a standard issue, 1 and above an epic or higher. Absent stays unknown. */
function levelOf(hierarchyLevel: number | undefined): WorkItemLevel | undefined {
  if (typeof hierarchyLevel !== "number" || !Number.isFinite(hierarchyLevel)) return undefined;
  if (hierarchyLevel < 0) return "subtask";
  return hierarchyLevel === 0 ? "standard" : "epic";
}

/** One status change before categories are attached. */
interface StatusChange {
  at: string;
  fromId: string | null;
  fromName: string | null;
  toId: string | null;
  toName: string;
}

/**
 * Issue fields carry offsets like +0100, which JavaScript wants as +01:00; the bulk changelog sends epoch
 * milliseconds instead. A value that is no date raises, naming the issue and field, because a stored date that
 * cannot be read would corrupt the crawl cursor and the space report.
 */
function toIso(value: string | number | null | undefined, issueKey: string, field: string): string {
  const date = new Date(typeof value === "number" ? value : (value ?? "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(date.getTime())) {
    throw new UpstreamError(`Jira sent a ${field} for ${issueKey} that is not a date`, 502);
  }
  return date.toISOString();
}

/** Jira's own words for a failure, read best effort and cut short, so a long or odd body cannot flood a log or a row. */
async function reasonFrom(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { errorMessages?: unknown; errors?: unknown; message?: unknown };
    const messages = Array.isArray(body.errorMessages) ? body.errorMessages : [];
    const fields = body.errors && typeof body.errors === "object" ? Object.values(body.errors) : [];
    // The gateway answers in `{ code, message }`, as it does for a token whose scope does not match.
    const first = [...messages, ...fields, body.message].find((m): m is string => typeof m === "string" && m.trim() !== "");
    return first === undefined ? null : first.trim().slice(0, MAX_REASON_LENGTH);
  } catch {
    return null;
  }
}

/** A string, or null. Typed this way because a parsed object's missing `toString` is the inherited function, not undefined. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** JQL date literal, in UTC; the caller subtracts a day because Jira reads it in the account's time zone. */
function jqlDate(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function quoteJql(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Jira Cloud through the Atlassian API gateway (ADR 0020). Token handling stays with the caller. */
export class JiraCloudProvider implements WorkItemProvider {
  readonly kind = "jira-cloud";

  constructor(
    private readonly http: typeof fetch = fetch,
    private readonly apiBase: string = "https://api.atlassian.com",
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private readonly categoryCache = new Map<string, { at: number; categories: Map<string, StatusCategory> }>();

  private async call<T>(token: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.http(url, {
          method: init.method ?? "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
      } catch (cause) {
        throw new UpstreamError("Jira could not be reached", 502, { cause });
      }
      if (response.status === 429) {
        if (attempt > 0) throw new RateLimitedError("Jira is rate limiting requests; try again shortly");
        const asked = Number(response.headers.get("Retry-After"));
        const seconds = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_RETRY_SECONDS) : DEFAULT_RETRY_SECONDS;
        await this.sleep(seconds * 1000);
        continue;
      }
      if (response.status === 401) {
        const reason = await reasonFrom(response);
        const where = new URL(url).pathname;
        // Atlassian answers a token that lacks a scope with a 401. Reconnecting cannot add a scope the app does not
        // have, so it is a refusal, which keeps the grant, and not a rejected credential, which drops it.
        if (reason !== null && /scope does not match/i.test(reason)) {
          throw new AccessRefusedError(
            `Jira refused access to ${where}. The app lacks a scope this call needs; add it to the app in the Atlassian developer console and connect Jira again`,
          );
        }
        throw new UnauthorisedError(`Jira rejected the credential for ${where}${reason ? `. ${reason}` : ""}; reconnect Jira`);
      }
      if (response.status === 403) {
        // The path without its query; the token travels in a header and is never here.
        throw new AccessRefusedError(
          `Jira refused access to ${new URL(url).pathname}. The connected account may lack permission, or the app may lack a scope`,
        );
      }
      if (response.status === 404) {
        throw new NotFoundError("Jira site or space was not found, or this account cannot see it");
      }
      if (!response.ok) {
        // The path without its query, which can carry a space key or a date; the token travels in a header and is never here.
        const where = new URL(url).pathname;
        const reason = await reasonFrom(response);
        throw new UpstreamError(`Jira answered ${response.status} for ${where}${reason ? `. ${reason}` : ""}`, response.status);
      }
      try {
        return (await response.json()) as T;
      } catch {
        throw new UpstreamError("Jira sent an unreadable response", response.status);
      }
    }
  }

  private api<T>(token: string, siteId: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    return this.call<T>(token, `${this.apiBase}/ex/jira/${encodeURIComponent(siteId)}${path}`, init);
  }

  async listSites(token: string): Promise<TrackerSite[]> {
    const resources = await this.call<{ id: string; url: string; name: string; scopes?: string[] }[]>(
      token,
      `${this.apiBase}/oauth/token/accessible-resources`,
    );
    return resources.filter((r) => r.scopes?.includes("read:jira-work")).map((r) => ({ id: r.id, url: r.url, name: r.name }));
  }

  async listSpaces(token: string, siteId: string): Promise<TrackerSpaceSummary[]> {
    const spaces: TrackerSpaceSummary[] = [];
    for (let startAt = 0; ;) {
      const page = await this.api<{
        values?: { key: string; name: string; projectTypeKey?: string | null }[];
        isLast?: boolean;
        total?: number;
      }>(token, siteId, `/rest/api/3/project/search?startAt=${startAt}&maxResults=${SPACE_PAGE_SIZE}`);
      const values = page.values ?? [];
      for (const v of values) spaces.push({ key: v.key, name: v.name, type: v.projectTypeKey ?? null });
      startAt += values.length;
      if (values.length === 0 || (page.isLast ?? startAt >= (page.total ?? 0))) return spaces;
    }
  }

  async fetchStatuses(token: string, siteId: string, spaceKey: string): Promise<TrackerStatus[]> {
    const types = await this.api<{ statuses?: RawStatus[] }[]>(
      token,
      siteId,
      `/rest/api/3/project/${encodeURIComponent(spaceKey)}/statuses`,
    );
    const byId = new Map<string, TrackerStatus>();
    for (const type of types) {
      for (const s of type.statuses ?? []) {
        const category = CATEGORIES[s.statusCategory?.key ?? ""];
        if (s.id && s.name && category && !byId.has(s.id)) byId.set(s.id, { id: s.id, name: s.name, category });
      }
    }
    const statuses = [...byId.values()];
    this.categoryCache.set(`${siteId}/${spaceKey}`, {
      at: this.now(),
      categories: new Map(statuses.map((s) => [s.id, s.category])),
    });
    return statuses;
  }

  /** Category by status id for the space; reused for a few minutes, since it is the same for every page of a crawl. */
  private async categoriesFor(token: string, siteId: string, spaceKey: string): Promise<Map<string, StatusCategory>> {
    const cached = this.categoryCache.get(`${siteId}/${spaceKey}`);
    if (cached && this.now() - cached.at < STATUS_CACHE_TTL_MS) return cached.categories;
    await this.fetchStatuses(token, siteId, spaceKey);
    return this.categoryCache.get(`${siteId}/${spaceKey}`)!.categories;
  }

  async fetchBoardColumns(token: string, siteId: string, spaceKey: string): Promise<BoardRead> {
    try {
      const boards = await this.api<{ values?: { id: number }[] }>(
        token,
        siteId,
        `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(spaceKey)}&maxResults=1`,
      );
      const first = boards.values?.[0];
      if (!first) return { board: "none", columns: [] };
      const config = await this.api<{ columnConfig?: { columns?: { name: string; statuses?: { id: string }[] }[] } }>(
        token,
        siteId,
        `/rest/agile/1.0/board/${first.id}/configuration`,
      );
      const columns = (config.columnConfig?.columns ?? []).map((c) => ({
        name: c.name,
        statusIds: (c.statuses ?? []).map((s) => s.id),
      }));
      return { board: "read", columns };
    } catch (error) {
      // Not found is a space without Jira Software; refused is a missing board scope or a board the person cannot see.
      const board: BoardAccess | null =
        error instanceof NotFoundError ? "none" : error instanceof AccessRefusedError ? "forbidden" : null;
      if (board === null) throw error;
      return { board, columns: [] };
    }
  }

  async fetchWorkItemPage(
    token: string,
    siteId: string,
    spaceKey: string,
    { updatedSince, cursor }: WorkItemPageRequest,
  ): Promise<WorkItemPage> {
    let jql = `project = ${quoteJql(spaceKey)}`;
    if (updatedSince !== null) {
      const since = Date.parse(updatedSince);
      if (Number.isNaN(since)) throw new ValidationError("updatedSince is not a date");
      jql += ` AND updated >= "${jqlDate(since - DAY_MS)}"`;
    }
    jql += " ORDER BY updated DESC";

    const found = await this.api<{ issues?: RawIssue[]; nextPageToken?: string | null; isLast?: boolean }>(
      token,
      siteId,
      "/rest/api/3/search/jql",
      {
        method: "POST",
        body: { jql, fields: FIELDS, maxResults: PAGE_SIZE, ...(cursor === null ? {} : { nextPageToken: cursor }) },
      },
    );
    const issues = found.issues ?? [];
    const nextCursor = found.isLast || !found.nextPageToken ? null : found.nextPageToken;
    if (issues.length === 0) return { items: [], nextCursor, people: {} };

    const [byId, changes] = await Promise.all([
      this.categoriesFor(token, siteId, spaceKey),
      this.statusChanges(token, siteId, issues),
    ]);
    // Names are returned beside the items, never on them, so a work item cannot leak one by accident. Email is not requested.
    const people: Record<string, string> = {};
    for (const i of issues) {
      const a = i.fields.assignee;
      if (a?.accountId && a.displayName) people[a.accountId] = a.displayName;
    }
    return {
      items: issues.map((i) => this.toWorkItem(i, spaceKey, byId, changes.get(i.id) ?? [])),
      nextCursor,
      people,
    };
  }

  /** Status changes per issue id, oldest first, following the changelog's own paging to the end. */
  private async statusChanges(token: string, siteId: string, issues: RawIssue[]): Promise<Map<string, StatusChange[]>> {
    const ids = issues.map((i) => i.id);
    const keyOf = new Map(issues.map((i) => [i.id, i.key]));
    const result = new Map<string, StatusChange[]>();
    let next: string | null = null;
    do {
      const page: RawChangelog = await this.api<RawChangelog>(token, siteId, "/rest/api/3/changelog/bulkfetch", {
        method: "POST",
        body: { issueIdsOrKeys: ids, fieldIds: ["status"], maxResults: 1000, ...(next === null ? {} : { nextPageToken: next }) },
      });
      for (const log of page.issueChangeLogs ?? []) {
        const list = result.get(log.issueId) ?? [];
        for (const history of log.changeHistories ?? []) {
          for (const item of history.items ?? []) {
            if (item.field !== "status" && item.fieldId !== "status") continue;
            list.push({
              at: toIso(history.created, keyOf.get(log.issueId) ?? log.issueId, "changelog date"),
              fromId: text(item.from),
              fromName: text(item.fromString),
              toId: text(item.to),
              toName: text(item.toString) ?? "",
            });
          }
        }
        result.set(log.issueId, list);
      }
      next = page.nextPageToken ?? null;
    } while (next !== null);
    for (const list of result.values()) list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return result;
  }

  private toWorkItem(
    issue: RawIssue,
    spaceKey: string,
    categories: Map<string, StatusCategory>,
    changes: StatusChange[],
  ): WorkItem {
    const f = issue.fields;
    const lookup = (id: string | null): StatusCategory | null => (id === null ? null : (categories.get(id) ?? null));
    const currentId = f.status?.id ?? null;
    const currentName = f.status?.name ?? "";
    const inline = CATEGORIES[f.status?.statusCategory?.key ?? ""] ?? null;
    const createdAt = toIso(f.created, issue.key, "created date");

    const first = changes[0];
    const initialName = first ? (first.fromName ?? first.toName) : currentName;
    const initialId = first ? first.fromId : currentId;
    const transitions: WorkItemTransition[] = [
      { at: createdAt, from: null, to: initialName, fromCategory: null, toCategory: lookup(initialId) },
      ...changes.map((c) => ({
        at: c.at,
        from: c.fromName,
        to: c.toName,
        fromCategory: lookup(c.fromId),
        toCategory: lookup(c.toId),
      })),
    ];

    const level = levelOf(f.issuetype?.hierarchyLevel);
    return {
      key: issue.key,
      spaceKey,
      type: f.issuetype?.name ?? "",
      summary: f.summary ?? "",
      status: currentName,
      statusCategory: lookup(currentId) ?? inline,
      createdAt,
      updatedAt: toIso(f.updated, issue.key, "updated date"),
      resolvedAt: f.resolutiondate ? toIso(f.resolutiondate, issue.key, "resolution date") : null,
      assigneeId: f.assignee?.accountId ?? null,
      parentKey: f.parent?.key ?? null,
      labels: f.labels ?? [],
      transitions,
      ...(level === undefined ? {} : { level }),
    };
  }
}
