import type { IssueCloseReason, IssueEvent, RepoIssue } from "@dora-dashboard/core";
import { NotFoundError, UpstreamError } from "../../core/errors.js";
import type { IssuePage, IssuePageRequest, IssueProvider } from "../../interfaces/issue-provider.js";
import { API, type Fetch, request, RETRYABLE } from "./github-http.js";

/**
 * Every field here exists in GitHub's GraphQL schema. `stateReason(enableDuplicate: true)` is needed on an issue, as
 * without it a duplicate reads as not planned. `ClosedEvent.stateReason` takes no argument. A page of 50 issues costs
 * two rate-limit points.
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
        author { login }
        assignees(first: 10) { nodes { login } }
        labels(first: 30) { nodes { name } }
        issueType { name }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number repository { nameWithOwner } } }
        timelineItems(last: 20, itemTypes: [CLOSED_EVENT, REOPENED_EVENT]) {
          pageInfo { hasPreviousPage }
          nodes { __typename ... on ClosedEvent { createdAt stateReason } ... on ReopenedEvent { createdAt } }
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
  stateReason?: string | null;
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
  author?: { login: string } | null;
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
    if (item.__typename === "ClosedEvent") return [{ at: item.createdAt, type: "closed", reason: reasonOf(item.stateReason) }];
    if (item.__typename === "ReopenedEvent") return [{ at: item.createdAt, type: "reopened", reason: null }];
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
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state: closed ? "closed" : "open",
    // A closed issue with no reason GitHub recorded counts as completed; an open one has none, whatever REOPENED says.
    closeReason: closed ? (reasonOf(node.stateReason) ?? "completed") : null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: closed ? (node.closedAt ?? null) : null,
    author: node.author?.login ?? null,
    assignees: (node.assignees?.nodes ?? []).flatMap((a) => (a?.login ? [a.login] : [])),
    labels: (node.labels?.nodes ?? []).flatMap((l) => (l?.name ? [l.name] : [])),
    issueType: node.issueType?.name ?? null,
    closedBy,
    events: eventsOf(node),
    ...(node.timelineItems?.pageInfo?.hasPreviousPage ? { eventsTruncated: true } : {}),
  };
}

const SWITCHED_OFF: IssuePage = { enabled: false, items: [], totalCount: 0, nextCursor: null };

/** GitHub Issues over its GraphQL API, read with the token the crawl already holds. */
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
    // GitHub answers a missing or invisible repository with a null repository and an error of type NOT_FOUND on the
    // `repository` path. Any other error, such as a rate limit that also leaves the repository null, is upstream's.
    const notFound = page.errors?.some((e) => e.type === "NOT_FOUND" && e.path?.[0] === "repository") ?? false;
    if (notFound && !page.data?.repository) {
      throw new NotFoundError(`${owner}/${name} was not found, or your GitHub account cannot see it`);
    }
    if (page.errors?.length) throw new UpstreamError(page.errors.map((e) => e.message).join("; "), 200);
    const repository = page.data?.repository;
    if (!repository) throw new NotFoundError(`${owner}/${name} was not found, or your GitHub account cannot see it`);
    if (!repository.hasIssuesEnabled) return { ...SWITCHED_OFF };
    const issues = repository.issues;
    return {
      enabled: true,
      items: (issues?.nodes ?? []).flatMap((node) => (node ? [toIssue(node)] : [])),
      totalCount: issues?.totalCount ?? 0,
      nextCursor: issues?.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null,
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
