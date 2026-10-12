import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { GitHubProvider } from "../src/infrastructure/github/github-provider.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { Logger } from "../src/interfaces/logger.js";
import type { CodeHealthService } from "../src/services/code-health-service.js";
import type { CoverageService } from "../src/services/coverage-service.js";
import { CrawlService, type SecurityStep } from "../src/services/crawl-service.js";
import type { IssueCrawlService } from "../src/services/issue-crawl-service.js";
import { FakeProvider, pr, run } from "./fakes.js";

function recordingLog() {
  const warnings: { context: Record<string, unknown>; message: string }[] = [];
  const log: Logger = {
    info: () => undefined,
    error: () => undefined,
    warn: (context, message) => void warnings.push({ context: context as Record<string, unknown>, message }),
  };
  return { log, warnings };
}

describe("the security step of a crawl", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let repoId: number;
  let order: string[];
  let progress: (string | null)[];

  const step = (read: SecurityStep["read"]): SecurityStep => ({ read });
  const issues = { read: async () => void order.push("issues") } as unknown as IssueCrawlService;
  const codeHealth = { analyse: async () => void order.push("code") } as unknown as CodeHealthService;
  const coverage = { read: async () => void order.push("coverage") } as unknown as CoverageService;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    provider.seed("acme/widgets", { prs: [pr({ number: 1 })], runs: [run({ runId: 1 })] });
    repoId = store.addRepo("acme", "widgets", ["deploy.yml"], "release").id;
    order = [];
    progress = [];
  });

  it("runs after the code step and before coverage, handing over the token, the repository and whether the crawl is full", async () => {
    const calls: unknown[][] = [];
    const security = step(async (token, repo, full) => {
      order.push("security");
      progress.push(store.getRepo(repoId)!.crawlProgress);
      calls.push([token, repo.id, repo.owner, repo.name, repo.deployBranch, full]);
    });
    const crawler = new CrawlService(store, provider, { issues, codeHealth, security, coverage });

    await crawler.crawl("tok", repoId, true);
    await crawler.crawl("tok2", repoId);

    expect(order).toEqual(["issues", "code", "security", "coverage", "issues", "code", "security", "coverage"]);
    expect(progress).toEqual(["Reading security alerts", "Reading security alerts"]);
    expect(calls).toEqual([
      ["tok", repoId, "acme", "widgets", "release", true],
      ["tok2", repoId, "acme", "widgets", "release", false],
    ]);
    expect(store.getRepo(repoId)).toMatchObject({ crawlStatus: "idle", crawlProgress: null });
  });

  it("reads security even when there is no code health, issue or coverage step", async () => {
    const read = vi.fn(async () => undefined);
    await new CrawlService(store, provider, { security: { read } }).crawl("t", repoId);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("logs a step that throws, and carries on to coverage and the end of the crawl", async () => {
    const logged = recordingLog();
    const security = step(async () => {
      throw new UpstreamError("GitHub answered 500", 500);
    });
    const crawler = new CrawlService(store, provider, { security, coverage, log: logged.log });

    await expect(crawler.crawl("t", repoId)).resolves.toBeUndefined();

    expect(order).toEqual(["coverage"]);
    expect(store.getRepo(repoId)).toMatchObject({ crawlStatus: "idle", crawlError: null });
    expect(store.counts(repoId).pullRequests).toBe(1);
    expect(logged.warnings).toEqual([
      {
        context: { err: new UpstreamError("GitHub answered 500", 500), repoId },
        message: "security step failed, and the crawl went on",
      },
    ]);
  });

  it("fails the crawl for a rejected credential, as issues and coverage do, and skips coverage", async () => {
    const security = step(async () => {
      throw new UnauthorisedError("GitHub rejected the credential; sign in again");
    });
    const crawler = new CrawlService(store, provider, { security, coverage });

    await expect(crawler.crawl("t", repoId)).rejects.toBeInstanceOf(UnauthorisedError);

    expect(order).toEqual([]);
    expect(store.getRepo(repoId)).toMatchObject({
      crawlStatus: "failed",
      crawlError: "GitHub rejected the credential; sign in again",
    });
  });

  it("is not called for a repository that does not exist, or while its crawl is already running", async () => {
    const read = vi.fn(async () => {
      // A second crawl of the same repository, started while the first is reading security, does nothing.
      await crawler.crawl("t", repoId);
    });
    const crawler = new CrawlService(store, provider, { security: { read } });

    await expect(crawler.crawl("t", 999)).rejects.toThrow("Unknown repository");
    expect(read).not.toHaveBeenCalled();

    await crawler.crawl("t", repoId);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("reviews read from GitHub for the stored pull requests", () => {
  const node = (reviews: unknown[]) => ({
    number: 12,
    title: "Add widgets",
    url: "https://github.com/acme/widgets/pull/12",
    state: "MERGED",
    createdAt: "2026-09-01T10:00:00Z",
    publishedAt: "2026-09-01T10:00:00Z",
    mergedAt: "2026-09-01T11:00:00Z",
    closedAt: "2026-09-01T11:00:00Z",
    updatedAt: "2026-09-01T11:00:00Z",
    additions: 5,
    deletions: 1,
    baseRefName: "main",
    headRefName: "feature",
    author: { login: "alice", __typename: "User" },
    mergedBy: { login: "alice" },
    commits: { nodes: [] },
    reviews: { nodes: reviews },
  });

  it("asks for the reviewer's type and stores authorIsBot on each review", async () => {
    const http = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  totalCount: 1,
                  nodes: [
                    node([
                      {
                        author: { login: "review-helper", __typename: "Bot" },
                        state: "APPROVED",
                        submittedAt: "2026-09-01T10:30:00Z",
                      },
                      { author: { login: "bob", __typename: "User" }, state: "APPROVED", submittedAt: "2026-09-01T10:40:00Z" },
                      { author: null, state: "COMMENTED", submittedAt: "2026-09-01T10:50:00Z" },
                    ]),
                  ],
                },
              },
            },
          }),
          { status: 200 },
        ),
    );
    const store = new SqliteRepoStore(":memory:");
    const repoId = store.addRepo("acme", "widgets", [], "main").id;

    await new CrawlService(store, new GitHubProvider(http)).crawl("t", repoId);

    const sent = JSON.parse(http.mock.calls[0]![1]!.body as string).query as string;
    expect(sent).toContain("reviews(first: 100) { nodes { author { login __typename } state submittedAt } }");
    const [stored] = store.pullRequests(repoId);
    expect(stored!.reviews.map((r) => ({ author: r.author, authorIsBot: r.authorIsBot }))).toEqual([
      { author: "review-helper", authorIsBot: true },
      { author: "bob", authorIsBot: false },
      { author: null, authorIsBot: undefined },
    ]);
  });
});
