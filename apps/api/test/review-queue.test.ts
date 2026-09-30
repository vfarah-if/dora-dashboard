import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { NotFoundError, UnauthorisedError, UpstreamError, ValidationError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { ReviewQueueService } from "../src/services/review-queue-service.js";
import { config, FakeCli, FakeProvider, openPr } from "./fakes.js";

// Wednesday 30 Sep 2026, 12:00 UTC
const START = Date.parse("2026-09-30T12:00:00Z");

class Clock {
  constructor(public ms = START) {}
  now = () => new Date(this.ms);
  advance(seconds: number) {
    this.ms += seconds * 1000;
  }
}

describe("ReviewQueueService", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let clock: Clock;
  let service: ReviewQueueService;
  let widgets: number;
  let gadgets: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    clock = new Clock();
    service = new ReviewQueueService(store, provider, clock.now);
    widgets = store.addRepo("acme", "widgets", [], "main").id;
    gadgets = store.addRepo("acme", "gadgets", [], "main").id;
    // published Fri 25 Sep 16:00: 68 weekday hours by the clock above
    provider.seed("acme/widgets", {
      openPrs: [openPr({ number: 1, publishedAt: "2026-09-25T16:00:00Z", createdAt: "2026-09-25T16:00:00Z" })],
    });
    provider.seed("acme/gadgets", {
      openPrs: [openPr({ number: 7, publishedAt: "2026-09-30T08:00:00Z", createdAt: "2026-09-30T08:00:00Z" })],
    });
  });

  it("builds the queue from every repository's open pull requests", async () => {
    const queue = await service.queue("token", undefined);
    expect(queue.now).toBe("2026-09-30T12:00:00.000Z");
    expect(queue.entries.map((e) => [e.key, e.waitHours])).toEqual([
      [`${widgets}#1`, 68],
      [`${gadgets}#7`, 4],
    ]);
    expect(queue.tiles.waiting).toEqual({ count: 2, repos: 2, heldForRedChecks: 0 });
    expect(queue.errors).toEqual([]);
    expect(provider.openFetchTokens).toEqual(["token", "token"]);
  });

  it("limits the queue to the repositories asked for, once each", async () => {
    const queue = await service.queue("token", [gadgets, gadgets]);
    expect(queue.repos.map((r) => r.repo)).toEqual(["acme/gadgets"]);
    expect(provider.openFetches).toBe(1);
  });

  it("serves a repeat within 60 seconds from the cache and reads again after", async () => {
    await service.queue("token", [widgets]);
    clock.advance(59);
    const cached = await service.queue("token", [widgets]);
    expect(provider.openFetches).toBe(1);
    expect(cached.fetchedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(cached.now).toBe("2026-09-30T12:00:59.000Z");

    clock.advance(1);
    const reread = await service.queue("token", [widgets]);
    expect(provider.openFetches).toBe(2);
    expect(reread.fetchedAt).toBe("2026-09-30T12:01:00.000Z");
  });

  it("reads again when refresh is asked for", async () => {
    await service.queue("token", [widgets]);
    clock.advance(5);
    await service.queue("token", [widgets], { refresh: true });
    expect(provider.openFetches).toBe(2);
  });

  it("ignores a refresh of something read under five seconds ago", async () => {
    await service.queue("token", [widgets]);
    clock.advance(4);
    await service.queue("token", [widgets], { refresh: true });
    expect(provider.openFetches).toBe(1);
  });

  it("shares one read between requests that arrive while it is under way", async () => {
    const [a, b] = await Promise.all([service.queue("token", [widgets]), service.queue("token", [widgets], { refresh: true })]);
    expect(provider.openFetches).toBe(1);
    expect(a.entries).toEqual(b.entries);
  });

  it("does not keep a failed read in flight, so the next request tries again", async () => {
    provider.openFailures.set("acme/widgets", new UpstreamError("GitHub answered 502", 502));
    const failed = await service.queue("token", [widgets]);
    expect(failed.errors).toHaveLength(1);
    provider.openFailures.clear();
    expect((await service.queue("token", [widgets])).errors).toEqual([]);
    expect(provider.openFetches).toBe(2);
  });

  it("keeps one person's cached read from reaching someone who cannot see the repository", async () => {
    provider.openVisibleTo.set("acme/widgets", new Set(["alice-token"]));
    const seen = await service.queue("alice-token", [widgets]);
    expect(seen.entries).toHaveLength(1);

    const denied = await service.queue("bob-token", [widgets]);
    expect(denied.entries).toEqual([]);
    expect(denied.errors).toEqual([expect.objectContaining({ repo: "acme/widgets" })]);
    expect(provider.openFetchTokens).toEqual(["alice-token", "bob-token"]);

    // and Alice still has her own cached read
    await service.queue("alice-token", [widgets]);
    expect(provider.openFetches).toBe(2);
  });

  it("never holds a raw token as a cache key", async () => {
    await service.queue("secret-token-value", [widgets]);
    const keys = [...(service as unknown as { cache: Map<string, unknown> }).cache.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops reads past their time to live as new ones arrive", async () => {
    await service.queue("token", [widgets]);
    clock.advance(61);
    await service.queue("token", [gadgets]);
    expect((service as unknown as { cache: Map<string, unknown> }).cache.size).toBe(1);
  });

  it("blanks author, reviewer names and branch unless names are asked for, but keeps the reviewer count", async () => {
    provider.seed("acme/widgets", {
      openPrs: [
        openPr({
          number: 1,
          author: "alice",
          headRef: "alice/fix",
          requestedReviewers: [
            { name: "bob", isTeam: false },
            { name: "platform", isTeam: true },
          ],
        }),
      ],
    });
    const hidden = (await service.queue("token", [widgets])).entries[0]!;
    expect(hidden).toMatchObject({
      author: null,
      requestedReviewers: [],
      headRef: "",
      requestedReviewerCount: 2,
      lane: "awaiting_review",
    });
    expect(JSON.stringify(hidden)).not.toMatch(/alice|bob|platform/);

    const shown = (await service.queue("token", [widgets], { names: true })).entries[0]!;
    expect(shown).toMatchObject({ author: "alice", headRef: "alice/fix", requestedReviewerCount: 2 });
    expect(shown.requestedReviewers.map((r) => r.name)).toEqual(["bob", "platform"]);
  });

  it("warns when a repository was only read in part, and still includes what was read", async () => {
    provider.openTruncated.add("acme/widgets");
    const queue = await service.queue("token", undefined);
    expect(queue.warnings).toEqual([
      { repoId: widgets, repo: "acme/widgets", message: "Showing the 1 most recently updated open pull requests" },
    ]);
    expect(queue.errors).toEqual([]);
    expect(queue.entries).toHaveLength(2);
  });

  it("has no warnings when every repository was read in full", async () => {
    expect((await service.queue("token", undefined)).warnings).toEqual([]);
  });

  it("caches each repository separately and reports the oldest read", async () => {
    await service.queue("token", [widgets]);
    clock.advance(30);
    const both = await service.queue("token", [widgets, gadgets]);
    expect(provider.openFetches).toBe(2);
    expect(both.fetchedAt).toBe("2026-09-30T12:00:00.000Z");
  });

  it("reports a repository that fails and still returns the others", async () => {
    provider.openFailures.set("acme/gadgets", new UpstreamError("GitHub answered 502", 502));
    const queue = await service.queue("token", undefined);
    expect(queue.entries.map((e) => e.repo)).toEqual(["acme/widgets"]);
    expect(queue.errors).toEqual([{ repoId: gadgets, repo: "acme/gadgets", message: "GitHub answered 502" }]);
  });

  it("does not cache a failure, so the next request tries again", async () => {
    provider.openFailures.set("acme/gadgets", new NotFoundError("gone"));
    await service.queue("token", [gadgets]);
    provider.openFailures.clear();
    const queue = await service.queue("token", [gadgets]);
    expect(queue.errors).toEqual([]);
    expect(queue.entries).toHaveLength(1);
  });

  it("describes a failure that is not an Error generically", async () => {
    provider.openFailures.set("acme/gadgets", "odd" as unknown as Error);
    expect((await service.queue("token", [gadgets])).errors[0]!.message).toBe("The repository could not be read");
  });

  it("fails the whole request when the credential is rejected", async () => {
    provider.openFailures.set("acme/widgets", new UnauthorisedError("sign in again"));
    await expect(service.queue("token", undefined)).rejects.toBeInstanceOf(UnauthorisedError);
  });

  it("rejects an unknown repository and an empty choice", async () => {
    await expect(service.queue("token", [999])).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.queue("token", [])).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns an empty queue when no repository is tracked", async () => {
    const empty = new ReviewQueueService(new SqliteRepoStore(":memory:"), provider, clock.now);
    expect(await empty.queue("token", undefined)).toMatchObject({ entries: [], repos: [], errors: [], warnings: [] });
  });

  it("reads many repositories with no more than four in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const original = provider.fetchOpenPullRequests.bind(provider);
    provider.fetchOpenPullRequests = async (...args) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return original(...args);
    };
    for (let i = 0; i < 8; i++) {
      store.addRepo("acme", `extra-${i}`, [], "main");
      provider.seed(`acme/extra-${i}`, {});
    }
    const queue = await service.queue("token", undefined);
    expect(queue.repos).toHaveLength(10);
    expect(peak).toBe(4);
  });

  it("groups related pull requests across repositories", async () => {
    provider.seed("acme/widgets", { openPrs: [openPr({ number: 1, title: "WID-1 widget" })] });
    provider.seed("acme/gadgets", { openPrs: [openPr({ number: 7, title: "WID-1 gadget" })] });
    const queue = await service.queue("token", undefined);
    expect(queue.features).toHaveLength(1);
    expect(queue.features[0]).toMatchObject({ title: "WID-1", evidence: ["ticket"] });
  });
});

describe("GET /api/review-queue", () => {
  let app: FastifyInstance;
  let provider: FakeProvider;
  let cli: FakeCli;
  let ids: number[];
  let clock: Clock;

  beforeEach(async () => {
    provider = new FakeProvider();
    cli = new FakeCli();
    clock = new Clock();
    provider.seed("acme/widgets", {
      openPrs: [
        openPr({ number: 1, publishedAt: "2026-09-25T16:00:00Z", createdAt: "2026-09-25T16:00:00Z", body: "private notes" }),
        openPr({ number: 2, isDraft: true }),
      ],
    });
    provider.seed("acme/gadgets", { openPrs: [openPr({ number: 7 })] });
    const store = new SqliteRepoStore(":memory:");
    ids = [store.addRepo("acme", "widgets", [], "main").id, store.addRepo("acme", "gadgets", [], "main").id];
    ({ app } = await buildApp({
      config: config(),
      store,
      provider,
      sessions: new MemorySessionStore(),
      cli,
      exchangeCode: async () => "unused",
      clock: clock.now,
    }));
  });

  afterEach(() => app.close());

  it("returns entries, tiles, repository summaries and the needs attention order in one payload", async () => {
    const res = await app.inject("/api/review-queue");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["entries", "errors", "features", "fetchedAt", "needsAttention", "now", "repos", "tiles", "warnings"].sort(),
    );
    expect(body.entries.map((e: { key: string }) => e.key)).toEqual([
      // the draft and the gadget were published on 1 Sep, so they have waited longest; ties break on the key
      `${ids[0]}#2`,
      `${ids[1]}#7`,
      `${ids[0]}#1`,
    ]);
    expect(body.needsAttention).toEqual([`${ids[1]}#7`, `${ids[0]}#1`]);
  });

  it("never sends a pull request description to the browser", async () => {
    const res = await app.inject("/api/review-queue");
    expect(res.body).not.toContain("private notes");
    expect(res.json().entries[0]).not.toHaveProperty("body");
  });

  it("limits to ids and honours refresh", async () => {
    const one = await app.inject(`/api/review-queue?ids=${ids[1]}`);
    expect(one.json().repos.map((r: { repo: string }) => r.repo)).toEqual(["acme/gadgets"]);
    await app.inject(`/api/review-queue?ids=${ids[1]}`);
    expect(provider.openFetches).toBe(1);
    await app.inject(`/api/review-queue?ids=${ids[1]}&refresh=1`);
    expect(provider.openFetches).toBe(1);
    clock.advance(5);
    await app.inject(`/api/review-queue?ids=${ids[1]}&refresh=1`);
    expect(provider.openFetches).toBe(2);
  });

  it("hides names by default and shows them only with names=1", async () => {
    provider.seed("acme/gadgets", {
      openPrs: [openPr({ number: 7, author: "alice", requestedReviewers: [{ name: "bob", isTeam: false }] })],
    });
    const hidden = await app.inject(`/api/review-queue?ids=${ids[1]}`);
    expect(hidden.body).not.toMatch(/alice|bob/);
    expect(hidden.json().entries[0]).toMatchObject({ author: null, requestedReviewers: [], requestedReviewerCount: 1 });

    const shown = await app.inject(`/api/review-queue?ids=${ids[1]}&names=1`);
    expect(shown.json().entries[0]).toMatchObject({ author: "alice", requestedReviewers: [{ name: "bob", isTeam: false }] });
    expect((await app.inject(`/api/review-queue?names=yes`)).statusCode).toBe(400);
  });

  it("returns truncation in warnings with a 200", async () => {
    provider.openTruncated.add("acme/gadgets");
    const res = await app.inject("/api/review-queue");
    expect(res.json().warnings).toEqual([expect.objectContaining({ repo: "acme/gadgets", repoId: ids[1] })]);
  });

  it("lists a failing repository in errors with a 200", async () => {
    provider.openFailures.set("acme/gadgets", new UpstreamError("GitHub answered 502", 502));
    const res = await app.inject("/api/review-queue");
    expect(res.statusCode).toBe(200);
    expect(res.json().errors).toEqual([{ repoId: ids[1], repo: "acme/gadgets", message: "GitHub answered 502" }]);
  });

  it("maps a rejected credential to 401 and an unknown id to 404", async () => {
    expect((await app.inject("/api/review-queue?ids=999")).statusCode).toBe(404);
    provider.openFailures.set("acme/widgets", new UnauthorisedError("sign in again"));
    expect((await app.inject("/api/review-queue")).statusCode).toBe(401);
  });

  it("requires a session", async () => {
    cli.error = new UnauthorisedError("run gh auth login");
    expect((await app.inject("/api/review-queue")).statusCode).toBe(401);
  });

  it.each(["ids=1;DROP", "ids=", "ids=abc", "refresh=yes", `ids=${Array(51).fill(1).join(",")}`])("rejects %s", async (query) => {
    expect((await app.inject(`/api/review-queue?${query}`)).statusCode).toBe(400);
  });
});
