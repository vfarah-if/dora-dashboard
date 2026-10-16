import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  AccessRefusedError,
  ForbiddenError,
  NotFoundError,
  UnauthorisedError,
  UpstreamError,
  ValidationError,
} from "../src/core/errors.js";
import type { Logger } from "../src/interfaces/logger.js";
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

/** Lets a background read, and what follows it, run to the end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const recordingLog = () => {
  const lines: { level: string; context: object; message: string }[] = [];
  const log: Logger = {
    info: (context, message) => void lines.push({ level: "info", context, message }),
    warn: (context, message) => void lines.push({ level: "warn", context, message }),
    error: (context, message) => void lines.push({ level: "error", context, message }),
  };
  return { lines, log };
};

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

  it("serves a repeat within 60 seconds from the cache and reads again in the background after", async () => {
    await service.queue("token", [widgets]);
    clock.advance(59);
    const cached = await service.queue("token", [widgets]);
    expect(provider.openFetches).toBe(1);
    expect(cached.fetchedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(cached.now).toBe("2026-09-30T12:00:59.000Z");

    clock.advance(1);
    const stale = await service.queue("token", [widgets]);
    expect(provider.openFetches).toBe(2);
    expect(stale.fetchedAt).toBe("2026-09-30T12:00:00.000Z");
    await settle();
    expect((await service.queue("token", [widgets])).fetchedAt).toBe("2026-09-30T12:01:00.000Z");
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

  it("keeps reads up to the stale window as new ones arrive, and drops them after", async () => {
    // Pruning only bounds memory and changes nothing a caller can see, so this one reads the private cache.
    const keys = () => [...(service as unknown as { cache: Map<string, unknown> }).cache.keys()];
    await service.queue("token", [widgets]);
    clock.advance(599);
    await service.queue("token", [gadgets]);
    expect(keys()).toHaveLength(2);

    clock.advance(1);
    provider.seed("acme/extra", {});
    const extra = store.addRepo("acme", "extra", [], "main").id;
    await service.queue("token", [extra]);
    expect(keys()).toHaveLength(2); // the widgets read, exactly ten minutes old, is gone
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

  it("shows a fixed sentence for an error that is not the app's own, and logs the raw text", async () => {
    const { lines, log } = recordingLog();
    const quiet = new ReviewQueueService(store, provider, clock.now, log);
    provider.openFailures.set("acme/gadgets", new SyntaxError("Unexpected token < in JSON at position 0"));
    const queue = await quiet.queue("secret-token-value", [gadgets]);
    expect(queue.errors).toEqual([{ repoId: gadgets, repo: "acme/gadgets", message: "The repository could not be read" }]);
    expect(lines).toEqual([
      expect.objectContaining({ level: "warn", message: expect.stringContaining("Unexpected token < in JSON") }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret-token-value");
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

describe("ReviewQueueService stale reads", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let clock: Clock;
  let service: ReviewQueueService;
  let widgets: number;
  let gate: { release: () => void; fail: (error: Error) => void } | undefined;
  let held = false;
  let calls = 0;
  let logged: ReturnType<typeof recordingLog>;

  /** While `held`, a read waits until the test releases or fails it; otherwise it answers at once. */
  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    clock = new Clock();
    logged = recordingLog();
    service = new ReviewQueueService(store, provider, clock.now, logged.log);
    widgets = store.addRepo("acme", "widgets", [], "main").id;
    provider.seed("acme/widgets", { openPrs: [openPr({ number: 1 })] });
    held = false;
    calls = 0;
    gate = undefined;
    const original = provider.fetchOpenPullRequests.bind(provider);
    provider.fetchOpenPullRequests = (...args) => {
      calls++;
      if (!held) return original(...args);
      return new Promise((resolve, reject) => {
        gate = {
          release: () => resolve(original(...args)),
          fail: reject,
        };
      });
    };
  });

  const numbers = (queue: { entries: { key: string }[] }) => queue.entries.map((e) => e.key);

  /** Reads once, moves the clock past the time to live, and leaves the next read held. */
  async function goStale(seconds = 61) {
    await service.queue("token", [widgets]);
    clock.advance(seconds);
    held = true;
  }

  it("returns a stale read at once and reads again in the background", async () => {
    await goStale();
    provider.seed("acme/widgets", { openPrs: [openPr({ number: 2 })] });
    const stale = await service.queue("token", [widgets]); // resolves although the read is still held
    expect(numbers(stale)).toEqual([`${widgets}#1`]);
    expect(stale.fetchedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(calls).toBe(2);
  });

  it("serves the new data once the background read has settled", async () => {
    await goStale();
    provider.seed("acme/widgets", { openPrs: [openPr({ number: 2 })] });
    await service.queue("token", [widgets]);
    gate!.release();
    await settle();
    const next = await service.queue("token", [widgets]);
    expect(numbers(next)).toEqual([`${widgets}#2`]);
    expect(next.fetchedAt).toBe("2026-09-30T12:01:01.000Z");
    expect(calls).toBe(2);
  });

  it("starts one background read per key while one is in flight", async () => {
    await goStale();
    await service.queue("token", [widgets]);
    await service.queue("token", [widgets]);
    await service.queue("token", [widgets]);
    expect(calls).toBe(2); // the first read, and one background read however many requests came while it ran
    gate!.release();
    await settle();
    // The background read has landed, so the read is fresh and a request starts nothing more.
    const next = await service.queue("token", [widgets]);
    expect(next.fetchedAt).toBe("2026-09-30T12:01:01.000Z");
    expect(calls).toBe(2);
  });

  it("keeps the stale read when the background read fails, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await goStale();
      await service.queue("token", [widgets]);
      gate!.fail(new UpstreamError("GitHub answered 502", 502));
      await settle();
      await settle();
      expect(unhandled).toEqual([]);

      held = false;
      const again = await service.queue("token", [widgets]);
      expect(numbers(again)).toEqual([`${widgets}#1`]);
      expect(again.fetchedAt).toBe("2026-09-30T12:00:00.000Z");
      expect(again.errors).toEqual([]);
      // The failed read is no longer in flight, so this request tried again in the background and it landed.
      expect(calls).toBe(3);
      await settle();
      expect((await service.queue("token", [widgets])).fetchedAt).toBe("2026-09-30T12:01:01.000Z");
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("drops the stale read when the background read is refused, so the next request surfaces the 401", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await goStale();
      await service.queue("token", [widgets]);
      gate!.fail(new UnauthorisedError("sign in again"));
      await settle();
      await settle();
      expect(unhandled).toEqual([]);

      // Were the stale read kept, the next request would be served it and never see the refusal.
      held = false;
      provider.openFailures.set("acme/widgets", new UnauthorisedError("sign in again"));
      await expect(service.queue("token", [widgets])).rejects.toBeInstanceOf(UnauthorisedError);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it.each([
    ["not found", new NotFoundError("gone")],
    ["forbidden", new ForbiddenError("not served")],
    ["refused", new AccessRefusedError("the app lacks a scope")],
    ["a 403 from the host", new UpstreamError("GitHub answered 403: resource not accessible", 403)],
  ])("drops the stale read when the background read fails because access has gone (%s)", async (_name, failure) => {
    await goStale();
    await service.queue("token", [widgets]);
    gate!.fail(failure);
    await settle();
    await settle();

    // Were the stale read kept, this request would be served it; instead it waits for a read, which fails the same way.
    held = false;
    provider.openFailures.set("acme/widgets", failure);
    const next = await service.queue("token", [widgets]);
    expect(next.entries).toEqual([]);
    expect(next.errors).toEqual([expect.objectContaining({ repo: "acme/widgets", message: failure.message })]);
  });

  it("keeps the stale read when the background read is only rate limited", async () => {
    await goStale();
    await service.queue("token", [widgets]);
    gate!.fail(new UpstreamError("Too many requests for now", 403, { rateLimited: true }));
    await settle();
    await settle();
    held = true;
    const next = await service.queue("token", [widgets]);
    expect(numbers(next)).toEqual([`${widgets}#1`]);
  });

  it("does not take a 403 for a rate limit from its wording, only from the marker", async () => {
    await goStale();
    await service.queue("token", [widgets]);
    gate!.fail(new UpstreamError("GitHub's rate limit for this token was reached; try again later", 403));
    await settle();
    await settle();
    held = false;
    provider.openFailures.set("acme/widgets", new UpstreamError("GitHub answered 403", 403));
    const next = await service.queue("token", [widgets]);
    expect(next.entries).toEqual([]); // the stale read was dropped, so this request waited and met the failure
  });

  it("shows a fixed sentence, and logs the raw text, when a background read fails with a non-app error", async () => {
    await goStale();
    await service.queue("token", [widgets]);
    gate!.fail(new TypeError("Cannot read properties of undefined (reading 'nodes')"));
    await settle();
    await settle();
    held = true;
    const stale = await service.queue("token", [widgets]);
    expect(stale.warnings).toEqual([
      {
        repoId: widgets,
        repo: "acme/widgets",
        message: "Showing pull requests read earlier, because the latest read failed: The repository could not be read",
      },
    ]);
    expect(JSON.stringify(stale)).not.toContain("reading 'nodes'");
    expect(logged.lines).toEqual([
      expect.objectContaining({ level: "warn", message: expect.stringContaining("reading 'nodes'") }),
    ]);
  });

  it("drops a key's entry once its stale window has passed, even when every read since has failed", async () => {
    // Pruning changes nothing a caller can see, so this reads the private cache as the pruning test above does.
    const keys = () => [...(service as unknown as { cache: Map<string, unknown> }).cache.keys()];
    await service.queue("token", [widgets]);
    expect(keys()).toHaveLength(1);
    clock.advance(600);
    provider.openFailures.set("acme/widgets", new UpstreamError("GitHub answered 502", 502));
    const queue = await service.queue("token", [widgets]);
    expect(queue.errors).toHaveLength(1);
    expect(keys()).toEqual([]);
  });

  it("warns while a stale read is served after a failed background read, and stops once a read succeeds", async () => {
    await goStale();
    expect((await service.queue("token", [widgets])).warnings).toEqual([]);
    gate!.fail(new UpstreamError("GitHub answered 502", 502));
    await settle();
    await settle();

    held = true;
    const stale = await service.queue("token", [widgets]);
    expect(numbers(stale)).toEqual([`${widgets}#1`]);
    expect(stale.warnings).toEqual([
      {
        repoId: widgets,
        repo: "acme/widgets",
        message: "Showing pull requests read earlier, because the latest read failed: GitHub answered 502",
      },
    ]);
    expect(stale.errors).toEqual([]);

    gate!.release();
    await settle();
    const fresh = await service.queue("token", [widgets]);
    expect(fresh.warnings).toEqual([]);
    expect(fresh.fetchedAt).toBe("2026-09-30T12:01:01.000Z");
  });

  it("joins the truncation and failure notes into one warning for the repository", async () => {
    provider.openTruncated.add("acme/widgets");
    await goStale();
    await service.queue("token", [widgets]);
    gate!.fail(new UpstreamError("GitHub answered 502", 502));
    await settle();
    await settle();
    const stale = await service.queue("token", [widgets]);
    expect(stale.warnings).toEqual([
      expect.objectContaining({
        message:
          "Showing the 1 most recently updated open pull requests. Showing pull requests read earlier, because the latest read failed: GitHub answered 502",
      }),
    ]);
  });

  it("logs a failed background read at warn level without the token", async () => {
    await service.queue("secret-token-value", [widgets]);
    clock.advance(61);
    held = true;
    await service.queue("secret-token-value", [widgets]);
    gate!.fail(new UpstreamError("GitHub answered 502", 502));
    await settle();
    await settle();
    expect(logged.lines).toEqual([
      {
        level: "warn",
        context: { repo: "acme/widgets" },
        message: "The background read of open pull requests for acme/widgets failed: GitHub answered 502",
      },
    ]);
    expect(JSON.stringify(logged.lines)).not.toContain("secret-token-value");
  });

  it("logs the dropping of a stale read when access has gone", async () => {
    await goStale();
    await service.queue("token", [widgets]);
    gate!.fail(new NotFoundError("gone"));
    await settle();
    await settle();
    expect(logged.lines).toEqual([expect.objectContaining({ level: "warn", context: { repo: "acme/widgets" } })]);
    expect(logged.lines[0]!.message).toContain("access to it has gone: gone");
  });

  it("waits for a fresh read once the stale window has passed", async () => {
    await goStale(600);
    provider.seed("acme/widgets", { openPrs: [openPr({ number: 2 })] });
    let settled = false;
    const pending = service.queue("token", [widgets]).then((q) => {
      settled = true;
      return q;
    });
    await settle();
    expect(settled).toBe(false);
    gate!.release();
    expect(numbers(await pending)).toEqual([`${widgets}#2`]);
  });

  it("does not serve stale data when refresh is asked for beyond the floor", async () => {
    await goStale();
    provider.seed("acme/widgets", { openPrs: [openPr({ number: 2 })] });
    let settled = false;
    const pending = service.queue("token", [widgets], { refresh: true }).then((q) => {
      settled = true;
      return q;
    });
    await settle();
    expect(settled).toBe(false);
    gate!.release();
    expect(numbers(await pending)).toEqual([`${widgets}#2`]);
  });

  it("stamps a read when it completes, not when it began", async () => {
    held = true;
    const pending = service.queue("token", [widgets]);
    await settle();
    clock.advance(30); // the read takes 30 seconds
    gate!.release();
    const first = await pending;
    expect(first.fetchedAt).toBe("2026-09-30T12:00:30.000Z");

    clock.advance(59); // 89 seconds after it began, 59 after it completed
    held = false;
    await service.queue("token", [widgets]);
    expect(calls).toBe(1);
    clock.advance(1);
    held = true;
    await service.queue("token", [widgets]); // now past the time to live, so stale
    expect(calls).toBe(2);
  });
});

describe("ReviewQueueService read limit", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let clock: Clock;
  let service: ReviewQueueService;
  let running: Map<string, number>;
  let peak: Map<string, number>;
  let peakAll: number;
  let delay = false;

  /** Records, per token and overall, the most reads running at once; while `delay` is on each takes 5 ms. */
  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    clock = new Clock();
    service = new ReviewQueueService(store, provider, clock.now);
    running = new Map();
    peak = new Map();
    peakAll = 0;
    delay = false;
    const original = provider.fetchOpenPullRequests.bind(provider);
    provider.fetchOpenPullRequests = async (token, ...rest) => {
      const now = (running.get(token) ?? 0) + 1;
      running.set(token, now);
      peak.set(token, Math.max(peak.get(token) ?? 0, now));
      peakAll = Math.max(
        peakAll,
        [...running.values()].reduce((a, b) => a + b, 0),
      );
      if (delay) await new Promise((r) => setTimeout(r, 5));
      running.set(token, now - 1);
      return original(token, ...rest);
    };
  });

  const add = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const repo = store.addRepo("acme", `${prefix}-${i}`, [], "main");
      provider.seed(`acme/${prefix}-${i}`, {});
      return repo.id;
    });
  const finish = () => new Promise((resolve) => setTimeout(resolve, 80));

  it("holds background reads of stale repositories to four in flight", async () => {
    const ids = add("stale", 8);
    await service.queue("token", ids);
    clock.advance(61);
    delay = true;
    peak.clear();
    const stale = await service.queue("token", ids); // answers at once from what was read
    expect(stale.repos).toHaveLength(8);
    expect(provider.openFetches).toBe(8);
    await finish();
    expect(provider.openFetches).toBe(16);
    expect(peak.get("token")).toBe(4);
  });

  it("holds a mix of expired and stale repositories to four in flight together", async () => {
    const stale = add("stale", 4);
    await service.queue("token", stale);
    clock.advance(61);
    const fresh = add("new", 4);
    delay = true;
    peak.clear();
    const queue = await service.queue("token", [...stale, ...fresh]);
    expect(queue.repos).toHaveLength(8);
    await finish();
    expect(provider.openFetches).toBe(12);
    expect(peak.get("token")).toBe(4);
  });

  it("does not share the cap between tokens", async () => {
    const ids = add("shared", 8);
    delay = true;
    await Promise.all([service.queue("alice-token", ids), service.queue("bob-token", ids)]);
    expect(peak.get("alice-token")).toBe(4);
    expect(peak.get("bob-token")).toBe(4);
    expect(peakAll).toBe(8);
  });

  it("forgets a token once its reads are done", async () => {
    delay = true;
    await service.queue("token", add("idle", 6));
    expect((service as unknown as { limits: Map<string, unknown> }).limits.size).toBe(0);
  });

  it("frees the slot when a read fails, so the reads behind it still run", async () => {
    const ids = add("failing", 6);
    provider.openFailures.set("acme/failing-0", new UpstreamError("GitHub answered 502", 502));
    const queue = await service.queue("token", ids);
    expect(queue.errors).toHaveLength(1);
    expect(queue.repos).toHaveLength(5);
    expect((service as unknown as { limits: Map<string, unknown> }).limits.size).toBe(0);
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
