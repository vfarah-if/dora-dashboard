import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, UpstreamError } from "../src/core/errors.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { CrawlService } from "../src/services/crawl-service.js";
import { FakeProvider, pr, run } from "./fakes.js";

describe("CrawlService", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let crawler: CrawlService;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    crawler = new CrawlService(store, provider);
    provider.seed("acme/widgets", {
      prs: [1, 2, 3, 4, 5].map((n) => pr({ number: n, updatedAt: `2026-09-0${n}T12:00:00Z` })),
      runs: [run({ runId: 1 }), run({ runId: 2, workflow: "other.yml" })],
    });
    repoId = store.addRepo("acme", "widgets", ["deploy.yml"], "main").id;
  });

  it("reads every page and only the configured workflow's runs on a first crawl", async () => {
    await crawler.crawl("token", repoId);

    expect(store.counts(repoId)).toEqual({ pullRequests: 5, deployRuns: 1, issues: 0 });
    expect(provider.pagesServed).toBe(3);
    const repo = store.getRepo(repoId)!;
    expect(repo.crawlStatus).toBe("idle");
    expect(repo.lastCrawledAt).not.toBeNull();
  });

  it("stops at the first page holding nothing newer than the previous crawl", async () => {
    await crawler.crawl("token", repoId);
    provider.pagesServed = 0;
    provider.repos.get("acme/widgets")!.prs.push(pr({ number: 6, title: "new", updatedAt: "2026-09-08T12:00:00Z" }));

    await crawler.crawl("token", repoId);

    expect(provider.pagesServed).toBe(1);
    expect(store.counts(repoId).pullRequests).toBe(6);
  });

  it("re-reads everything on a full crawl", async () => {
    await crawler.crawl("token", repoId);
    provider.pagesServed = 0;

    await crawler.crawl("token", repoId, true);

    expect(provider.pagesServed).toBe(3);
  });

  it("replaces deploy runs whole, because a re-run changes a run's conclusion", async () => {
    await crawler.crawl("token", repoId);
    provider.repos.get("acme/widgets")!.runs = [run({ runId: 1, conclusion: "failure" })];

    await crawler.crawl("token", repoId);

    expect(store.deployRuns(repoId)).toEqual([expect.objectContaining({ runId: 1, conclusion: "failure" })]);
  });

  it("records a failure on the repository and rethrows it", async () => {
    provider.failWith = new UpstreamError("rate limited", 403);

    await expect(crawler.crawl("token", repoId)).rejects.toThrow("rate limited");

    expect(store.getRepo(repoId)).toMatchObject({ crawlStatus: "failed", crawlError: "rate limited" });
    expect(crawler.isCrawling(repoId)).toBe(false);
  });

  it("keeps the pages it already stored when a later page fails", async () => {
    provider.failWith = new UpstreamError("bad gateway", 502);
    provider.failAfterPages = 1;

    await expect(crawler.crawl("token", repoId)).rejects.toThrow("bad gateway");

    expect(store.counts(repoId).pullRequests).toBe(2); // the first page of two
    expect(store.getRepo(repoId)).toMatchObject({ crawlStatus: "failed", crawlError: "bad gateway" });
  });

  it("ignores a second crawl of the same repository while one is running", async () => {
    const first = crawler.crawl("token", repoId);
    await crawler.crawl("token", repoId);
    await first;

    expect(provider.pagesServed).toBe(3);
  });

  it("refuses an unknown repository", async () => {
    await expect(crawler.crawl("token", 999)).rejects.toBeInstanceOf(NotFoundError);
  });
});
