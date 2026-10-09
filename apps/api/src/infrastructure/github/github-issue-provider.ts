import type { IssueCloseReason, IssueEvent, RepoIssue } from "@dora-dashboard/core";
import { NotFoundError, UpstreamError } from "../../core/errors.js";
import type { IssuePage, IssuePageRequest, IssueProvider } from "../../interfaces/issue-provider.js";
import { API, type Fetch, request, RETRYABLE } from "./github-http.js";

/**
 * Every field here exists in GitHub's GraphQL schema. `stateReason(enableDuplicate: true)` is needed on an issue, as
 * without it a duplicate reads as not planned. A page of 50 issues costs two rate-limit points.
 */
const ISSUES_QUERY = `
query ($owner: String!, $name: String!, $cursor: String, $first: Int!, $filter: IssueFilters) {
  repository(owner: $owner, name: $name) {
    hasIssuesEnabled
    issues(first: $first, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}, filterBy: $filter) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url state stateReason(enableDuplicate: true) createdAt updatedAt closedAt
        assignees(first: 10) { nodes { login } }
        labels(first: 30) { nodes { name } }
        issueType { name }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number repository { nameWithOwner } } }
        timelineItems(last: 20, itemTypes: [CLOSED_EVENT, REOPENED_EVENT]) {
          pageInfo { hasPreviousPage }
          nodes { __typename ... on ClosedEvent { createdAt } ... on ReopenedEvent { createdAt } }
        }
      }
    }
  }
}`;

const PAGE_SIZE = 50;
const RETRY_PAGE_SIZE = 20;

interface GqlTimelineNode {
  __typename?: string;
  createdAt?: string;
}

interface GqlIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  assignees?: { nodes?: ({ login: string } | null)[] } | null;
  labels?: { nodes?: ({ name: string } | null)[] } | null;
  issueType?: { name: string } | null;
  closedByPullRequestsReferences?: {
    nodes?: ({ number: number; repository?: { nameWithOwner: string } | null } | null)[];
  } | null;
  timelineItems?: { pageInfo?: { hasPreviousPage: boolean }; nodes?: (GqlTimelineNode | null)[] } | null;
}

interface GqlPage {
  data?: {
    repository: {
      hasIssuesEnabled: boolean;
      issues: {
        totalCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: (GqlIssue | null)[];
      } | null;
    } | null;
  };
  errors?: { message: string; type?: string; path?: (string | number)[] }[];
}

const REASONS: Record<string, IssueCloseReason> = {
  COMPLETED: "completed",
  NOT_PLANNED: "not_planned",
  DUPLICATE: "duplicate",
};

/** A reason GitHub names, or null for REOPENED, a value this adapter does not know, or none. */
const reasonOf = (value: string | null | undefined): IssueCloseReason | null => (value ? (REASONS[value] ?? null) : null);

function eventsOf(node: GqlIssue): IssueEvent[] {
  const events = (node.timelineItems?.nodes ?? []).flatMap<IssueEvent>((item) => {
    if (!item?.createdAt) return [];
    if (item.__typename === "ClosedEvent") return [{ at: item.createdAt, type: "closed" }];
    if (item.__typename === "ReopenedEvent") return [{ at: item.createdAt, type: "reopened" }];
    return [];
  });
  // Array.prototype.sort is stable, so two events at the same instant keep the order GitHub gave them.
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

function toIssue(node: GqlIssue): RepoIssue {
  const closed = node.state === "CLOSED";
  const closedBy = (node.closedByPullRequestsReferences?.nodes ?? []).flatMap((ref) =>
    ref?.repository?.nameWithOwner ? [{ repo: ref.repository.nameWithOwner, number: ref.number }] : [],
  );
  const fields = {
    number: node.number,
    title: node.title,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    assignees: (node.assignees?.nodes ?? []).flatMap((a) => (a?.login ? [a.login] : [])),
    labels: (node.labels?.nodes ?? []).flatMap((l) => (l?.name ? [l.name] : [])),
    issueType: node.issueType?.name ?? null,
    closedBy,
    events: eventsOf(node),
    ...(node.timelineItems?.pageInfo?.hasPreviousPage ? { eventsTruncated: true } : {}),
  };
  // An open issue has no reason, whatever REOPENED says. A closed issue with no reason GitHub recorded counts as
  // completed, and one with no close time falls back to its last update, the latest it can have closed.
  if (!closed) return { ...fields, state: "open", closeReason: null, closedAt: null };
  return {
    ...fields,
    state: "closed",
    closeReason: reasonOf(node.stateReason) ?? "completed",
    closedAt: node.closedAt ?? node.updatedAt,
  };
}

const NOT_FOUND = (owner: string, name: string) =>
  new NotFoundError(`${owner}/${name} was not found, or your GitHub account cannot see it`);

/** True for an error on a field of one issue node, `["repository","issues","nodes", n, field, ...]`, not on the node itself. */
const isNestedFieldError = (path: (string | number)[] | undefined): boolean =>
  path !== undefined &&
  path.length >= 5 &&
  path[0] === "repository" &&
  path[1] === "issues" &&
  path[2] === "nodes" &&
  typeof path[3] === "number";

/**
 * GitHub Issues over its GraphQL API, read with the token the crawl already holds. What follows is GitHub's side of
 * the `IssueProvider` contract.
 *
 * - A missing or invisible repository arrives as `data.repository` null with an error of type `NOT_FOUND` on the
 *   `repository` path (or as HTTP 404, or as a null repository with no errors), and raises `NotFoundError`. A rate
 *   limit also leaves the repository null, so it is told apart by the error and raises `UpstreamError` with a message
 *   that says when to crawl again.
 * - A 502 or 504 is retried once with a smaller page (20 rather than 50), keeping the request's cursor and filter.
 * - Once `data.repository.issues` is present with every issue node, an error on a field inside one issue node is
 *   tolerated: that field arrives null and is read as empty. An error on a node itself, an error that left any issue
 *   node null, or an error anywhere else raises `UpstreamError`.
 * - Connections are capped: 10 assignees, 30 labels, 10 closing pull requests and the last 20 closes and reopens,
 *   with `eventsTruncated` set when GitHub held more events than were read.
 * - A closed issue with no `stateReason` counts as completed, and one with no `closedAt` takes its `updatedAt`.
 */
export class GitHubIssueProvider implements IssueProvider {
  readonly kind = "github";

  constructor(private readonly http: Fetch = fetch) {}

  async fetchIssuePage(token: string, owner: string, name: string, req: IssuePageRequest): Promise<IssuePage> {
    let page: GqlPage;
    try {
      page = await this.ask(token, owner, name, req, PAGE_SIZE);
    } catch (error) {
      // A page of issues, each with its timeline and links, can time out at the gateway. A smaller page usually fits.
      if (!(error instanceof UpstreamError) || !RETRYABLE.has(error.status)) throw error;
      page = await this.ask(token, owner, name, req, RETRY_PAGE_SIZE);
    }
    const errors = page.errors ?? [];
    const repository = page.data?.repository;
    if (!repository && errors.some((e) => e.type === "NOT_FOUND" && e.path?.[0] === "repository")) throw NOT_FOUND(owner, name);
    if (errors.some((e) => e.type === "RATE_LIMITED")) {
      throw new UpstreamError(
        "GitHub's rate limit for this token was reached, so issues could not be read. Crawl again once it resets",
        429,
      );
    }
    // A field error can null its whole issue through fields GitHub declares non-null. Dropping that issue would let a
    // full read remove it from the store, so an error is tolerated only while every issue node arrived.
    const whole = repository?.issues?.nodes.every((n) => n !== null) ?? false;
    const fatal = whole ? errors.filter((e) => !isNestedFieldError(e.path)) : errors;
    if (fatal.length > 0) throw new UpstreamError(fatal.map((e) => e.message).join("; "), 200);
    if (!repository) throw NOT_FOUND(owner, name);
    if (!repository.hasIssuesEnabled) return { enabled: false };
    const issues = repository.issues;
    if (!issues) throw new UpstreamError(`GitHub sent no issues list for ${owner}/${name}`, 502);
    return {
      enabled: true,
      items: issues.nodes.flatMap((node) => (node ? [toIssue(node)] : [])),
      totalCount: issues.totalCount,
      nextCursor: issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null,
    };
  }

  private ask(token: string, owner: string, name: string, req: IssuePageRequest, first: number): Promise<GqlPage> {
    const filter = req.updatedSince === null ? {} : { since: req.updatedSince };
    return request<GqlPage>(this.http, token, `${API}/graphql`, {
      method: "POST",
      body: JSON.stringify({ query: ISSUES_QUERY, variables: { owner, name, cursor: req.cursor, first, filter } }),
    });
  }
}
