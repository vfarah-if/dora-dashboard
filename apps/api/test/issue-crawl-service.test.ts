import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { Logger } from "../src/interfaces/logger.js";
import { CrawlService } from "../src/services/crawl-service.js";
import { IssueCrawlService } from "../src/services/issue-crawl-service.js";
import { FakeIssueProvider, FakeProvider, issue, pr } from "./fakes.js";

/** Five issues, one a day from 1 to 5 September, so the newest is 5 September at noon. */
const seeded = () => [1, 2, 3, 4, 5].map((n) => issue({ number: n, updatedAt: `2026-09-0${n}T12:00:00Z` }));

describe("IssueCrawlService", () => {
  let store: SqliteRepoStore;
  let issues: FakeIssueProvider;
  let service: IssueCrawlService;
  let repoId: number;
  const repo = () => store.getRepo(repoId)!;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    issues = new FakeIssueProvider();
    service = new IssueCrawlService(store, issues);
    issues.seed("acme/widgets", seeded());
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("takes every page on a first read, and leaves the cursor five minutes before the newest issue", async () => {
    await service.read("token", repo(), false);

    expect(
      store
        .issues(repoId)
        .map((i) => i.number)
        .sort(),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(issues.pagesServed).toBe(3);
    expect(store.issueState(repoId)).toMatchObject({ enabled: true, cursor: "2026-09-05T11:55:00.000Z", error: null });
    expect(issues.calls[0]).toMatchObject({ token: "token", owner: "acme", name: "widgets", updatedSince: null, cursor: null });
  });

  it("shows progress as it reads", async () => {
    const shown: (string | null)[] = [];
    issues.onPage = () => shown.push(repo().crawlProgress);

    await service.read("token", repo(), false);

    expect(shown).toEqual(["Reading issues", "Read 2 of 5 issues", "Read 4 of 5 issues"]);
    expect(repo().crawlProgress).toBe("Read 5 of 5 issues");
  });

  it("asks only for issues updated since the cursor on an incremental read", async () => {
    await service.read("token", repo(), false);
    issues.pagesServed = 0;
    issues.issuesOf("acme/widgets").push(issue({ number: 6, title: "new", updatedAt: "2026-09-08T12:00:00Z" }));

    await service.read("token", repo(), false);

    expect(issues.pagesServed).toBe(1);
    expect(store.counts(repoId).issues).toBe(6);
    expect(issues.calls.at(-1)).toMatchObject({ updatedSince: "2026-09-05T11:55:00.000Z" });
  });

  it("stops at the first page holding nothing newer, and writes only the new issue and the overlap", async () => {
    await service.read("token", repo(), false);
    // A host that ignores the lower bound would serve all six issues; the service must stop by itself.
    issues.ignoreUpdatedSince = true;
    issues.issuesOf("acme/widgets").push(issue({ number: 6, title: "new", updatedAt: "2026-09-08T12:00:00Z" }));
    for (const held of issues.issuesOf("acme/widgets")) held.title = `edited ${held.number}`;
    issues.pagesServed = 0;

    await service.read("token", repo(), false);

    // Pages are [6, 5], [4, 3], [2, 1]. The cursor is 11:55 on the 5th, so 6 is new and 5 sits in the overlap
    // (12:00 is after 11:55); 4 is older, so page 2 is where the read stops and page 3 is never asked for.
    expect(issues.pagesServed).toBe(2);
    const titles = new Map(store.issues(repoId).map((i) => [i.number, i.title]));
    expect(titles.get(6)).toBe("edited 6");
    expect(titles.get(5)).toBe("edited 5");
    expect([1, 2, 3, 4].map((n) => titles.get(n))).toEqual(["Issue 1", "Issue 2", "Issue 3", "Issue 4"]);
    expect(store.issueState(repoId).cursor).toBe("2026-09-08T11:55:00.000Z");
  });

  it("treats an issue updated in the same second as the cursor as not newer, whatever the spelling", async () => {
    await service.read("token", repo(), false);
    // The cursor is 11:55:00.000Z; GitHub writes the same instant as 11:55:00Z, which sorts after it as a string.
    const five = issues.issuesOf("acme/widgets").find((i) => i.number === 5)!;
    five.title = "same instant";
    five.updatedAt = "2026-09-05T11:55:00Z";

    await service.read("token", repo(), false);

    expect(store.issues(repoId).find((i) => i.number === 5)!.title).not.toBe("same instant");
  });

  it("re-reads an issue that changed inside the overlap, and ignores one at or before the cursor", async () => {
    await service.read("token", repo(), false);
    // 11:57 is inside the five minute overlap before the 12:00 newest, so it is read again; the older issues are not.
    issues.issuesOf("acme/widgets").find((i) => i.number === 5)!.title = "edited";
    issues.issuesOf("acme/widgets").find((i) => i.number === 5)!.updatedAt = "2026-09-05T11:57:00Z";
    issues.issuesOf("acme/widgets").find((i) => i.number === 4)!.title = "stale edit";

    await service.read("token", repo(), false);

    const held = store.issues(repoId);
    expect(held.find((i) => i.number === 5)!.title).toBe("edited");
    expect(held.find((i) => i.number === 4)!.title).toBe("Issue 4");
  });

  it("keeps the cursor when an incremental read finds nothing new", async () => {
    await service.read("token", repo(), false);
    const before = store.issueState(repoId).cursor;
    issues.issuesOf("acme/widgets").splice(0);

    await service.read("token", repo(), false);

    expect(store.issueState(repoId).cursor).toBe(before);
  });

  it("re-reads everything on a full read, and prunes issues the host no longer holds", async () => {
    await service.read("token", repo(), false);
    issues.pagesServed = 0;
    issues.issuesOf("acme/widgets").splice(0, 2);

    await service.read("token", repo(), true);

    expect(issues.pagesServed).toBe(2);
    expect(
      store
        .issues(repoId)
        .map((i) => i.number)
        .sort(),
    ).toEqual([3, 4, 5]);
  });

  it("does not prune on an incremental read, which saw only the recent issues", async () => {
    await service.read("token", repo(), false);
    issues.issuesOf("acme/widgets").splice(0, 4);

    await service.read("token", repo(), false);

    expect(store.counts(repoId).issues).toBe(5);
  });

  it("clears issues, cursor and error together when issues are switched off, and records that", async () => {
    await service.read("token", repo(), false);
    store.failIssueCrawl(repoId, "earlier failure");
    issues.setEnabled("acme/widgets", false);

    await service.read("token", repo(), false);

    expect(store.counts(repoId).issues).toBe(0);
    expect(store.issueState(repoId)).toEqual({
      enabled: false,
      cursor: null,
      labels: null,
      labelsUnreadable: false,
      error: null,
    });
  });

  it("reads from the start when issues are switched on again", async () => {
    await service.read("token", repo(), false);
    issues.setEnabled("acme/widgets", false);
    await service.read("token", repo(), false);
    issues.setEnabled("acme/widgets", true);

    await service.read("token", repo(), false);

    expect(store.counts(repoId).issues).toBe(5);
    expect(issues.calls.at(-3)).toMatchObject({ updatedSince: null });
  });

  it("stops quietly, finishing nothing, when the repository is deleted mid-read", async () => {
    const warnings: unknown[] = [];
    const log: Logger = { info: () => undefined, error: () => undefined, warn: (context) => void warnings.push(context) };
    const quiet = new IssueCrawlService(store, issues, log);
    const target = repo();
    issues.onPage = () => store.deleteRepo(repoId);

    await quiet.read("token", target, false);

    expect(issues.pagesServed).toBe(1);
    expect(warnings).toEqual([{ repoId }]);
    expect(store.counts(repoId).issues).toBe(0);
  });

  it("refuses a page holding an update time that is not a date, storing and pruning nothing and keeping the cursor", async () => {
    await service.read("token", repo(), false);
    const cursor = store.issueState(repoId).cursor;
    const before = store.issues(repoId);
    issues.seed("acme/widgets", [
      issue({ number: 9, updatedAt: "2026-09-09T12:00:00Z" }),
      issue({ number: 1, updatedAt: "yesterday" }),
    ]);

    await expect(service.read("token", repo(), true)).rejects.toMatchObject({
      name: "UpstreamError",
      status: 502,
      message: expect.stringContaining("issue #1"),
    });

    expect(store.issues(repoId)).toEqual(before);
    expect(store.issueState(repoId).cursor).toBe(cursor);
  });

  it("leaves the previous cursor in place when a full read fails on a later page", async () => {
    await service.read("token", repo(), false);
    const cursor = store.issueState(repoId).cursor;
    issues.failAfterPages = issues.pagesServed + 1;
    issues.failWith = new UpstreamError("GitHub answered 502", 502);

    await expect(service.read("token", repo(), true)).rejects.toThrow("GitHub answered 502");

    expect(store.issueState(repoId).cursor).toBe(cursor);
    expect(store.counts(repoId).issues).toBe(5);
  });

  it("removes every stored issue on a full read when the host now holds none", async () => {
    await service.read("token", repo(), false);
    issues.issuesOf("acme/widgets").splice(0);

    await service.read("token", repo(), true);

    expect(store.counts(repoId).issues).toBe(0);
  });
});

describe("the repository crawl with issues", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let issues: FakeIssueProvider;
  let warnings: { err?: unknown }[];
  let errors: unknown[];
  let crawler: CrawlService;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    issues = new FakeIssueProvider();
    warnings = [];
    errors = [];
    const log: Logger = {
      info: () => undefined,
      warn: (context) => void warnings.push(context as { err?: unknown }),
      error: (context) => void errors.push(context),
    };
    crawler = new CrawlService(store, provider, undefined, log, new IssueCrawlService(store, issues, log));
    provider.seed("acme/widgets", { prs: [pr({ number: 1 })] });
    issues.seed("acme/widgets", seeded());
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("reads issues as part of the crawl", async () => {
    await crawler.crawl("token", repoId);

    expect(store.counts(repoId)).toEqual({ pullRequests: 1, deployRuns: 0, issues: 5 });
    expect(store.getRepo(repoId)).toMatchObject({ crawlStatus: "idle", crawlProgress: null, crawlError: null });
  });

  it("reads issues after the pull requests, so a full crawl resets both cursors", async () => {
    await crawler.crawl("token", repoId);
    issues.calls.length = 0;

    await crawler.crawl("token", repoId, true);

    expect(issues.calls[0]).toMatchObject({ updatedSince: null });
  });

  it("finishes the crawl idle and records the failure when issues cannot be read, leaving the cursor", async () => {
    await crawler.crawl("token", repoId);
    const cursor = store.issueState(repoId).cursor;
    issues.failWith = new UpstreamError("GitHub answered 500", 500);

    await crawler.crawl("token", repoId);

    expect(store.getRepo(repoId)).toMatchObject({ crawlStatus: "idle", crawlError: null });
    expect(store.issueState(repoId)).toMatchObject({ error: "GitHub answered 500", cursor });
    expect(warnings).toEqual([expect.objectContaining({ repoId })]);
    expect(store.counts(repoId).pullRequests).toBe(1);
  });

  it("clears the recorded failure once a later read succeeds", async () => {
    issues.failWith = new NotFoundError("gone");
    await crawler.crawl("token", repoId);
    expect(store.issueState(repoId).error).toBe("gone");
    issues.failWith = null;

    await crawler.crawl("token", repoId);

    expect(store.issueState(repoId).error).toBeNull();
  });

  it("keeps what an interrupted read stored, and leaves the cursor unmoved", async () => {
    issues.failAfterPages = 1;
    issues.failWith = new UpstreamError("GitHub answered 502", 502);

    await crawler.crawl("token", repoId);

    expect(store.counts(repoId).issues).toBe(2);
    expect(store.issueState(repoId)).toMatchObject({ cursor: null, error: "GitHub answered 502" });
  });

  it("stores a neutral message, and logs at error, for a failure that was not raised on purpose", async () => {
    issues.failWith = new TypeError("secret detail");

    await crawler.crawl("token", repoId);

    expect(store.issueState(repoId).error).toBe("Reading issues failed unexpectedly. See the API log.");
    expect(errors).toHaveLength(1);
    expect(store.getRepo(repoId)!.crawlStatus).toBe("idle");
  });

  it("fails the crawl, rather than storing an issue error, when the credential is rejected during the issue read", async () => {
    issues.failWith = new UnauthorisedError("GitHub rejected the credential; sign in again");

    await expect(crawler.crawl("token", repoId)).rejects.toBeInstanceOf(UnauthorisedError);

    expect(store.getRepo(repoId)).toMatchObject({
      crawlStatus: "failed",
      crawlError: "GitHub rejected the credential; sign in again",
    });
    expect(store.issueState(repoId).error).toBeNull();
  });

  it("behaves as before when no issue service is wired", async () => {
    const plain = new CrawlService(store, provider);

    await plain.crawl("token", repoId);

    expect(store.counts(repoId)).toEqual({ pullRequests: 1, deployRuns: 0, issues: 0 });
    expect(store.issueState(repoId)).toEqual({ enabled: null, cursor: null, labels: null, labelsUnreadable: false, error: null });
    expect(issues.calls).toHaveLength(0);
  });
});
