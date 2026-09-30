import type { DeployRun, PullRequest, Review } from "@dora-dashboard/core";
import { NotFoundError, UnauthorisedError, UpstreamError } from "../../core/errors.js";
import type { PullRequestPage, SourceProvider, Viewer } from "../../interfaces/source-provider.js";

const API = "https://api.github.com";

type Fetch = typeof fetch;

async function request<T>(http: Fetch, token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await http(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dora-dashboard",
      ...init.headers,
    },
  });
  if (response.status === 401) throw new UnauthorisedError("GitHub rejected the credential; sign in again");
  if (response.status === 404) throw new NotFoundError("GitHub could not find that, or the credential cannot see it");
  if (!response.ok) {
    const body = await response.text();
    throw new UpstreamError(`GitHub answered ${response.status}: ${body.slice(0, 300)}`, response.status);
  }
  return (await response.json()) as T;
}

const PULL_REQUESTS_QUERY = `
query ($owner: String!, $name: String!, $cursor: String, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      totalCount
      nodes {
        number title url state createdAt publishedAt mergedAt closedAt updatedAt
        additions deletions baseRefName
        author { login __typename }
        mergedBy { login }
        commits(first: 1) { nodes { commit { authoredDate committedDate } } }
        reviews(first: 100) { nodes { author { login } state submittedAt } }
        files(first: 100) { totalCount nodes { path } }
      }
    }
  }
}`;

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
  author: { login: string; __typename: string } | null;
  mergedBy: { login: string } | null;
  commits: { nodes: { commit: { authoredDate: string; committedDate: string } }[] };
  files?: { totalCount?: number; nodes: { path: string }[] } | null;
  reviews: { nodes: { author: { login: string } | null; state: Review["state"]; submittedAt: string | null }[] };
}

interface GqlPage {
  data?: {
    repository: {
      pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount: number; nodes: GqlPullRequest[] };
    } | null;
  };
  errors?: { message: string }[];
}

const FILES_RECORDED = 100;

/** The changed paths, and a flag when GitHub reported more files than the 100 we asked for. */
function filesOf(node: GqlPullRequest): Pick<PullRequest, "files" | "filesTruncated"> {
  if (!node.files) return {};
  const files = node.files.nodes.flatMap((f) => (f?.path ? [f.path] : []));
  return (node.files.totalCount ?? 0) > FILES_RECORDED ? { files, filesTruncated: true } : { files };
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
    reviews: node.reviews.nodes.map((r) => ({ author: r.author?.login ?? null, state: r.state, submittedAt: r.submittedAt })),
    ...filesOf(node),
  };
}

const PAGE_SIZE = 50;
const RETRY_PAGE_SIZE = 25;
const RETRYABLE = new Set([502, 504]);

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
    return {
      pullRequests: connection.nodes.map(toPullRequest),
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
