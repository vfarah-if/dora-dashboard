import type { DeployRun, OpenPullRequest, PullRequest, RequestedReviewer, Review } from "@dora-dashboard/core";
import { NotFoundError, UpstreamError } from "../../core/errors.js";
import type { OpenPullRequestsResult, PullRequestPage, SourceProvider, Viewer } from "../../interfaces/source-provider.js";
import { API, type Fetch, request, RETRYABLE } from "./github-http.js";

const PULL_REQUESTS_QUERY = `
query ($owner: String!, $name: String!, $cursor: String, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      totalCount
      nodes {
        number title url state createdAt publishedAt mergedAt closedAt updatedAt
        additions deletions baseRefName headRefName
        author { login __typename }
        mergedBy { login }
        commits(first: 1) { nodes { commit { authoredDate committedDate } } }
        reviews(first: 100) { nodes { author { login } state submittedAt } }
        files(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { path } }
        labels(first: 20) { nodes { name } }
        trailers: commits(last: 100) { nodes { commit { message } } }
      }
    }
  }
}`;

const PULL_REQUEST_FILES_QUERY = `
query ($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $cursor) { totalCount pageInfo { hasNextPage endCursor } nodes { path } }
    }
  }
}`;

const OPEN_PULL_REQUESTS_QUERY = `
query ($owner: String!, $name: String!, $cursor: String, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $cursor, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      totalCount
      nodes {
        number title url state createdAt publishedAt mergedAt closedAt updatedAt
        additions deletions changedFiles baseRefName headRefName isDraft body
        author { login __typename }
        commits(first: 1) { nodes { commit { authoredDate committedDate } } }
        latest: commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        reviews(last: 100) { nodes { author { login __typename } state submittedAt } }
        reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
        labels(first: 20) { nodes { name } }
        closingIssuesReferences(first: 5) { nodes { number repository { nameWithOwner } } }
      }
    }
  }
}`;

interface GqlFiles {
  totalCount?: number;
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  nodes: ({ path: string } | null)[];
}

interface GqlFilesPage {
  data?: { repository: { pullRequest: { files: GqlFiles | null } | null } | null };
  errors?: { message: string }[];
}

interface GqlPullRequest {
  number: number;
  title: string;
  url: string;
  state: PullRequest["state"];
  createdAt: string;
  publishedAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  additions: number;
  deletions: number;
  baseRefName: string;
  headRefName?: string;
  author: { login: string; __typename: string } | null;
  mergedBy: { login: string } | null;
  commits: { nodes: { commit: { authoredDate: string; committedDate: string } }[] };
  labels?: { nodes: ({ name: string } | null)[] } | null;
  trailers?: { nodes: ({ commit: { message: string } } | null)[] } | null;
  files?: GqlFiles | null;
  reviews: {
    nodes: { author: { login: string; __typename?: string } | null; state: Review["state"]; submittedAt: string | null }[];
  };
}

interface GqlOpenPullRequest extends GqlPullRequest {
  changedFiles?: number;
  isDraft?: boolean;
  body?: string | null;
  latest?: { nodes: ({ commit: { statusCheckRollup: { state: string } | null } } | null)[] } | null;
  reviewRequests?: {
    nodes: ({ requestedReviewer: { __typename?: string; login?: string; name?: string } | null } | null)[];
  } | null;
  closingIssuesReferences?: {
    nodes: ({ number: number; repository?: { nameWithOwner?: string | null } | null } | null)[];
  } | null;
}

interface GqlPage<Node = GqlPullRequest> {
  data?: {
    repository: {
      pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount: number; nodes: Node[] };
    } | null;
  };
  errors?: { message: string }[];
}

/** GitHub lists at most 3000 changed files of a pull request through its REST API, so reading stops there too. */
export const MAX_FILES_READ = 3000;

/** The changed paths, and a flag when GitHub reported more files than were read (ADR 0027). */
function filesOf(node: GqlPullRequest): Pick<PullRequest, "files" | "filesTruncated"> {
  if (!node.files) return {};
  const files = node.files.nodes.flatMap((f) => (f?.path ? [f.path] : []));
  return (node.files.totalCount ?? 0) > files.length ? { files, filesTruncated: true } : { files };
}

const CO_AUTHOR_LINE = /^co-authored-by:\s*(.+?)\s*(<[^>]*>)?\s*$/i;

/**
 * The distinct names on `Co-Authored-By:` trailers in a commit message. Only the name is kept: the email is dropped
 * here and the message is never stored (ADR 0016).
 */
export function parseCoAuthors(message: string): string[] {
  const names = message.split(/\r?\n/).flatMap((line) => {
    const name = CO_AUTHOR_LINE.exec(line.trim())?.[1]?.trim();
    return name ? [name] : [];
  });
  return [...new Set(names)];
}

function signalsOf(node: GqlPullRequest): Pick<PullRequest, "labels" | "coAuthors"> {
  const out: Pick<PullRequest, "labels" | "coAuthors"> = {};
  if (node.labels) out.labels = node.labels.nodes.flatMap((l) => (l?.name ? [l.name] : []));
  if (node.trailers) {
    out.coAuthors = [...new Set(node.trailers.nodes.flatMap((n) => (n?.commit ? parseCoAuthors(n.commit.message) : [])))];
  }
  return out;
}

function toPullRequest(node: GqlPullRequest): PullRequest {
  const commit = node.commits.nodes[0]?.commit;
  const firstCommitAt = commit ? [commit.authoredDate, commit.committedDate].sort()[0]! : null;
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login ?? null,
    authorIsBot: node.author?.__typename === "Bot",
    state: node.state,
    createdAt: node.createdAt,
    publishedAt: node.publishedAt,
    mergedAt: node.mergedAt,
    closedAt: node.closedAt,
    updatedAt: node.updatedAt,
    mergedBy: node.mergedBy?.login ?? null,
    additions: node.additions,
    deletions: node.deletions,
    firstCommitAt,
    baseRef: node.baseRefName,
    headRef: node.headRefName ?? null,
    reviews: node.reviews.nodes.map((r) => ({
      author: r.author?.login ?? null,
      state: r.state,
      submittedAt: r.submittedAt,
      ...(r.author?.__typename ? { authorIsBot: r.author.__typename === "Bot" } : {}),
    })),
    ...filesOf(node),
    ...signalsOf(node),
  };
}

const CHECKS: Record<string, OpenPullRequest["checks"]> = {
  SUCCESS: "passing",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "pending",
  EXPECTED: "pending",
};

function toOpenPullRequest(owner: string, name: string, node: GqlOpenPullRequest): OpenPullRequest {
  const rollup = node.latest?.nodes[0]?.commit.statusCheckRollup?.state;
  return {
    ...toPullRequest(node),
    isDraft: node.isDraft ?? false,
    headRef: node.headRefName ?? "",
    checks: (rollup && CHECKS[rollup]) || "none",
    changedFiles: node.changedFiles ?? 0,
    requestedReviewers: (node.reviewRequests?.nodes ?? []).flatMap<RequestedReviewer>((n) => {
      const who = n?.requestedReviewer;
      if (who?.login) return [{ name: who.login, isTeam: false }];
      return who?.name ? [{ name: who.name, isTeam: true }] : [];
    }),
    // Qualified by the issue's own repository so that grouping across repositories keeps two issue 12s apart (ADR 0017).
    linkedIssues: (node.closingIssuesReferences?.nodes ?? []).flatMap((n) =>
      n ? [`${n.repository?.nameWithOwner ?? `${owner}/${name}`}#${n.number}`] : [],
    ),
    ...(node.body ? { body: node.body } : {}),
  };
}

// Each PR also carries up to 100 commit messages for trailers, so pages stay small to keep responses fast.
const PAGE_SIZE = 25;
const RETRY_PAGE_SIZE = 10;
const OPEN_PAGE_SIZE = 50;
const OPEN_RETRY_PAGE_SIZE = 20;
/** A repository with more open pull requests than this is read only as far as this many pages. */
const MAX_OPEN_PAGES = 10;

/** GitHub over its GraphQL API for pull requests and its REST API for Actions runs. */
export class GitHubProvider implements SourceProvider {
  readonly kind = "github";

  constructor(
    private readonly http: Fetch = fetch,
    private readonly maxRunsPerWorkflow = 3000,
  ) {}

  async fetchPullRequestPage(token: string, owner: string, name: string, cursor: string | null): Promise<PullRequestPage> {
    let page: GqlPage;
    try {
      page = await this.pullRequestPage(token, owner, name, cursor, PAGE_SIZE);
    } catch (error) {
      // A page of 50 pull requests, each with reviews and files, can time out at the gateway. A smaller page usually fits.
      if (!(error instanceof UpstreamError) || !RETRYABLE.has(error.status)) throw error;
      page = await this.pullRequestPage(token, owner, name, cursor, RETRY_PAGE_SIZE);
    }
    const connection = page.data?.repository?.pullRequests;
    if (!connection) throw new NotFoundError(`${owner}/${name} was not found, or your GitHub account cannot see it`);
    if (page.errors?.length) throw new UpstreamError(page.errors.map((e) => e.message).join("; "), 200);
    const nodes: GqlPullRequest[] = [];
    // One pull request at a time, since GitHub's secondary rate limits penalise bursts of concurrent queries.
    for (const node of connection.nodes) nodes.push(await this.withAllFiles(token, owner, name, node));
    return {
      pullRequests: nodes.map(toPullRequest),
      totalCount: connection.totalCount,
      nextCursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null,
    };
  }

  private pullRequestPage(token: string, owner: string, name: string, cursor: string | null, first: number) {
    return request<GqlPage>(this.http, token, `${API}/graphql`, {
      method: "POST",
      body: JSON.stringify({ query: PULL_REQUESTS_QUERY, variables: { owner, name, cursor, first } }),
    });
  }

  /**
   * The pull request with the rest of its changed paths when the first 100 were not all of them, read 100 at a time
   * from where the page stopped until about `MAX_FILES_READ` are held, so the pull-request test check rarely meets a
   * cut list (ADR 0027).
   */
  private async withAllFiles(token: string, owner: string, name: string, node: GqlPullRequest): Promise<GqlPullRequest> {
    const files = node.files;
    if (!files?.pageInfo?.hasNextPage) return node;
    const nodes = [...files.nodes];
    let cursor = files.pageInfo.endCursor;
    try {
      while (cursor !== null && nodes.length < MAX_FILES_READ) {
        const page = await this.filesPage(token, owner, name, node.number, cursor);
        if (!page) break;
        nodes.push(...page.nodes);
        cursor = page.next;
      }
    } catch (error) {
      // A failed file request costs this pull request the rest of its list, not the whole page: the paths read so far
      // stand, and `filesOf` marks the list as cut. A refused credential or a repository gone from view still fails it.
      if (!(error instanceof UpstreamError)) throw error;
    }
    return { ...node, files: { ...files, nodes } };
  }

  /** The next paths of a pull request and the cursor after them, or null when GitHub sent no more. */
  private async filesPage(
    token: string,
    owner: string,
    name: string,
    number: number,
    cursor: string,
  ): Promise<{ nodes: GqlFiles["nodes"]; next: string | null } | null> {
    const page = await request<GqlFilesPage>(this.http, token, `${API}/graphql`, {
      method: "POST",
      body: JSON.stringify({ query: PULL_REQUEST_FILES_QUERY, variables: { owner, name, number, cursor } }),
    });
    if (page.errors?.length) throw new UpstreamError(page.errors.map((e) => e.message).join("; "), 200);
    const files = page.data?.repository?.pullRequest?.files;
    if (!files || files.nodes.length === 0) return null;
    const next = files.pageInfo?.hasNextPage ? files.pageInfo.endCursor : null;
    // A cursor that does not move would read the same page again.
    return { nodes: files.nodes, next: next === cursor ? null : next };
  }

  async fetchOpenPullRequests(token: string, owner: string, name: string): Promise<OpenPullRequestsResult> {
    const found: OpenPullRequest[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_OPEN_PAGES; page++) {
      const result: GqlPage<GqlOpenPullRequest> = await this.openPage(token, owner, name, cursor);
      // Errors first: a rate limit arrives with a null repository and must not be reported as not found.
      if (result.errors?.length) throw new UpstreamError(result.errors.map((e) => e.message).join("; "), 200);
      const connection = result.data?.repository?.pullRequests;
      if (!connection) throw new NotFoundError(`${owner}/${name} was not found, or your GitHub account cannot see it`);
      found.push(...connection.nodes.map((node) => toOpenPullRequest(owner, name, node)));
      if (!connection.pageInfo.hasNextPage) return { pullRequests: found, truncated: false };
      cursor = connection.pageInfo.endCursor;
    }
    return { pullRequests: found, truncated: true };
  }

  private async openPage(
    token: string,
    owner: string,
    name: string,
    cursor: string | null,
  ): Promise<GqlPage<GqlOpenPullRequest>> {
    const ask = (first: number) =>
      request<GqlPage<GqlOpenPullRequest>>(this.http, token, `${API}/graphql`, {
        method: "POST",
        body: JSON.stringify({ query: OPEN_PULL_REQUESTS_QUERY, variables: { owner, name, cursor, first } }),
      });
    try {
      return await ask(OPEN_PAGE_SIZE);
    } catch (error) {
      if (!(error instanceof UpstreamError) || !RETRYABLE.has(error.status)) throw error;
      return ask(OPEN_RETRY_PAGE_SIZE);
    }
  }

  async fetchDeployRuns(token: string, owner: string, name: string, workflow: string): Promise<DeployRun[]> {
    const runs: DeployRun[] = [];
    for (let page = 1; runs.length < this.maxRunsPerWorkflow; page++) {
      const body = await request<{ workflow_runs: RestRun[] }>(
        this.http,
        token,
        `${API}/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=100&page=${page}`,
      );
      runs.push(...body.workflow_runs.map((run) => toDeployRun(run, workflow)));
      if (body.workflow_runs.length < 100) break;
    }
    return runs;
  }

  async listWorkflows(token: string, owner: string, name: string): Promise<string[]> {
    const body = await request<{ workflows: { path: string }[] }>(
      this.http,
      token,
      `${API}/repos/${owner}/${name}/actions/workflows?per_page=100`,
    );
    return body.workflows.map((w) => w.path.split("/").pop() ?? "").filter(Boolean);
  }

  async fetchViewer(token: string): Promise<Viewer> {
    const body = await request<{ login: string; avatar_url: string }>(this.http, token, `${API}/user`);
    return { login: body.login, avatarUrl: body.avatar_url };
  }
}

interface RestRun {
  id: number;
  head_branch: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
}

function toDeployRun(run: RestRun, workflow: string): DeployRun {
  return {
    runId: run.id,
    workflow,
    branch: run.head_branch,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    completedAt: run.updated_at,
  };
}
