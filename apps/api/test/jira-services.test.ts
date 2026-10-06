import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import {
  AccessRefusedError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  TrackerUnauthorisedError,
  UnauthorisedError,
  UpstreamError,
} from "../src/core/errors.js";
import { MemoryTrackerGrantStore } from "../src/infrastructure/auth/memory-tracker-grant-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { Logger } from "../src/interfaces/logger.js";
import { JiraAuthService } from "../src/services/jira-auth-service.js";
import { SPACE_LIST_TTL_MS, TrackerService } from "../src/services/tracker-service.js";
import { JiraCloudProvider } from "../src/infrastructure/jira/jira-cloud-provider.js";
import { WorkItemCrawlService } from "../src/services/work-item-crawl-service.js";
import { FakeTrackerAuthorisation, FakeWorkItemProvider, grant, settled, SITE, workItem } from "./fakes.js";

const T0 = 1_000_000_000;

interface Logged {
  level: "info" | "warn" | "error";
  context: Record<string, unknown>;
  message: string;
}

/** Records what the services log, so a test can tell a failure was reported and with what. */
function recordingLogger(): Logger & { logged: Logged[] } {
  const logged: Logged[] = [];
  return {
    logged,
    info: (context, message) => void logged.push({ level: "info", context: context as Record<string, unknown>, message }),
    warn: (context, message) => void logged.push({ level: "warn", context: context as Record<string, unknown>, message }),
    error: (context, message) => void logged.push({ level: "error", context: context as Record<string, unknown>, message }),
  };
}

describe("JiraAuthService", () => {
  let auth: FakeTrackerAuthorisation;
  let grants: MemoryTrackerGrantStore;
  let now: number;
  let service: JiraAuthService;
  let log: ReturnType<typeof recordingLogger>;

  beforeEach(() => {
    auth = new FakeTrackerAuthorisation();
    grants = new MemoryTrackerGrantStore();
    now = T0;
    log = recordingLogger();
    service = new JiraAuthService(auth, grants, () => now, log);
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

  it("does not forget a newer grant when a refresh is refused after the person connected again", async () => {
    grants.set("alice", grant({ accessToken: "old", expiresAt: T0 - 1 }));
    let release!: () => void;
    auth.refreshGate = new Promise<void>((resolve) => (release = resolve));
    auth.refreshFailWith = new UnauthorisedError("refused");

    const caller = service.accessToken("alice");
    auth.exchangeGrant = grant({ accessToken: "reconnected", expiresAt: T0 + 3_600_000 });
    await service.connect("alice", "code");
    release();

    await expect(caller).rejects.toBeInstanceOf(TrackerUnauthorisedError);
    expect(grants.get("alice")!.accessToken).toBe("reconnected");
  });

  describe("a refresh that fails for another reason than a refused token", () => {
    it.each([
      ["an Atlassian outage", new UpstreamError("Atlassian is down", 503)],
      ["rate limiting", new RateLimitedError("Slow down")],
      ["a programming error", new TypeError("x is not a function")],
    ])("rethrows %s unchanged, logs it and keeps the grant", async (_name, failure) => {
      grants.set("alice", grant({ expiresAt: T0 - 1 }));
      auth.refreshFailWith = failure;

      await expect(service.accessToken("alice")).rejects.toBe(failure);

      expect(service.isConnected("alice")).toBe(true);
      expect(log.logged).toEqual([{ level: "warn", context: { err: failure }, message: "jira token refresh failed" }]);
    });

    it("lets a later attempt succeed once Atlassian is back", async () => {
      grants.set("alice", grant({ expiresAt: T0 - 1 }));
      auth.refreshFailWith = new UpstreamError("Atlassian is down", 503);
      await expect(service.accessToken("alice")).rejects.toBeInstanceOf(UpstreamError);

      auth.refreshFailWith = null;
      expect(await service.accessToken("alice")).toBe("access-2");
    });
  });

  it("logs a refused refresh at warn with the cause, and keeps that cause on the error the person sees", async () => {
    grants.set("alice", grant({ expiresAt: T0 - 1 }));
    const refusal = new UnauthorisedError("Atlassian refused the refresh. Token was globally revoked");
    auth.refreshFailWith = refusal;

    const failure = (await service.accessToken("alice").catch((e: unknown) => e)) as TrackerUnauthorisedError;

    expect(failure).toBeInstanceOf(TrackerUnauthorisedError);
    expect(failure.cause).toBe(refusal);
    expect(log.logged.map((l) => [l.level, l.message])).toEqual([
      ["warn", "jira refused the refresh token; dropped the connection"],
      ["info", "jira connection dropped"],
    ]);
    expect(log.logged[0]!.context).toEqual({ err: refusal });
    expect(log.logged[1]!.context).toEqual({ reason: "refused" });
  });

  it("remembers that a refused refresh dropped the connection, until the person connects again", async () => {
    grants.set("alice", grant({ expiresAt: T0 - 1 }));
    auth.refreshFailWith = new UnauthorisedError("refused");
    await service.accessToken("alice").catch(() => undefined);
    expect(service.lapsed("alice")).toBe("refused");
    expect(service.lapsed("bob")).toBeNull();

    await service.connect("alice", "code");
    expect(service.lapsed("alice")).toBeNull();
  });

  describe("dropIfCurrent", () => {
    it("drops the grant that holds the refused token, remembering Jira refused it and logging the drop", () => {
      grants.set("alice", grant({ accessToken: "refused-token" }));
      expect(service.dropIfCurrent("alice", "refused-token")).toBe(true);
      expect(service.isConnected("alice")).toBe(false);
      expect(service.lapsed("alice")).toBe("refused");
      expect(log.logged.map((l) => [l.level, l.message])).toEqual([["info", "jira connection dropped"]]);
      expect(JSON.stringify(log.logged)).not.toContain("refused-token");
    });

    it("keeps a grant that holds another token, as when the person connected again while a request was out", () => {
      grants.set("alice", grant({ accessToken: "reconnected" }));
      expect(service.dropIfCurrent("alice", "old-token")).toBe(false);
      expect(service.isConnected("alice")).toBe(true);
      expect(service.lapsed("alice")).toBeNull();
    });

    it("does nothing for a login with no grant", () => {
      expect(service.dropIfCurrent("alice", "any")).toBe(false);
      expect(service.lapsed("alice")).toBeNull();
    });

    it("stops a refresh that began earlier from restoring the dropped grant", async () => {
      grants.set("alice", grant({ accessToken: "old", expiresAt: T0 - 1 }));
      let release!: () => void;
      auth.refreshGate = new Promise<void>((resolve) => (release = resolve));
      const caller = service.accessToken("alice");
      expect(service.dropIfCurrent("alice", "old")).toBe(true);
      release();
      await expect(caller).rejects.toBeInstanceOf(TrackerUnauthorisedError);
      expect(service.isConnected("alice")).toBe(false);
    });
  });

  it("forgets why a grant went when the person disconnects on purpose", () => {
    grants.set("alice", grant({ accessToken: "t" }));
    service.dropIfCurrent("alice", "t");
    service.disconnect("alice");
    expect(service.lapsed("alice")).toBeNull();
  });

  it("logs an idle drop at info with the reason and no login, whichever call finds it", () => {
    const store = new MemoryTrackerGrantStore(1000, () => now);
    const idleService = new JiraAuthService(auth, store, () => now, log);
    store.set("alice", grant());
    now += 1001;
    expect(idleService.isConnected("alice")).toBe(false);
    expect(idleService.lapsed("alice")).toBe("idle");
    expect(log.logged).toEqual([{ level: "info", context: { reason: "idle" }, message: "jira connection dropped" }]);
  });

  describe("requireUsableGrant", () => {
    it("raises when there is no grant, or when it has expired with no refresh token", () => {
      expect(() => service.requireUsableGrant("alice")).toThrow("Jira is not connected");
      grants.set("alice", grant({ refreshToken: null, expiresAt: T0 }));
      expect(() => service.requireUsableGrant("alice")).toThrow(TrackerUnauthorisedError);
      expect(service.isConnected("alice")).toBe(false);
      expect(service.lapsed("alice")).toBe("expired");
    });

    it("accepts a live grant, and an expired one that can be refreshed, without calling Atlassian", () => {
      grants.set("alice", grant({ refreshToken: null, expiresAt: T0 + 1 }));
      expect(() => service.requireUsableGrant("alice")).not.toThrow();
      grants.set("alice", grant({ refreshToken: "r", expiresAt: T0 - 1 }));
      expect(() => service.requireUsableGrant("alice")).not.toThrow();
      expect(auth.refreshTokens).toEqual([]);
    });
  });

  it("raises once an access token with no refresh token has expired, but serves it until then", async () => {
    grants.set("alice", grant({ accessToken: "only", refreshToken: null, expiresAt: T0 + 30_000 }));
    expect(await service.accessToken("alice")).toBe("only");

    now = T0 + 30_000;
    await expect(service.accessToken("alice")).rejects.toThrow("Connect Jira again");
    expect(auth.refreshTokens).toEqual([]);
    // Gone, and remembered as expired, so the page can say why rather than show someone who never connected.
    expect(service.isConnected("alice")).toBe(false);
    expect(service.lapsed("alice")).toBe("expired");
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
  const log = recordingLogger();
  const store = new SqliteRepoStore(":memory:");
  const provider = seededProvider();
  const auth = new FakeTrackerAuthorisation();
  const grants = new MemoryTrackerGrantStore();
  const state = { now: T0 };
  const jira = new JiraAuthService(auth, grants, () => state.now, log);
  grants.set("alice", grant({ accessToken: "access-1", expiresAt: T0 + 120_000 }));
  const repoId = store.addRepo("acme", "widgets", [], "main").id;
  const [space] = store.linkSpaces(repoId, SITE, [{ key: "WID", name: "Widgets" }]);
  const crawler = new WorkItemCrawlService(store, provider, jira, log);
  return { store, provider, auth, grants, state, jira, repoId, space: space!, crawler, log };
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
    expect(stored.board).toBe("read");
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

  it("logs a failure it raised on purpose as a warning, once", async () => {
    const { provider, space, crawler, log } = setUp();
    const failure = new UpstreamError("Jira answered 503", 503);
    provider.failWith = failure;

    await expect(crawler.crawl("alice", space.id)).rejects.toBe(failure);

    expect(log.logged).toEqual([{ level: "warn", context: { err: failure, spaceId: space.id }, message: "space crawl failed" }]);
  });

  it("stores a plain message, and logs the real error, when the crawl fails for an unplanned reason", async () => {
    const { store, provider, space, crawler, log } = setUp();
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    provider.failWith = bug;

    await expect(crawler.crawl("alice", space.id)).rejects.toBe(bug);

    expect(store.getSpace(space.id)).toMatchObject({
      crawlStatus: "failed",
      crawlError: "The crawl failed unexpectedly. See the API log.",
    });
    expect(log.logged).toEqual([
      { level: "error", context: { err: bug, spaceId: space.id }, message: "space crawl failed unexpectedly" },
    ]);
  });

  it("records that the board was refused, not absent, when Jira refuses it", async () => {
    const { store, provider, space, crawler } = setUp();
    provider.seedSpace(SITE.id, "WID", { name: "Widgets", board: "forbidden", items: [workItem({ key: "WID-1" })] });

    await crawler.crawl("alice", space.id, true);

    expect(store.getSpace(space.id)).toMatchObject({ columns: [], board: "forbidden", crawlStatus: "idle" });
  });

  it("records a space with no board as none", async () => {
    const { store, provider, space, crawler } = setUp();
    provider.seedSpace(SITE.id, "WID", { name: "Widgets", items: [] });

    await crawler.crawl("alice", space.id, true);

    expect(store.getSpace(space.id)).toMatchObject({ columns: [], board: "none" });
  });

  it("asks for each page with the stop time and the cursor named, not by position", async () => {
    const { provider, space, crawler } = setUp();

    await crawler.crawl("alice", space.id, true);

    const asked = provider.calls.filter((c) => c.method === "fetchWorkItemPage");
    expect(asked.map((c) => [c.updatedSince, c.cursor])).toEqual([
      [null, null],
      [null, "2"],
      [null, "4"],
    ]);
  });

  describe("when Jira refuses the credential part way through a crawl", () => {
    const NEUTRAL = "Jira refused the connection used for this crawl. Crawl again with a working connection.";

    it("drops the grant, logs a warning and stores neutral wording on the space, which every viewer reads", async () => {
      const { store, provider, space, crawler, jira, log } = setUp();
      provider.failWith = new UnauthorisedError("Jira rejected the credential; reconnect Jira");
      provider.failAfterPages = 1;

      const failure = await crawler.crawl("alice", space.id, true).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(TrackerUnauthorisedError);
      expect((failure as Error).message).toBe(NEUTRAL);
      expect(jira.isConnected("alice")).toBe(false);
      expect(jira.lapsed("alice")).toBe("refused");
      expect(store.getSpace(space.id)).toMatchObject({ crawlStatus: "failed", crawlError: NEUTRAL });
      expect(store.getSpace(space.id)!.crawlError).not.toContain("Connect Jira");
      expect(log.logged.map((l) => [l.level, l.message])).toEqual([
        ["info", "jira connection dropped"],
        ["warn", "jira rejected the grant during a crawl"],
        ["warn", "space crawl failed"],
      ]);
      expect(log.logged[1]!.context).toMatchObject({ dropped: true });
    });

    it("keeps a grant the person connected again while the crawl was reading, but still fails the crawl", async () => {
      const { store, provider, space, crawler, jira, grants, log } = setUp();
      provider.failWith = new UnauthorisedError("Atlassian said 401");
      provider.failAfterPages = 0;
      // The page request is out with "access-1" when the person reconnects.
      provider.onPage = () => grants.set("alice", grant({ accessToken: "reconnected" }));

      await expect(crawler.crawl("alice", space.id)).rejects.toBeInstanceOf(TrackerUnauthorisedError);

      expect(jira.isConnected("alice")).toBe(true);
      expect(grants.get("alice")!.accessToken).toBe("reconnected");
      expect(jira.lapsed("alice")).toBeNull();
      expect(store.getSpace(space.id)!.crawlError).toBe(NEUTRAL);
      expect(log.logged.find((l) => l.message === "jira rejected the grant during a crawl")!.context).toMatchObject({
        dropped: false,
      });
    });

    it("logs at error, and still throws the crawl's own failure, when recording the failure on the space fails too", async () => {
      const { store, provider, space, crawler, log } = setUp();
      provider.failWith = new UpstreamError("Jira answered 502", 502);
      const original = store.setSpaceCrawlState.bind(store);
      store.setSpaceCrawlState = (id, status, progress, error) => {
        if (status === "failed") throw new Error("disk full");
        original(id, status, progress, error);
      };

      await expect(crawler.crawl("alice", space.id)).rejects.toBeInstanceOf(UpstreamError);

      const lost = log.logged.find((l) => l.message === "could not record that the space crawl failed");
      expect(lost).toMatchObject({ level: "error" });
      expect((lost!.context["err"] as Error).message).toBe("disk full");
      expect((lost!.context["crawlError"] as Error).message).toBe("Jira answered 502");
    });

    it("records a board Jira refused for a missing scope as forbidden, keeping the grant", async () => {
      const { store, jira, grants, log } = setUp();
      const http = async (url: string): Promise<Response> => {
        const body = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
        if (url.includes("/rest/agile/1.0/board")) return body({ code: 401, message: "Unauthorized; scope does not match" }, 401);
        if (url.includes("/statuses")) return body([]);
        return body({ issues: [], isLast: true });
      };
      const real = new WorkItemCrawlService(store, new JiraCloudProvider(http as unknown as typeof fetch), jira, log);
      const repo = store.addRepo("acme", "gadgets", [], "main").id;
      const [space] = store.linkSpaces(repo, SITE, [{ key: "GAD", name: "Gadgets" }]);
      expect(space!.board).toBeNull();

      await real.crawl("alice", space!.id, true);

      expect(store.getSpace(space!.id)).toMatchObject({ board: "forbidden", columns: [], crawlStatus: "idle", crawlError: null });
      expect(jira.isConnected("alice")).toBe(true);
      expect(grants.get("alice")!.accessToken).toBe("access-1");
      expect(jira.lapsed("alice")).toBeNull();
    });

    it("also does so when the very first read is refused", async () => {
      const { store, provider, space, crawler, jira } = setUp();
      provider.failWith = new UnauthorisedError("Atlassian said 401");

      await expect(crawler.crawl("alice", space.id)).rejects.toBeInstanceOf(TrackerUnauthorisedError);

      expect(jira.isConnected("alice")).toBe(false);
      expect(store.getSpace(space.id)!.crawlError).toBe(
        "Jira refused the connection used for this crawl. Crawl again with a working connection.",
      );
    });

    it("leaves another person's grant alone", async () => {
      const { provider, space, crawler, jira, grants } = setUp();
      grants.set("bob", grant());
      provider.failWith = new UnauthorisedError("Atlassian said 401");

      await crawler.crawl("alice", space.id).catch(() => undefined);

      expect(jira.isConnected("bob")).toBe(true);
    });

    it("keeps the grant when the failure is not a rejection", async () => {
      const { provider, space, crawler, jira } = setUp();
      provider.failWith = new UpstreamError("Jira answered 502", 502);

      await crawler.crawl("alice", space.id).catch(() => undefined);

      expect(jira.isConnected("alice")).toBe(true);
    });
  });

  it("stores Jira's refusal of a resource, saying what may be missing, and keeps the grant", async () => {
    const { store, provider, space, crawler, jira } = setUp();
    const refusal = new AccessRefusedError(
      "Jira refused access to /rest/api/3/search/jql. The connected account may lack permission, or the app may lack a scope",
    );
    provider.failWith = refusal;
    provider.failAfterPages = 1;

    await expect(crawler.crawl("alice", space.id, true)).rejects.toBe(refusal);

    expect(store.getSpace(space.id)).toMatchObject({ crawlStatus: "failed", crawlError: refusal.message });
    expect(jira.isConnected("alice")).toBe(true);
  });

  it("fails, and leaves the cursor alone, when the newest update time is not a date", async () => {
    const { store, provider, space, crawler } = setUp();
    provider.seedSpace(SITE.id, "WID", { name: "Widgets", items: [workItem({ key: "WID-1", updatedAt: "garbage" })] });

    await expect(crawler.crawl("alice", space.id, true)).rejects.toThrow("not a date");

    expect(store.spaceCrawlCursor(space.id)).toBeNull();
    expect(store.getSpace(space.id)).toMatchObject({ crawlStatus: "failed" });
    expect(store.getSpace(space.id)!.crawlError).toContain("not a date");
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

  describe("assignee names", () => {
    const withPeople = (provider: FakeWorkItemProvider, people: Record<string, string>, ids: (string | null)[]) =>
      provider.seedSpace(SITE.id, "WID", {
        name: "Widgets",
        people,
        items: ids.map((id, n) => workItem({ key: `WID-${n + 1}`, assigneeId: id, updatedAt: `2026-09-0${n + 1}T10:00:00Z` })),
      });

    it("gathers the names from every page and saves them when the crawl finishes", async () => {
      const { store, provider, space, crawler } = setUp();
      // Pages are two items each, newest first: [WID-5, WID-4], [WID-3, WID-2], [WID-1].
      withPeople(provider, { a: "Alex", b: "Blake", c: "Casey", unseen: "Nobody" }, ["a", "b", null, "c", "a"]);

      await crawler.crawl("alice", space.id, true);

      expect(store.getSpace(space.id)!.people).toEqual({ a: "Alex", b: "Blake", c: "Casey" });
    });

    it("lets a full crawl replace the stored names, dropping people no longer assigned", async () => {
      const { store, provider, space, crawler } = setUp();
      store.setSpacePeople(space.id, { gone: "Former" });
      withPeople(provider, { a: "Alex" }, ["a"]);

      await crawler.crawl("alice", space.id, true);

      expect(store.getSpace(space.id)!.people).toEqual({ a: "Alex" });
    });

    it("lets an incremental crawl add to the stored names and refresh a changed one", async () => {
      const { store, provider, space, crawler } = setUp();
      withPeople(provider, { a: "Alex", b: "Blake" }, ["a", "b"]);
      await crawler.crawl("alice", space.id, true);
      withPeople(provider, { a: "Alex", b: "Blake", c: "Casey" }, ["a", "b"]);
      provider.seedSpace(SITE.id, "WID", {
        name: "Widgets",
        people: { b: "Blake Renamed", c: "Casey" },
        items: [
          workItem({ key: "WID-1", assigneeId: "a", updatedAt: "2026-09-01T10:00:00Z" }),
          workItem({ key: "WID-2", assigneeId: "b", updatedAt: "2026-09-09T10:00:00Z" }),
          workItem({ key: "WID-3", assigneeId: "c", updatedAt: "2026-09-10T10:00:00Z" }),
        ],
      });

      await crawler.crawl("alice", space.id);

      expect(store.getSpace(space.id)!.people).toEqual({ a: "Alex", b: "Blake Renamed", c: "Casey" });
    });

    it("leaves the stored names alone when an incremental crawl finds nobody new", async () => {
      const { store, provider, space, crawler } = setUp();
      withPeople(provider, { a: "Alex" }, ["a"]);
      await crawler.crawl("alice", space.id, true);

      await crawler.crawl("alice", space.id);

      expect(store.getSpace(space.id)!.people).toEqual({ a: "Alex" });
    });

    it("keeps an account id that is also an object key as a name, and copies no inherited name", async () => {
      const { store, provider, space, crawler } = setUp();
      // Parsed as Jira's JSON would be, so "__proto__" is an own key holding a name, not the prototype.
      withPeople(provider, JSON.parse('{"__proto__": "Proto Person", "a": "Alex"}') as Record<string, string>, [
        "__proto__",
        "a",
      ]);
      const serve = provider.fetchWorkItemPage.bind(provider);
      provider.fetchWorkItemPage = async (...args) => {
        const page = await serve(...args);
        return { ...page, people: Object.setPrototypeOf({ ...page.people }, { ghost: "Inherited" }) as Record<string, string> };
      };

      await crawler.crawl("alice", space.id, true);

      const people = store.getSpace(space.id)!.people!;
      expect(Object.keys(people).sort()).toEqual(["__proto__", "a"]);
      expect(people["__proto__"]).toBe("Proto Person");
    });

    it("does not save names when the crawl fails", async () => {
      const { store, provider, space, crawler } = setUp();
      store.setSpacePeople(space.id, { old: "Earlier" });
      withPeople(provider, { a: "Alex" }, ["a", "a", "a"]);
      provider.failAfterPages = 1;
      provider.failWith = new UpstreamError("Jira answered 500", 500);

      await expect(crawler.crawl("alice", space.id, true)).rejects.toThrow();

      expect(store.getSpace(space.id)!.people).toEqual({ old: "Earlier" });
    });
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
    provider.onPage = () => store.linkSpaces(repoId, SITE, []);

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
    const service = new TrackerService(base.store, base.provider, base.jira, base.crawler, () => clock.now, base.log, ttlMs);
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
    expect(description.board).toBe("read");
  });

  it("tells a refused board from a missing one when describing a space", async () => {
    const { service, provider } = tracker();
    provider.seedSpace(SITE.id, "WID", { name: "Widgets", board: "forbidden" });
    expect(await service.describeSpace("alice", SITE.id, "WID")).toMatchObject({ columns: [], board: "forbidden" });
    provider.seedSpace(SITE.id, "WID", { name: "Widgets" });
    expect(await service.describeSpace("alice", SITE.id, "WID")).toMatchObject({ columns: [], board: "none" });
  });

  it("passes a refused resource through as it is, without disconnecting the person", async () => {
    const { service, provider, jira } = tracker();
    provider.failWith = new AccessRefusedError("Jira refused access to /x. The connected account may lack permission");

    await expect(service.describeSpace("alice", SITE.id, "WID")).rejects.toBeInstanceOf(AccessRefusedError);

    expect(jira.isConnected("alice")).toBe(true);
  });

  it("turns a refused credential at the tracker into a connect-again error", async () => {
    const { service, provider } = tracker();
    provider.failWith = new UnauthorisedError("Atlassian said 401");
    await expect(service.listSites("alice")).rejects.toBeInstanceOf(TrackerUnauthorisedError);
  });

  it("disconnects the person when Jira refuses the credential, so they are no longer shown as connected", async () => {
    const { service, provider, jira } = tracker();
    provider.failWith = new UnauthorisedError("Atlassian said 401");
    expect(jira.isConnected("alice")).toBe(true);

    await expect(service.listSites("alice")).rejects.toBeInstanceOf(TrackerUnauthorisedError);

    expect(jira.isConnected("alice")).toBe(false);
    await expect(service.listSites("alice")).rejects.toThrow("Jira is not connected");
  });

  it("keeps a grant the person connected again while the request was out, and still asks them to connect again", async () => {
    const { service, provider, jira, grants, log } = tracker();
    provider.listSites = async () => {
      grants.set("alice", grant({ accessToken: "reconnected" }));
      throw new UnauthorisedError("Atlassian said 401");
    };

    await expect(service.listSites("alice")).rejects.toBeInstanceOf(TrackerUnauthorisedError);

    expect(jira.isConnected("alice")).toBe(true);
    expect(grants.get("alice")!.accessToken).toBe("reconnected");
    expect(log.logged.find((l) => l.message === "jira rejected the grant")!.context).toMatchObject({ dropped: false });
  });

  it("remembers that Jira refused the grant it dropped, and keeps Jira's reason as the cause", async () => {
    const { service, provider, jira } = tracker();
    const refusal = new UnauthorisedError("Jira rejected the credential for /x. Unauthorized; reconnect Jira");
    provider.failWith = refusal;
    const failure = (await service.listSites("alice").catch((e: unknown) => e)) as Error;
    expect(failure.cause).toBe(refusal);
    expect(jira.lapsed("alice")).toBe("refused");
  });

  it("lets other tracker errors through unchanged", async () => {
    const { service, provider } = tracker();
    provider.failWith = new UpstreamError("Jira answered 500", 500);
    await expect(service.listSites("alice")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("links the spaces named, stores them with the site's URL and starts a crawl of each", async () => {
    const { service, store, repoId, crawler } = tracker();
    store.linkSpaces(repoId, SITE, []);
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

  describe("tracked spaces", () => {
    it("lists every space with its crawl state, item count and linked repositories, without names of people", async () => {
      const { service, store, provider, repoId, space, crawler } = tracker();
      provider.seedSpace(SITE.id, "WID", {
        name: "Widgets",
        people: { "account-1": "Alex" },
        items: [workItem({ key: "WID-1" })],
      });
      await crawler.crawl("alice", space.id, true);
      const gadgets = store.addRepo("acme", "gadgets", [], "main").id;
      store.linkSpaces(gadgets, SITE, [
        { key: "WID", name: "Widgets" },
        { key: "GAD", name: "Gadgets" },
      ]);

      const listed = service.trackedSpaces();

      expect(listed).toEqual([
        {
          id: listed[0]!.id,
          key: "GAD",
          name: "Gadgets",
          siteUrl: "https://acme.example.test",
          lastCrawledAt: null,
          crawlStatus: "idle",
          crawlError: null,
          workItemCount: 0,
          repos: [{ id: gadgets, name: "acme/gadgets" }],
        },
        {
          id: space.id,
          key: "WID",
          name: "Widgets",
          siteUrl: "https://acme.example.test",
          lastCrawledAt: store.getSpace(space.id)!.lastCrawledAt,
          crawlStatus: "idle",
          crawlError: null,
          workItemCount: 1,
          repos: [
            { id: gadgets, name: "acme/gadgets" },
            { id: repoId, name: "acme/widgets" },
          ],
        },
      ]);
      expect(JSON.stringify(listed)).not.toContain("Alex");
    });

    it("includes why the last crawl failed, so the spaces page can show it", async () => {
      const { service, store, space } = tracker();
      expect(service.trackedSpaces()[0]!.crawlError).toBeNull();

      store.setSpaceCrawlState(space.id, "failed", null, "Jira answered 503");

      expect(service.trackedSpaces()[0]).toMatchObject({ crawlStatus: "failed", crawlError: "Jira answered 503" });
    });

    it("keeps names of people out of a repository's linked spaces too", async () => {
      const { service, store, repoId, space } = tracker();
      store.setSpacePeople(space.id, { "account-1": "Alex" });

      expect("people" in service.linkedSpaces(repoId)[0]!).toBe(false);
    });
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

  it("raises NotFoundError, not a raw store error, when the repository is deleted while Jira is being asked", async () => {
    const { store, repoId, provider, jira, crawler } = tracker();
    class Deleting extends FakeWorkItemProvider {
      override async listSpaces(token: string, siteId: string) {
        const spaces = await super.listSpaces(token, siteId);
        store.deleteRepo(repoId);
        return spaces;
      }
    }
    const deleting = new Deleting();
    deleting.seedSite(SITE);
    deleting.seedSpace(SITE.id, "WID", { name: "Widgets" });
    const service = new TrackerService(store, deleting, jira, crawler);
    void provider;

    await expect(service.linkSpaces("alice", repoId, SITE.id, ["WID"])).rejects.toBeInstanceOf(NotFoundError);
    expect(store.listSpaces()).toEqual([]);
  });

  it("answers a crawl request with the connect-again error, and starts nothing, when there is no usable grant", async () => {
    const { service, space, store, grants, provider } = tracker();
    grants.delete("alice");

    expect(() => service.crawlSpace("alice", space.id, true)).toThrow(TrackerUnauthorisedError);

    grants.set("alice", grant({ refreshToken: null, expiresAt: T0 - 1 }));
    expect(() => service.crawlSpace("alice", space.id, true)).toThrow("Connect Jira again");
    expect(provider.calls).toEqual([]);
    expect(store.getSpace(space.id)).toMatchObject({ crawlStatus: "idle", crawlError: null });
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

  it("records a failed background crawl on the space rather than raising, and logs it once", async () => {
    const { service, space, store, crawler, provider, log } = tracker();
    provider.failWith = new UpstreamError("Jira answered 503", 503);
    service.crawlSpace("alice", space.id, false);
    await settledCrawls(crawler);
    expect(store.getSpace(space.id)).toMatchObject({ crawlStatus: "failed", crawlError: "Jira answered 503" });
    expect(log.logged.filter((entry) => entry.message.includes("crawl failed"))).toHaveLength(1);
  });
});

const settledCrawls = (crawler: WorkItemCrawlService) => settled(() => crawler.isCrawling());

describe("loadConfig for Jira", () => {
  it("turns Jira on when both the client id and secret are set, and off when neither is, refusing just one", () => {
    expect(loadConfig({}).jira).toBeNull();
    expect(() => loadConfig({ ATLASSIAN_CLIENT_ID: "id" })).toThrow("ATLASSIAN_CLIENT_SECRET");
    expect(() => loadConfig({ ATLASSIAN_CLIENT_SECRET: "secret" })).toThrow("ATLASSIAN_CLIENT_ID");
    expect(loadConfig({ ATLASSIAN_CLIENT_ID: "id", ATLASSIAN_CLIENT_SECRET: "secret" })).toMatchObject({
      jira: { clientId: "id", clientSecret: "secret" },
    });
  });

  it("defaults the redirect URI to the local API callback and honours an override", () => {
    const keys = { ATLASSIAN_CLIENT_ID: "id", ATLASSIAN_CLIENT_SECRET: "secret" };
    expect(loadConfig(keys).jira?.redirectUri).toBe("http://localhost:5181/api/auth/jira/callback");
    expect(loadConfig({ ...keys, ATLASSIAN_REDIRECT_URI: "https://dash.example.test/cb" }).jira?.redirectUri).toBe(
      "https://dash.example.test/cb",
    );
  });
});
