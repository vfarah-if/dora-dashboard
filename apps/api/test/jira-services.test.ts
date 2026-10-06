import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { ConflictError, NotFoundError, TrackerUnauthorisedError, UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { MemoryTrackerGrantStore } from "../src/infrastructure/auth/memory-tracker-grant-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { JiraAuthService } from "../src/services/jira-auth-service.js";
import { SPACE_LIST_TTL_MS, TrackerService } from "../src/services/tracker-service.js";
import { WorkItemCrawlService } from "../src/services/work-item-crawl-service.js";
import { FakeTrackerAuthorisation, FakeWorkItemProvider, grant, settled, SITE, workItem } from "./fakes.js";

const T0 = 1_000_000_000;

describe("JiraAuthService", () => {
  let auth: FakeTrackerAuthorisation;
  let grants: MemoryTrackerGrantStore;
  let now: number;
  let service: JiraAuthService;

  beforeEach(() => {
    auth = new FakeTrackerAuthorisation();
    grants = new MemoryTrackerGrantStore();
    now = T0;
    service = new JiraAuthService(auth, grants, () => now);
  });

  it("connects by exchanging the code and keeping the grant for that login only", async () => {
    auth.exchangeGrant = grant({ accessToken: "fresh", expiresAt: T0 + 3_600_000 });
    await service.connect("alice", "the-code");

    expect(auth.codes).toEqual(["the-code"]);
    expect(service.isConnected("alice")).toBe(true);
    expect(service.isConnected("bob")).toBe(false);
    expect(await service.accessToken("alice")).toBe("fresh");
  });

  it("does not store a grant when the exchange fails", async () => {
    auth.exchangeFailWith = new UpstreamError("Atlassian said no", 400);
    await expect(service.connect("alice", "bad")).rejects.toBeInstanceOf(UpstreamError);
    expect(service.isConnected("alice")).toBe(false);
  });

  it("returns the stored token without refreshing while more than a minute remains", async () => {
    grants.set("alice", grant({ accessToken: "current", expiresAt: T0 + 61_000 }));
    expect(await service.accessToken("alice")).toBe("current");
    expect(auth.refreshTokens).toEqual([]);
  });

  it("refreshes within a minute of expiry and stores the rotated grant", async () => {
    grants.set("alice", grant({ accessToken: "old", refreshToken: "refresh-old", expiresAt: T0 + 59_000 }));
    auth.refreshGrants = [grant({ accessToken: "new", refreshToken: "refresh-new", expiresAt: T0 + 3_600_000 })];

    expect(await service.accessToken("alice")).toBe("new");
    expect(auth.refreshTokens).toEqual(["refresh-old"]);
    expect(grants.get("alice")).toEqual({ accessToken: "new", refreshToken: "refresh-new", expiresAt: T0 + 3_600_000 });

    // The rotated grant is now the one in use: no second refresh.
    expect(await service.accessToken("alice")).toBe("new");
    expect(auth.refreshTokens).toHaveLength(1);
  });

  it("keeps the old refresh token when the refresh issues none", async () => {
    grants.set("alice", grant({ refreshToken: "refresh-old", expiresAt: T0 - 1 }));
    auth.refreshGrants = [grant({ accessToken: "new", refreshToken: null, expiresAt: T0 + 3_600_000 })];

    await service.accessToken("alice");

    expect(grants.get("alice")!.refreshToken).toBe("refresh-old");
  });

  it("shares one refresh between concurrent callers for the same login", async () => {
    grants.set("alice", grant({ expiresAt: T0 - 1 }));
    let release!: () => void;
    auth.refreshGate = new Promise<void>((resolve) => (release = resolve));

    const callers = [service.accessToken("alice"), service.accessToken("alice"), service.accessToken("alice")];
    release();

    expect(await Promise.all(callers)).toEqual(["access-2", "access-2", "access-2"]);
    expect(auth.refreshTokens).toHaveLength(1);
  });

  it("refreshes separately for different logins", async () => {
    grants.set("alice", grant({ refreshToken: "ra", expiresAt: T0 - 1 }));
    grants.set("bob", grant({ refreshToken: "rb", expiresAt: T0 - 1 }));
    await Promise.all([service.accessToken("alice"), service.accessToken("bob")]);
    expect(auth.refreshTokens.sort()).toEqual(["ra", "rb"]);
  });

  it("asks the person to connect when there is no grant", async () => {
    const error = await service.accessToken("alice").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TrackerUnauthorisedError);
    expect(error).toBeInstanceOf(UnauthorisedError);
    expect((error as Error).message).toBe("Jira is not connected. Connect Jira first");
  });

  it("asks the person to connect again, and forgets the grant, when Atlassian refuses the refresh token", async () => {
    grants.set("alice", grant({ expiresAt: T0 - 1 }));
    auth.refreshFailWith = new UnauthorisedError("refused");

    await expect(service.accessToken("alice")).rejects.toThrow("Connect Jira again");
    expect(service.isConnected("alice")).toBe(false);
  });

  it("asks the person to connect again on a transient refresh failure but keeps the grant for another try", async () => {
    grants.set("alice", grant({ expiresAt: T0 - 1 }));
    auth.refreshFailWith = new UpstreamError("Atlassian is down", 503);

    await expect(service.accessToken("alice")).rejects.toBeInstanceOf(TrackerUnauthorisedError);
    expect(service.isConnected("alice")).toBe(true);

    // And a later attempt, once Atlassian is back, succeeds.
    auth.refreshFailWith = null;
    expect(await service.accessToken("alice")).toBe("access-2");
  });

  it("raises once an access token with no refresh token has expired, but serves it until then", async () => {
    grants.set("alice", grant({ accessToken: "only", refreshToken: null, expiresAt: T0 + 30_000 }));
    expect(await service.accessToken("alice")).toBe("only");

    now = T0 + 30_000;
    await expect(service.accessToken("alice")).rejects.toThrow("Connect Jira again");
    expect(auth.refreshTokens).toEqual([]);
  });

  it("does not restore the old grant when the person disconnects while a refresh is out", async () => {
    grants.set("alice", grant({ expiresAt: T0 - 1 }));
    let release!: () => void;
    auth.refreshGate = new Promise<void>((resolve) => (release = resolve));

    const caller = service.accessToken("alice");
    service.disconnect("alice");
    release();

    await expect(caller).rejects.toBeInstanceOf(TrackerUnauthorisedError);
    expect(service.isConnected("alice")).toBe(false);
  });

  it("keeps the new grant when the person connects again while a refresh is out", async () => {
    grants.set("alice", grant({ accessToken: "old", expiresAt: T0 - 1 }));
    let release!: () => void;
    auth.refreshGate = new Promise<void>((resolve) => (release = resolve));

    const caller = service.accessToken("alice");
    auth.exchangeGrant = grant({ accessToken: "reconnected", refreshToken: "refresh-new", expiresAt: T0 + 3_600_000 });
    await service.connect("alice", "code");
    release();

    expect(await caller).toBe("reconnected");
    expect(grants.get("alice")!.accessToken).toBe("reconnected");
  });

  it("forgets the grant on disconnect", async () => {
    grants.set("alice", grant());
    service.disconnect("alice");
    expect(service.isConnected("alice")).toBe(false);
  });
});

function setUp() {
  const store = new SqliteRepoStore(":memory:");
  const provider = seededProvider();
  const auth = new FakeTrackerAuthorisation();
  const grants = new MemoryTrackerGrantStore();
  const state = { now: T0 };
  const jira = new JiraAuthService(auth, grants, () => state.now);
  grants.set("alice", grant({ accessToken: "access-1", expiresAt: T0 + 120_000 }));
  const repoId = store.addRepo("acme", "widgets", [], "main").id;
  const [space] = store.linkSpaces(repoId, SITE.id, [{ siteId: SITE.id, siteUrl: SITE.url, key: "WID", name: "Widgets" }]);
  const crawler = new WorkItemCrawlService(store, provider, jira);
  return { store, provider, auth, grants, state, jira, repoId, space: space!, crawler };
}

function seededProvider() {
  const provider = new FakeWorkItemProvider();
  provider.seedSite(SITE);
  provider.seedSpace(SITE.id, "WID", {
    name: "Widgets",
    statuses: [
      { id: "1", name: "To Do", category: "todo" },
      { id: "2", name: "In Review", category: "in_progress" },
      { id: "3", name: "Done", category: "done" },
    ],
    columns: [{ name: "Review", statusIds: ["2"] }],
    items: [
      workItem({ key: "WID-1", updatedAt: "2026-09-01T10:00:00Z" }),
      workItem({ key: "WID-2", updatedAt: "2026-09-02T10:00:00Z" }),
      workItem({ key: "WID-3", updatedAt: "2026-09-03T10:00:00Z" }),
      workItem({ key: "WID-4", updatedAt: "2026-09-04T10:00:00Z" }),
      workItem({ key: "WID-5", updatedAt: "2026-09-05T10:00:00Z" }),
    ],
  });
  return provider;
}

describe("WorkItemCrawlService", () => {
  it("reads every page on a full crawl, saves statuses and columns, and records the newest update as the cursor", async () => {
    const { store, provider, space, crawler } = setUp();

    await crawler.crawl("alice", space.id, true);

    expect(
      store
        .workItems(space.id)
        .map((i) => i.key)
        .sort(),
    ).toEqual(["WID-1", "WID-2", "WID-3", "WID-4", "WID-5"]);
    // Five items at two a page is three pages.
    expect(provider.pagesServed).toBe(3);
    const stored = store.getSpace(space.id)!;
    expect(stored.statuses.map((s) => s.name)).toEqual(["To Do", "In Review", "Done"]);
    expect(stored.columns).toEqual([{ name: "Review", statusIds: ["2"] }]);
    expect(stored).toMatchObject({ crawlStatus: "idle", crawlError: null, crawlProgress: null });
    expect(stored.lastCrawledAt).not.toBeNull();
    expect(store.spaceCrawlCursor(space.id)).toBe("2026-09-05T09:55:00.000Z");
  });

  it("shows how many work items have been read as it goes", async () => {
    const { store, provider, space, crawler } = setUp();
    const seen: (string | null)[] = [];
    provider.onPage = () => seen.push(store.getSpace(space.id)!.crawlProgress);

    await crawler.crawl("alice", space.id);

    expect(seen).toEqual(["Reading work items", "Read 2 work items", "Read 4 work items"]);
  });

  it("asks for everything on a full crawl, even when a cursor is stored", async () => {
    const { store, provider, space, crawler } = setUp();
    store.finishSpaceCrawl(space.id, "2026-09-04T10:00:00Z");

    await crawler.crawl("alice", space.id, true);

    const asked = provider.calls.filter((c) => c.method === "fetchWorkItemPage").map((c) => c.updatedSince);
    expect(asked).toEqual([null, null, null]);
    expect(store.workItemCount(space.id)).toBe(5);
  });

  it("asks only for items updated since the cursor on an incremental crawl", async () => {
    const { provider, space, crawler } = setUp();
    await crawler.crawl("alice", space.id, true);
    provider.calls.length = 0;
    provider.pagesServed = 0;

    await crawler.crawl("alice", space.id);

    const asked = provider.calls.filter((c) => c.method === "fetchWorkItemPage");
    expect(asked.map((c) => c.updatedSince)).toEqual(["2026-09-05T09:55:00.000Z"]);
    expect(provider.pagesServed).toBe(1);
  });

  it("stops at the first page holding nothing newer, and stores only what is newer", async () => {
    const { store, provider, space, crawler } = setUp();
    await crawler.crawl("alice", space.id, true);
    // A tracker that ignores the lower bound would serve all of this; the crawl must stop by itself.
    provider.ignoreUpdatedSince = true;
    provider.seedSpace(SITE.id, "WID", {
      name: "Widgets",
      items: [
        workItem({ key: "WID-6", updatedAt: "2026-09-06T10:00:00Z", status: "Newly changed" }),
        ...store.workItems(space.id),
      ],
    });
    provider.pagesServed = 0;

    await crawler.crawl("alice", space.id);

    // The cursor is 09:55 on the 5th, so page 1 (WID-6, WID-5) is all newer and page 2 (WID-4, WID-3) is not.
    expect(provider.pagesServed).toBe(2);
    expect(store.workItemCount(space.id)).toBe(6);
    expect(store.workItems(space.id).find((i) => i.key === "WID-6")!.status).toBe("Newly changed");
    expect(store.spaceCrawlCursor(space.id)).toBe("2026-09-06T09:55:00.000Z");
  });

  it("keeps the cursor when an incremental crawl finds nothing new", async () => {
    const { store, space, crawler } = setUp();
    await crawler.crawl("alice", space.id, true);
    store.setSpaceCrawlState(space.id, "idle", null);

    await crawler.crawl("alice", space.id);

    expect(store.spaceCrawlCursor(space.id)).toBe("2026-09-05T09:55:00.000Z");
    expect(store.getSpace(space.id)!.crawlStatus).toBe("idle");
  });

  it("marks the space failed with the reason, and raises, when the tracker fails", async () => {
    const { store, provider, space, crawler } = setUp();
    provider.failWith = new UpstreamError("Jira answered 503", 503);

    await expect(crawler.crawl("alice", space.id)).rejects.toThrow("Jira answered 503");

    expect(store.getSpace(space.id)).toMatchObject({
      crawlStatus: "failed",
      crawlError: "Jira answered 503",
      crawlProgress: null,
    });
    expect(crawler.isCrawling()).toBe(false);
  });

  it("keeps what earlier pages stored and does not move the cursor when a later page fails", async () => {
    const { store, provider, space, crawler } = setUp();
    provider.failWith = new UpstreamError("Jira answered 502", 502);
    provider.failAfterPages = 1;

    await expect(crawler.crawl("alice", space.id, true)).rejects.toBeInstanceOf(UpstreamError);

    expect(store.workItemCount(space.id)).toBe(2);
    expect(store.spaceCrawlCursor(space.id)).toBeNull();
    expect(store.getSpace(space.id)!.crawlStatus).toBe("failed");
  });

  it("fails readably when the person is not connected", async () => {
    const { store, grants, space, crawler } = setUp();
    grants.delete("alice");

    await expect(crawler.crawl("alice", space.id)).rejects.toBeInstanceOf(TrackerUnauthorisedError);

    expect(store.getSpace(space.id)).toMatchObject({
      crawlStatus: "failed",
      crawlError: "Jira is not connected. Connect Jira first",
    });
  });

  it("reports whether a crawl ran, false when the space was already being crawled", async () => {
    const { space, crawler } = setUp();
    const first = crawler.crawl("alice", space.id, true);
    expect(await crawler.crawl("alice", space.id, true)).toBe(false);
    expect(await first).toBe(true);
  });

  it("removes stored work items the space no longer holds once a full crawl completes", async () => {
    const { store, provider, space, crawler } = setUp();
    await crawler.crawl("alice", space.id, true);
    provider.seedSpace(SITE.id, "WID", {
      name: "Widgets",
      items: [
        workItem({ key: "WID-4", updatedAt: "2026-09-04T10:00:00Z" }),
        workItem({ key: "WID-5", updatedAt: "2026-09-05T10:00:00Z" }),
      ],
    });

    await crawler.crawl("alice", space.id, true);

    expect(
      store
        .workItems(space.id)
        .map((i) => i.key)
        .sort(),
    ).toEqual(["WID-4", "WID-5"]);
  });

  it("keeps everything when a full crawl fails part way", async () => {
    const { store, provider, space, crawler } = setUp();
    await crawler.crawl("alice", space.id, true);
    provider.failWith = new UpstreamError("Jira answered 502", 502);
    provider.failAfterPages = 1;
    provider.pagesServed = 0;

    await expect(crawler.crawl("alice", space.id, true)).rejects.toBeInstanceOf(UpstreamError);

    expect(store.workItemCount(space.id)).toBe(5);
  });

  it("does not remove anything on an incremental crawl", async () => {
    const { store, provider, space, crawler } = setUp();
    await crawler.crawl("alice", space.id, true);
    provider.seedSpace(SITE.id, "WID", {
      name: "Widgets",
      items: [workItem({ key: "WID-5", updatedAt: "2026-09-05T10:00:00Z" })],
    });

    await crawler.crawl("alice", space.id);

    expect(store.workItemCount(space.id)).toBe(5);
  });

  it("re-reads an item tied with the newest at the cursor millisecond", async () => {
    const { store, provider, space, crawler } = setUp();
    await crawler.crawl("alice", space.id, true);
    // Same millisecond as the previous newest, indexed after the crawl finished.
    provider.seedSpace(SITE.id, "WID", {
      name: "Widgets",
      items: [...store.workItems(space.id), workItem({ key: "WID-6", updatedAt: "2026-09-05T10:00:00Z" })],
    });

    await crawler.crawl("alice", space.id);

    expect(store.workItems(space.id).map((i) => i.key)).toContain("WID-6");
  });

  it("picks up an item that appears later with an update 2 minutes older than the previous newest", async () => {
    const { store, provider, space, crawler } = setUp();
    await crawler.crawl("alice", space.id, true);
    provider.seedSpace(SITE.id, "WID", {
      name: "Widgets",
      items: [...store.workItems(space.id), workItem({ key: "WID-7", updatedAt: "2026-09-05T09:58:00Z" })],
    });

    await crawler.crawl("alice", space.id);

    expect(store.workItems(space.id).map((i) => i.key)).toContain("WID-7");
  });

  it("stops without raising when the space is removed during its crawl", async () => {
    const { store, provider, repoId, space, crawler } = setUp();
    provider.onPage = () => store.linkSpaces(repoId, SITE.id, []);

    expect(await crawler.crawl("alice", space.id, true)).toBe(true);

    expect(store.getSpace(space.id)).toBeNull();
    expect(provider.pagesServed).toBe(1);
    expect(crawler.isCrawling()).toBe(false);
  });

  it("starts nothing while the space is already being crawled", async () => {
    const { provider, space, crawler } = setUp();
    const first = crawler.crawl("alice", space.id, true);
    expect(crawler.isCrawling(space.id)).toBe(true);
    expect(crawler.isCrawling(space.id + 1)).toBe(false);

    await crawler.crawl("alice", space.id, true);
    await first;

    // Only the first crawl read anything: three pages, not six.
    expect(provider.pagesServed).toBe(3);
    expect(crawler.isCrawling()).toBe(false);
  });

  it("refreshes an expiring token between pages rather than using the one it started with", async () => {
    const { state, provider, auth, space, crawler } = setUp();
    auth.refreshGrants = [grant({ accessToken: "access-2", refreshToken: "refresh-2", expiresAt: T0 + 3_600_000 })];
    let pages = 0;
    // After the first page the clock reaches the last minute of the first token's life.
    provider.onPage = () => {
      if (++pages === 1) state.now = T0 + 100_000;
    };

    await crawler.crawl("alice", space.id, true);

    const pageTokens = provider.calls.filter((c) => c.method === "fetchWorkItemPage").map((c) => c.token);
    expect(pageTokens).toEqual(["access-1", "access-2", "access-2"]);
    expect(auth.refreshTokens).toEqual(["refresh-1"]);
  });

  it("raises NotFoundError for an unknown space", async () => {
    const { crawler } = setUp();
    await expect(crawler.crawl("alice", 999)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("fails the space, naming the cause, when it is no longer visible on the site", async () => {
    const { store, space, jira } = setUp();
    const gone = new FakeWorkItemProvider();
    gone.seedSite(SITE);

    await expect(new WorkItemCrawlService(store, gone, jira).crawl("alice", space.id)).rejects.toBeInstanceOf(NotFoundError);

    expect(store.getSpace(space.id)).toMatchObject({ crawlStatus: "failed", crawlError: "WID was not found on cloud-1" });
  });
});

describe("TrackerService", () => {
  function tracker(ttlMs?: number) {
    const base = setUp();
    const clock = { now: new Date("2026-09-10T10:00:00Z") };
    const service = new TrackerService(base.store, base.provider, base.jira, base.crawler, () => clock.now, undefined, ttlMs);
    return { ...base, clock, service };
  }

  const spaceListCalls = (provider: FakeWorkItemProvider) => provider.calls.filter((c) => c.method === "listSpaces");

  it("lists sites and spaces as the connected person", async () => {
    const { service, provider } = tracker();
    expect(await service.listSites("alice")).toEqual([SITE]);
    expect(await service.listSpaces("alice", SITE.id)).toEqual([{ key: "WID", name: "Widgets", type: "software" }]);
    expect(provider.tokens).toEqual(["access-1", "access-1"]);
  });

  it("serves a repeat read of the space list from cache within a minute, and reads again after it", async () => {
    const { service, provider, clock } = tracker();
    await service.listSpaces("alice", SITE.id);
    clock.now = new Date(clock.now.getTime() + SPACE_LIST_TTL_MS - 1);
    await service.listSpaces("alice", SITE.id);
    expect(spaceListCalls(provider)).toHaveLength(1);

    clock.now = new Date(clock.now.getTime() + 1);
    await service.listSpaces("alice", SITE.id);
    expect(spaceListCalls(provider)).toHaveLength(2);
  });

  it("does not share a cached list between people holding different tokens", async () => {
    const { service, provider, grants } = tracker();
    grants.set("bob", grant({ accessToken: "access-bob" }));
    await service.listSpaces("alice", SITE.id);
    await service.listSpaces("bob", SITE.id);
    expect(spaceListCalls(provider).map((c) => c.token)).toEqual(["access-1", "access-bob"]);
  });

  it("caches per site", async () => {
    const { service, provider } = tracker();
    provider.seedSite({ id: "cloud-2", url: "https://other.example.test", name: "Other" });
    await service.listSpaces("alice", SITE.id);
    await service.listSpaces("alice", "cloud-2");
    expect(spaceListCalls(provider)).toHaveLength(2);
  });

  it("drops expired entries so the cache does not grow", async () => {
    const { service, provider, grants, clock } = tracker();
    grants.set("bob", grant({ accessToken: "access-bob" }));
    await service.listSpaces("alice", SITE.id);
    clock.now = new Date(clock.now.getTime() + SPACE_LIST_TTL_MS);
    await service.listSpaces("bob", SITE.id);
    // Alice's entry expired and was pruned, so reading again is a fresh call, not a stale hit.
    await service.listSpaces("alice", SITE.id);
    expect(spaceListCalls(provider)).toHaveLength(3);
  });

  it("describes a space live, with statuses and board columns", async () => {
    const { service } = tracker();
    const description = await service.describeSpace("alice", SITE.id, "WID");
    expect(description.statuses.map((s) => s.category)).toEqual(["todo", "in_progress", "done"]);
    expect(description.columns).toEqual([{ name: "Review", statusIds: ["2"] }]);
  });

  it("turns a refused credential at the tracker into a connect-again error", async () => {
    const { service, provider } = tracker();
    provider.failWith = new UnauthorisedError("Atlassian said 401");
    await expect(service.listSites("alice")).rejects.toBeInstanceOf(TrackerUnauthorisedError);
  });

  it("lets other tracker errors through unchanged", async () => {
    const { service, provider } = tracker();
    provider.failWith = new UpstreamError("Jira answered 500", 500);
    await expect(service.listSites("alice")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("links the spaces named, stores them with the site's URL and starts a crawl of each", async () => {
    const { service, store, repoId, crawler } = tracker();
    store.linkSpaces(repoId, SITE.id, []);
    const linked = await service.linkSpaces("alice", repoId, SITE.id, ["WID", "WID"]);

    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
      key: "WID",
      name: "Widgets",
      siteUrl: "https://acme.example.test",
      crawlStatus: "crawling",
    });
    await settledCrawls(crawler);
    expect(store.workItemCount(linked[0]!.id)).toBe(5);
    expect(service.linkedSpaces(repoId)[0]).toMatchObject({ crawlStatus: "idle", workItemCount: 5 });
  });

  it("raises NotFoundError naming a key the site does not have, and links nothing", async () => {
    const { service, store, repoId } = tracker();
    await expect(service.linkSpaces("alice", repoId, SITE.id, ["WID", "NOPE"])).rejects.toThrow("NOPE");
    // The earlier link from set-up is untouched.
    expect(store.spacesFor(repoId).map((s) => s.key)).toEqual(["WID"]);
  });

  it("raises NotFoundError for a site the account cannot reach, or a repository that does not exist", async () => {
    const { service, repoId } = tracker();
    await expect(service.linkSpaces("alice", repoId, "cloud-9", ["WID"])).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.linkSpaces("alice", 999, SITE.id, ["WID"])).rejects.toBeInstanceOf(NotFoundError);
    expect(() => service.linkedSpaces(999)).toThrow(NotFoundError);
  });

  it("refuses a crawl request for a space already being crawled, with a ConflictError", async () => {
    const { service, space, crawler } = tracker();
    service.crawlSpace("alice", space.id, true);
    expect(() => service.crawlSpace("alice", space.id, true)).toThrow("A crawl of this space is already running");
    expect(() => service.crawlSpace("alice", space.id, true)).toThrow(ConflictError);
    await settledCrawls(crawler);
  });

  it("links without failing when a space it links is already being crawled", async () => {
    const { service, space, crawler, repoId } = tracker();
    service.crawlSpace("alice", space.id, true);
    const linked = await service.linkSpaces("alice", repoId, SITE.id, ["WID"]);
    expect(linked.map((s) => s.key)).toEqual(["WID"]);
    await settledCrawls(crawler);
  });

  it("replaces only the links on the given site, leaving other sites linked", async () => {
    const { service, store, provider, repoId, crawler } = tracker();
    const other = { id: "cloud-2", url: "https://other.example.test", name: "Other" };
    provider.seedSite(other);
    provider.seedSpace(other.id, "OPS", { name: "Operations" });

    const both = await service.linkSpaces("alice", repoId, other.id, ["OPS"]);
    expect(both.map((s) => `${s.siteId}/${s.key}`)).toEqual(["cloud-1/WID", "cloud-2/OPS"]);
    await settledCrawls(crawler);

    const afterEmpty = await service.linkSpaces("alice", repoId, other.id, []);
    expect(afterEmpty.map((s) => `${s.siteId}/${s.key}`)).toEqual(["cloud-1/WID"]);
    expect(store.spacesFor(repoId)).toHaveLength(1);
  });

  it("unlinks every space, without calling the tracker, when given no keys", async () => {
    const { service, store, provider, repoId } = tracker();
    expect(await service.linkSpaces("alice", repoId, SITE.id, [])).toEqual([]);
    expect(store.spacesFor(repoId)).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  it("starts a crawl of a stored space on request, and refuses an unknown one", async () => {
    const { service, space, store, crawler } = tracker();
    service.crawlSpace("alice", space.id, true);
    await settledCrawls(crawler);
    expect(store.workItemCount(space.id)).toBe(5);
    expect(() => service.crawlSpace("alice", 999, false)).toThrow(NotFoundError);
  });

  it("records a failed background crawl on the space rather than raising", async () => {
    const { service, space, store, crawler, grants } = tracker();
    grants.delete("alice");
    service.crawlSpace("alice", space.id, false);
    await settledCrawls(crawler);
    expect(store.getSpace(space.id)!.crawlStatus).toBe("failed");
  });
});

const settledCrawls = (crawler: WorkItemCrawlService) => settled(() => crawler.isCrawling());

describe("loadConfig for Jira", () => {
  it("turns Jira on only when both the client id and secret are set", () => {
    expect(loadConfig({}).jiraEnabled).toBe(false);
    expect(loadConfig({ ATLASSIAN_CLIENT_ID: "id" }).jiraEnabled).toBe(false);
    expect(loadConfig({ ATLASSIAN_CLIENT_SECRET: "secret" }).jiraEnabled).toBe(false);
    expect(loadConfig({ ATLASSIAN_CLIENT_ID: "id", ATLASSIAN_CLIENT_SECRET: "secret" })).toMatchObject({
      jiraEnabled: true,
      atlassianClientId: "id",
      atlassianClientSecret: "secret",
    });
  });

  it("defaults the redirect URI to the local API callback and honours an override", () => {
    expect(loadConfig({}).atlassianRedirectUri).toBe("http://localhost:5181/api/auth/jira/callback");
    expect(loadConfig({ ATLASSIAN_REDIRECT_URI: "https://dash.example.test/cb" }).atlassianRedirectUri).toBe(
      "https://dash.example.test/cb",
    );
  });
});
