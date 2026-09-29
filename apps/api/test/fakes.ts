import type { DeployRun, PullRequest } from "@dora-dashboard/core";
import type { Config } from "../src/core/config.js";
import { NotFoundError } from "../src/core/errors.js";
import type { PullRequestPage, SourceProvider, Viewer } from "../src/interfaces/source-provider.js";
import type { CliTokenSource, Session } from "../src/interfaces/token-source.js";

export function pr(overrides: Partial<PullRequest> & { number: number }): PullRequest {
  return {
    title: `PR ${overrides.number}`,
    url: `https://example.test/acme/widgets/pull/${overrides.number}`,
    author: "alice",
    authorIsBot: false,
    state: "MERGED",
    createdAt: "2026-09-01T10:00:00Z",
    publishedAt: "2026-09-01T10:00:00Z",
    mergedAt: "2026-09-01T12:00:00Z",
    closedAt: "2026-09-01T12:00:00Z",
    updatedAt: "2026-09-01T12:00:00Z",
    mergedBy: "alice",
    additions: 10,
    deletions: 2,
    firstCommitAt: "2026-09-01T09:00:00Z",
    baseRef: "main",
    reviews: [],
    ...overrides,
  };
}

export function run(overrides: Partial<DeployRun> & { runId: number }): DeployRun {
  return {
    workflow: "deploy.yml",
    branch: "main",
    status: "completed",
    conclusion: "success",
    createdAt: "2026-09-01T13:00:00Z",
    completedAt: "2026-09-01T13:10:00Z",
    ...overrides,
  };
}

/**
 * An in-memory code host honouring the SourceProvider contract: pages ordered by updatedAt
 * descending, unknown repositories raising NotFoundError.
 */
export class FakeProvider implements SourceProvider {
  readonly kind = "fake";
  pageSize = 2;
  pagesServed = 0;
  failWith: Error | null = null;
  readonly repos = new Map<string, { prs: PullRequest[]; runs: DeployRun[]; workflows: string[] }>();

  seed(fullName: string, data: Partial<{ prs: PullRequest[]; runs: DeployRun[]; workflows: string[] }>): void {
    this.repos.set(fullName, { prs: data.prs ?? [], runs: data.runs ?? [], workflows: data.workflows ?? [] });
  }

  private repo(owner: string, name: string) {
    const repo = this.repos.get(`${owner}/${name}`);
    if (!repo) throw new NotFoundError(`${owner}/${name} was not found`);
    return repo;
  }

  async fetchPullRequestPage(_token: string, owner: string, name: string, cursor: string | null): Promise<PullRequestPage> {
    if (this.failWith) throw this.failWith;
    this.pagesServed++;
    const sorted = [...this.repo(owner, name).prs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const start = cursor ? Number(cursor) : 0;
    const end = start + this.pageSize;
    return {
      pullRequests: sorted.slice(start, end),
      totalCount: sorted.length,
      nextCursor: end < sorted.length ? String(end) : null,
    };
  }

  async fetchDeployRuns(_token: string, owner: string, name: string, workflow: string): Promise<DeployRun[]> {
    return this.repo(owner, name).runs.filter((r) => r.workflow === workflow);
  }

  async listWorkflows(_token: string, owner: string, name: string): Promise<string[]> {
    return this.repo(owner, name).workflows;
  }

  async fetchViewer(token: string): Promise<Viewer> {
    return { login: `user-of-${token}`, avatarUrl: "https://example.test/avatar.png" };
  }
}

export class FakeCli implements CliTokenSource {
  error: Error | null = null;
  async session(): Promise<Session> {
    if (this.error) throw this.error;
    return { token: "cli-token", login: "local-dev", avatarUrl: "", expiresAt: Number.MAX_SAFE_INTEGER };
  }
}

export function config(overrides: Partial<Config> = {}): Config {
  return {
    authMode: "gh-cli",
    githubClientId: "client-id",
    githubClientSecret: "client-secret",
    sessionSecret: "a-test-secret-that-is-long-enough",
    port: 0,
    databasePath: ":memory:",
    webOrigin: "http://localhost:5181",
    ...overrides,
  };
}

/** Resolves once no crawl is running, so a test can assert on what a background crawl stored. */
export async function settled(isCrawling: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && isCrawling(); i++) await new Promise((r) => setTimeout(r, 5));
}
