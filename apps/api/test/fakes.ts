import type {
  BoardAccess,
  BoardColumn,
  DeployRun,
  FunctionMetrics,
  OpenPullRequest,
  PullRequest,
  TrackerSite,
  TrackerSpaceSummary,
  TrackerStatus,
  WorkItem,
} from "@dora-dashboard/core";
import type { Config } from "../src/core/config.js";
import { NotFoundError } from "../src/core/errors.js";
import type { WorkspaceReader } from "../src/interfaces/workspace-reader.js";
import type { CodeAnalyser, CodeAnalysis } from "../src/interfaces/code-analyser.js";
import type { Checkout, SourceCheckout } from "../src/interfaces/source-checkout.js";
import type { OpenPullRequestsResult, PullRequestPage, SourceProvider, Viewer } from "../src/interfaces/source-provider.js";
import type { DeviceAuthorisation, DeviceCode, DevicePoll } from "../src/interfaces/device-authorisation.js";
import type { CliTokenSource, Session } from "../src/interfaces/token-source.js";
import type { TrackerAuthorisation, TrackerGrant } from "../src/interfaces/tracker-authorisation.js";
import type { BoardRead, WorkItemPage, WorkItemPageRequest, WorkItemProvider } from "../src/interfaces/work-item-provider.js";

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

export function workItem(overrides: Partial<WorkItem> & { key: string }): WorkItem {
  return {
    spaceKey: "WID",
    type: "Story",
    summary: `Work item ${overrides.key}`,
    status: "Done",
    statusCategory: "done",
    createdAt: "2026-09-01T09:00:00Z",
    updatedAt: "2026-09-01T12:00:00Z",
    resolvedAt: "2026-09-01T12:00:00Z",
    assigneeId: "account-1",
    parentKey: null,
    labels: [],
    transitions: [],
    ...overrides,
  };
}

export const SITE: TrackerSite = { id: "cloud-1", url: "https://acme.example.test", name: "Acme" };

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

interface FakeSpace {
  summary: TrackerSpaceSummary;
  statuses: TrackerStatus[];
  columns: BoardColumn[];
  /** What reading the board comes to; defaults to "read" when columns are given, else "none". */
  board: BoardAccess;
  items: WorkItem[];
  /** Display names by account id; a page returns the names of the assignees on it. */
  people: Record<string, string>;
}

/** One recorded call on a FakeWorkItemProvider, with the token it carried. */
export interface WorkItemCall {
  method: "listSites" | "listSpaces" | "fetchStatuses" | "fetchBoardColumns" | "fetchWorkItemPage";
  token: string;
  siteId?: string;
  spaceKey?: string;
  updatedSince?: string | null;
  cursor?: string | null;
}

/**
 * An in-memory issue tracker honouring the WorkItemProvider contract: pages ordered by updatedAt descending, items
 * no older than `updatedSince`, and an unseen site or space raising NotFoundError.
 */
export class FakeWorkItemProvider implements WorkItemProvider {
  readonly kind = "fake";
  pageSize = 2;
  pagesServed = 0;
  /** Serve every item whatever `updatedSince` says, to prove the crawl service stops on its own. */
  ignoreUpdatedSince = false;
  failWith: Error | null = null;
  /** Serve this many work item pages, then fail the next one with `failWith`. */
  failAfterPages: number | null = null;
  /** Runs before each work item page is served, so a test can move a clock on mid-crawl. */
  onPage: (() => void) | null = null;
  readonly calls: WorkItemCall[] = [];
  readonly sites: TrackerSite[] = [];
  private readonly spaces = new Map<string, FakeSpace>();

  get tokens(): string[] {
    return this.calls.map((call) => call.token);
  }

  seedSite(site: TrackerSite = SITE): void {
    this.sites.push(site);
  }

  seedSpace(
    siteId: string,
    key: string,
    data: Partial<Omit<FakeSpace, "summary">> & { name?: string; type?: string | null } = {},
  ): void {
    this.spaces.set(`${siteId}/${key}`, {
      summary: { key, name: data.name ?? `Space ${key}`, type: data.type ?? "software" },
      statuses: data.statuses ?? [],
      columns: data.columns ?? [],
      board: data.board ?? (data.columns?.length ? "read" : "none"),
      items: data.items ?? [],
      people: data.people ?? {},
    });
  }

  /** Every call but a work item page fails whenever `failWith` is set, unless `failAfterPages` is limiting it to pages. */
  private fail(): void {
    if (this.failWith && this.failAfterPages === null) throw this.failWith;
  }

  private space(siteId: string, key: string): FakeSpace {
    const space = this.spaces.get(`${siteId}/${key}`);
    if (!space) throw new NotFoundError(`${key} was not found on ${siteId}`);
    return space;
  }

  async listSites(token: string): Promise<TrackerSite[]> {
    this.calls.push({ method: "listSites", token });
    this.fail();
    return [...this.sites];
  }

  async listSpaces(token: string, siteId: string): Promise<TrackerSpaceSummary[]> {
    this.calls.push({ method: "listSpaces", token, siteId });
    this.fail();
    if (!this.sites.some((site) => site.id === siteId)) throw new NotFoundError(`${siteId} was not found`);
    return [...this.spaces].filter(([id]) => id.startsWith(`${siteId}/`)).map(([, space]) => space.summary);
  }

  async fetchStatuses(token: string, siteId: string, spaceKey: string): Promise<TrackerStatus[]> {
    this.calls.push({ method: "fetchStatuses", token, siteId, spaceKey });
    this.fail();
    return this.space(siteId, spaceKey).statuses;
  }

  async fetchBoardColumns(token: string, siteId: string, spaceKey: string): Promise<BoardRead> {
    this.calls.push({ method: "fetchBoardColumns", token, siteId, spaceKey });
    this.fail();
    const { board, columns } = this.space(siteId, spaceKey);
    return { board, columns };
  }

  async fetchWorkItemPage(
    token: string,
    siteId: string,
    spaceKey: string,
    { updatedSince, cursor }: WorkItemPageRequest,
  ): Promise<WorkItemPage> {
    this.calls.push({ method: "fetchWorkItemPage", token, siteId, spaceKey, updatedSince, cursor });
    this.onPage?.();
    if (this.failWith && (this.failAfterPages === null || this.pagesServed >= this.failAfterPages)) throw this.failWith;
    this.pagesServed++;
    const space = this.space(siteId, spaceKey);
    const sorted = space.items
      .filter((item) => this.ignoreUpdatedSince || !updatedSince || item.updatedAt >= updatedSince)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const start = cursor ? Number(cursor) : 0;
    const end = start + this.pageSize;
    const items = sorted.slice(start, end);
    // Built as data properties from the space's own names, so an account id such as "__proto__" is kept as a name.
    const people: Record<string, string> = Object.fromEntries(
      items.flatMap(({ assigneeId: id }) => (id !== null && Object.hasOwn(space.people, id) ? [[id, space.people[id]!]] : [])),
    );
    return { items, nextCursor: end < sorted.length ? String(end) : null, people };
  }
}

/** The grant a test gets from `exchange` unless it sets another: valid for a long time, so no refresh is due. */
export function grant(overrides: Partial<TrackerGrant> = {}): TrackerGrant {
  return { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Number.MAX_SAFE_INTEGER, ...overrides };
}

/** Scripted tracker consent: `exchange` yields `exchangeGrant`, and `refresh` serves `refreshGrants` in order, the last repeating. */
export class FakeTrackerAuthorisation implements TrackerAuthorisation {
  readonly kind = "fake";
  exchangeGrant: TrackerGrant = grant();
  refreshGrants: TrackerGrant[] = [grant({ accessToken: "access-2", refreshToken: "refresh-2" })];
  exchangeFailWith: Error | null = null;
  refreshFailWith: Error | null = null;
  /** When set, `refresh` waits for it, so a test can hold several callers on one refresh. */
  refreshGate: Promise<void> | null = null;
  readonly codes: string[] = [];
  readonly refreshTokens: string[] = [];

  authoriseUrl(state: string): string {
    return `https://auth.example.test/authorize?state=${state}`;
  }

  async exchange(code: string): Promise<TrackerGrant> {
    this.codes.push(code);
    if (this.exchangeFailWith) throw this.exchangeFailWith;
    return this.exchangeGrant;
  }

  async refresh(refreshToken: string): Promise<TrackerGrant> {
    this.refreshTokens.push(refreshToken);
    await this.refreshGate;
    if (this.refreshFailWith) throw this.refreshFailWith;
    return this.refreshGrants.length > 1 ? this.refreshGrants.shift()! : this.refreshGrants[0]!;
  }
}

export class FakeCli implements CliTokenSource {
  error: Error | null = null;
  async session(): Promise<Session> {
    if (this.error) throw this.error;
    return { token: "cli-token", login: "local-dev", avatarUrl: "", expiresAt: Number.MAX_SAFE_INTEGER };
  }
}

/** Scripted device flow: `polls` are served in order, and the last one repeats. */
export class FakeDeviceAuthorisation implements DeviceAuthorisation {
  startFailWith: Error | null = null;
  code: DeviceCode = {
    deviceCode: "secret-device-code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.test/device",
    expiresIn: 900,
    interval: 5,
  };
  polls: DevicePoll[] = [{ status: "pending" }];
  starts = 0;
  readonly polled: string[] = [];

  async start(): Promise<DeviceCode> {
    this.starts++;
    if (this.startFailWith) throw this.startFailWith;
    return this.code;
  }

  async poll(deviceCode: string): Promise<DevicePoll> {
    this.polled.push(deviceCode);
    const next = this.polls.length > 1 ? this.polls.shift()! : this.polls[0]!;
    return next;
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
    deviceClientId: "",
    sessionSecret: "a-test-secret-that-is-long-enough",
    port: 0,
    databasePath: ":memory:",
    webOrigin: "http://localhost:5181",
    codeAnalysis: true,
    jira: {
      clientId: "atlassian-client-id",
      clientSecret: "atlassian-client-secret",
      redirectUri: "http://localhost:5181/api/auth/jira/callback",
    },
    ...overrides,
  };
}

/** Resolves once no crawl is running, so a test can assert on what a background crawl stored. */
export async function settled(isCrawling: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && isCrawling(); i++) await new Promise((r) => setTimeout(r, 5));
}
