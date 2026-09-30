import type { DeployRun, FunctionMetrics, OpenPullRequest, PullRequest } from "@dora-dashboard/core";
import type { Config } from "../src/core/config.js";
import { NotFoundError } from "../src/core/errors.js";
import type { WorkspaceReader } from "../src/interfaces/workspace-reader.js";
import type { CodeAnalyser, CodeAnalysis } from "../src/interfaces/code-analyser.js";
import type { Checkout, SourceCheckout } from "../src/interfaces/source-checkout.js";
import type { OpenPullRequestsResult, PullRequestPage, SourceProvider, Viewer } from "../src/interfaces/source-provider.js";
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

export function openPr(overrides: Partial<OpenPullRequest> & { number: number }): OpenPullRequest {
  return {
    ...pr({ number: overrides.number }),
    state: "OPEN",
    mergedAt: null,
    closedAt: null,
    mergedBy: null,
    isDraft: false,
    requestedReviewers: [],
    headRef: `feature-${overrides.number}`,
    checks: "passing",
    linkedIssues: [],
    changedFiles: 2,
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
  /** Serve this many pages, then fail the next one with `failWith`. */
  failAfterPages: number | null = null;
  /** Open pull request reads served, and the tokens they carried, so a test can see whether a cache was used. */
  openFetches = 0;
  readonly openFetchTokens: string[] = [];
  /** Repositories (`owner/name`) whose open pull request read fails with the given error. */
  readonly openFailures = new Map<string, Error>();
  /** Repositories (`owner/name`) whose open pull request read reports that it stopped early. */
  readonly openTruncated = new Set<string>();
  /** Tokens allowed to see a repository (`owner/name`); any other token gets NotFoundError. Unlisted repositories are open to all. */
  readonly openVisibleTo = new Map<string, Set<string>>();
  readonly repos = new Map<string, { prs: PullRequest[]; runs: DeployRun[]; workflows: string[]; openPrs: OpenPullRequest[] }>();

  seed(
    fullName: string,
    data: Partial<{ prs: PullRequest[]; runs: DeployRun[]; workflows: string[]; openPrs: OpenPullRequest[] }>,
  ): void {
    this.repos.set(fullName, {
      prs: data.prs ?? [],
      runs: data.runs ?? [],
      workflows: data.workflows ?? [],
      openPrs: data.openPrs ?? [],
    });
  }

  private repo(owner: string, name: string) {
    const repo = this.repos.get(`${owner}/${name}`);
    if (!repo) throw new NotFoundError(`${owner}/${name} was not found`);
    return repo;
  }

  async fetchPullRequestPage(_token: string, owner: string, name: string, cursor: string | null): Promise<PullRequestPage> {
    if (this.failWith && (this.failAfterPages === null || this.pagesServed >= this.failAfterPages)) throw this.failWith;
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

  async fetchOpenPullRequests(token: string, owner: string, name: string): Promise<OpenPullRequestsResult> {
    this.openFetches++;
    this.openFetchTokens.push(token);
    const full = `${owner}/${name}`;
    const failure = this.openFailures.get(full);
    if (failure) throw failure;
    const visibleTo = this.openVisibleTo.get(full);
    if (visibleTo && !visibleTo.has(token)) throw new NotFoundError(`${full} was not found, or your credential cannot see it`);
    return { pullRequests: [...this.repo(owner, name).openPrs], truncated: this.openTruncated.has(full) };
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

export function fn(overrides: Partial<FunctionMetrics> = {}): FunctionMetrics {
  return { file: "src/index.ts", language: "TypeScript", name: "main", startLine: 1, ccn: 3, nloc: 12, params: 1, ...overrides };
}

/** Hands out fake checkouts and records what was asked for and which were disposed. */
export class FakeSourceCheckout implements SourceCheckout {
  failWith: Error | null = null;
  headFailWith: Error | null = null;
  disposeFailWith: Error | null = null;
  head = "abc1234";
  headChecks = 0;
  readonly requests: { token: string; owner: string; name: string; branch: string }[] = [];
  readonly disposed: string[] = [];
  private count = 0;

  async headSha(): Promise<string> {
    this.headChecks++;
    if (this.headFailWith) throw this.headFailWith;
    return this.head;
  }

  async checkout(token: string, owner: string, name: string, branch: string): Promise<Checkout> {
    if (this.failWith) throw this.failWith;
    this.requests.push({ token, owner, name, branch });
    const dir = `/fake/checkout-${++this.count}`;
    return {
      dir,
      commitSha: this.head,
      dispose: async () => {
        if (this.disposeFailWith) throw this.disposeFailWith;
        this.disposed.push(dir);
      },
    };
  }
}

export class FakeCodeAnalyser implements CodeAnalyser {
  isAvailable = true;
  failWith: Error | null = null;
  functions: FunctionMetrics[] = [fn()];
  partlyMeasured: string[] = [];
  readonly analysed: string[] = [];

  async available(): Promise<boolean> {
    return this.isAvailable;
  }

  async analyse(dir: string): Promise<CodeAnalysis> {
    this.analysed.push(dir);
    if (this.failWith) throw this.failWith;
    return { functions: this.functions, partlyMeasured: this.partlyMeasured };
  }
}

/** Serves files from a map instead of a disk, and records what was read. */
export class FakeWorkspaceReader implements WorkspaceReader {
  files = new Map<string, string>();
  listFailWith: Error | null = null;
  readonly reads: string[] = [];

  async list(): Promise<string[]> {
    if (this.listFailWith) throw this.listFailWith;
    return [...this.files.keys()];
  }

  async read(_dir: string, path: string): Promise<string | null> {
    this.reads.push(path);
    return this.files.get(path) ?? null;
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
    codeAnalysis: true,
    ...overrides,
  };
}

/** Resolves once no crawl is running, so a test can assert on what a background crawl stored. */
export async function settled(isCrawling: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && isCrawling(); i++) await new Promise((r) => setTimeout(r, 5));
}
