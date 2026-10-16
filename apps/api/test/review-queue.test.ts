import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { GitHubProvider } from "../src/infrastructure/github/github-provider.js";
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
    await service.queue("token", [widgets], { refresh: "all" });
    expect(provider.openFetches).toBe(2);
  });

  it("reads again only the repositories a refresh lists, and serves the rest from the cache", async () => {
    await service.queue("token", [widgets, gadgets]);
    clock.advance(5);
    const queue = await service.queue("token", [widgets, gadgets], { refresh: { only: [gadgets] } });
    expect(provider.openFetches).toBe(3);
    expect(queue.repos.map((r) => [r.repo, r.fetchedAt])).toEqual([
      ["acme/widgets", "2026-09-30T12:00:00.000Z"],
      ["acme/gadgets", "2026-09-30T12:00:05.000Z"],
    ]);
  });

  it("serves a stale repository a refresh does not list at once, and reads it again in the background", async () => {
    await service.queue("token", [widgets, gadgets]);
    clock.advance(90);
    const queue = await service.queue("token", [widgets, gadgets], { refresh: { only: [gadgets] } });
    expect(queue.repos.map((r) => [r.repo, r.fetchedAt])).toEqual([
      ["acme/widgets", "2026-09-30T12:00:00.000Z"],
      ["acme/gadgets", "2026-09-30T12:01:30.000Z"],
    ]);
    expect(provider.openFetches).toBe(4);
    await settle();
    const after = await service.queue("token", [widgets]);
    expect(after.repos[0]?.fetchedAt).toBe("2026-09-30T12:01:30.000Z");
  });

  it("reads nothing again for an empty refresh list", async () => {
    await service.queue("token", [widgets, gadgets]);
    clock.advance(5);
    await service.queue("token", [widgets, gadgets], { refresh: { only: [] } });
    expect(provider.openFetches).toBe(2);
  });

  it("ignores a listed refresh of a repository that is not being read", async () => {
    await service.queue("token", [widgets]);
    clock.advance(5);
    await service.queue("token", [widgets], { refresh: { only: [gadgets] } });
    expect(provider.openFetches).toBe(1);
  });

  it("ignores a refresh of something read under five seconds ago", async () => {
    await service.queue("token", [widgets]);
    clock.advance(4);
    await service.queue("token", [widgets], { refresh: "all" });
    expect(provider.openFetches).toBe(1);
  });

  it("shares one read between requests that arrive while it is under way", async () => {
    const [a, b] = await Promise.all([service.queue("token", [widgets]), service.queue("token", [widgets], { refresh: "all" })]);
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
    // Not one of the app's own errors, so it is logged as an error with the error itself, for its message and stack.
    expect(lines).toEqual([
      {
        level: "error",
        context: { err: expect.any(SyntaxError), repo: "acme/gadgets" },
        message: "Reading open pull requests failed",
      },
    ]);
    expect((lines[0]!.context as { err: Error }).err.message).toContain("Unexpected token < in JSON");
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
    provider.seed("acme/widgets", { openPrs: [openPr({ number: 2 })] });
    await service.queue("token", [widgets]);
    gate!.fail(new UpstreamError("Too many requests for now", 403, { rateLimited: true }));
    await settle();
    await settle();
    held = true;
    // Were the read dropped, this request would wait for the held read and, once it is released, answer with #2.
    const next = service.queue("token", [widgets]);
    gate!.release();
    expect(numbers(await next)).toEqual([`${widgets}#1`]);
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
      {
        level: "error",
        context: { err: expect.any(TypeError), repo: "acme/widgets" },
        message: "Reading open pull requests failed",
      },
    ]);
    expect((logged.lines[0]!.context as { err: Error }).err.message).toContain("reading 'nodes'");
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

  it("logs a failed background read at warn level with the error and the repository, without the token", async () => {
    await service.queue("secret-token-value", [widgets]);
    clock.advance(61);
    held = true;
    await service.queue("secret-token-value", [widgets]);
    const failure = new UpstreamError("GitHub answered 502", 502);
    gate!.fail(failure);
    await settle();
    await settle();
    expect(logged.lines).toEqual([
      { level: "warn", context: { err: failure, repo: "acme/widgets" }, message: "Reading open pull requests failed" },
    ]);
    expect(JSON.stringify(logged.lines)).not.toContain("secret-token-value");
  });

  it("logs the dropping of a stale read when access has gone, at warn level without the token", async () => {
    await service.queue("secret-token-value", [widgets]);
    clock.advance(61);
    held = true;
    await service.queue("secret-token-value", [widgets]);
    const failure = new NotFoundError("gone");
    gate!.fail(failure);
    await settle();
    await settle();
    expect(logged.lines).toEqual([
      {
        level: "warn",
        context: { err: failure, repo: "acme/widgets" },
        message: "Reading open pull requests failed because access has gone, so the earlier read was dropped",
      },
    ]);
    expect(JSON.stringify(logged.lines)).not.toContain("secret-token-value");
  });

  it("logs an awaited failure, which nobody else would see, at warn for an app error and at error otherwise", async () => {
    const appError = new UpstreamError("GitHub could not be reached", 502, { cause: new Error("read ECONNRESET") });
    provider.openFailures.set("acme/widgets", appError);
    await service.queue("secret-token-value", [widgets]);
    provider.openFailures.set("acme/widgets", new TypeError("Cannot read properties of undefined"));
    clock.advance(600);
    await service.queue("secret-token-value", [widgets]);
    expect(logged.lines.map((l) => [l.level, l.context])).toEqual([
      ["warn", { err: appError, repo: "acme/widgets" }],
      ["error", { err: expect.any(TypeError), repo: "acme/widgets" }],
    ]);
    expect((logged.lines[0]!.context as { err: Error }).err.cause).toBeInstanceOf(Error);
    expect(JSON.stringify(logged.lines)).not.toContain("secret-token-value");
  });

  it("logs a failed refresh once, however many requests share it, and not the token", async () => {
    await service.queue("secret-token-value", [widgets]);
    clock.advance(6);
    held = true;
    const both = Promise.all([
      service.queue("secret-token-value", [widgets], { refresh: "all" }),
      service.queue("secret-token-value", [widgets], { refresh: "all" }),
    ]);
    gate!.fail(new UpstreamError("GitHub answered 504", 504));
    await both;
    expect(logged.lines).toHaveLength(1);
    expect(JSON.stringify(logged.lines)).not.toContain("secret-token-value");
  });

  describe("when a refresh that waited for a read fails", () => {
    /** Reads once, lets the floor pass and holds the next read, which is the refresh. */
    async function refreshing() {
      await service.queue("token", [widgets]);
      clock.advance(6);
      held = true;
      // Wrapped, since an async function would otherwise wait for the held read before returning.
      return { pending: service.queue("token", [widgets], { refresh: "all" }) };
    }

    it.each([
      ["not found", new NotFoundError("gone")],
      ["forbidden", new ForbiddenError("not served")],
      ["refused", new AccessRefusedError("the app lacks a scope")],
      ["a 403 from the host", new UpstreamError("GitHub answered 403: resource not accessible", 403)],
    ])("drops the earlier read, so the next ordinary request is not served it (%s)", async (_name, failure) => {
      const { pending } = await refreshing();
      gate!.fail(failure);
      const refreshed = await pending;
      expect(refreshed.entries).toEqual([]);
      expect(refreshed.errors).toEqual([expect.objectContaining({ repo: "acme/widgets", message: failure.message })]);

      // Within the time to live; were the old read kept it would be served here with no error and no warning.
      held = false;
      provider.openFailures.set("acme/widgets", failure);
      const next = await service.queue("token", [widgets]);
      expect(next.entries).toEqual([]);
      expect(next.errors).toEqual([expect.objectContaining({ repo: "acme/widgets", message: failure.message })]);
    });

    it("still fails the whole request when the credential is rejected, and drops the earlier read", async () => {
      const { pending } = await refreshing();
      gate!.fail(new UnauthorisedError("sign in again"));
      await expect(pending).rejects.toBeInstanceOf(UnauthorisedError);
      held = false;
      provider.openFailures.set("acme/widgets", new UnauthorisedError("sign in again"));
      await expect(service.queue("token", [widgets])).rejects.toBeInstanceOf(UnauthorisedError);
    });

    it("answers a 502 with the earlier read and a warning, as a failed background read would, and keeps the warning", async () => {
      const warning = {
        repoId: widgets,
        repo: "acme/widgets",
        message: "Showing pull requests read earlier, because the latest read failed: GitHub answered 502",
      };
      const { pending } = await refreshing();
      gate!.fail(new UpstreamError("GitHub answered 502", 502));
      const refreshed = await pending;
      expect(numbers(refreshed)).toEqual([`${widgets}#1`]);
      expect(refreshed.errors).toEqual([]);
      expect(refreshed.warnings).toEqual([warning]);
      expect(refreshed.fetchedAt).toBe("2026-09-30T12:00:00.000Z");

      // The next ordinary request, still inside the time to live, carries the warning too and reads nothing.
      held = false;
      const callsBefore = calls;
      const next = await service.queue("token", [widgets]);
      expect(next.warnings).toEqual([warning]);
      expect(calls).toBe(callsBefore);

      // A refresh that succeeds clears it.
      provider.seed("acme/widgets", { openPrs: [openPr({ number: 2 })] });
      clock.advance(6);
      const cleared = await service.queue("token", [widgets], { refresh: "all" });
      expect(numbers(cleared)).toEqual([`${widgets}#2`]);
      expect(cleared.warnings).toEqual([]);
      expect((await service.queue("token", [widgets])).warnings).toEqual([]);
    });

    it("shows a fixed sentence in that warning when the failure is not one of the app's own", async () => {
      const { pending } = await refreshing();
      gate!.fail(new TypeError("Cannot read properties of undefined (reading 'nodes')"));
      const refreshed = await pending;
      expect(refreshed.warnings[0]!.message).toBe(
        "Showing pull requests read earlier, because the latest read failed: The repository could not be read",
      );
      expect(JSON.stringify(refreshed)).not.toContain("reading 'nodes'");
    });
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
    const pending = service.queue("token", [widgets], { refresh: "all" }).then((q) => {
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
      running.set(token, (running.get(token) ?? 1) - 1);
      return original(token, ...rest);
    };
  });

  const add = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const repo = store.addRepo("acme", `${prefix}-${i}`, [], "main");
      provider.seed(`acme/${prefix}-${i}`, {});
      return repo.id;
    });
  /** Waits until `fetches` reads have started and none is still running, polling rather than sleeping a fixed time. */
  const finished = (fetches: number) =>
    vi.waitFor(() => {
      expect(provider.openFetches).toBe(fetches);
      expect([...running.values()].every((n) => n === 0)).toBe(true);
    });

  it("holds background reads of stale repositories to four in flight", async () => {
    const ids = add("stale", 8);
    await service.queue("token", ids);
    clock.advance(61);
    delay = true;
    peak.clear();
    const stale = await service.queue("token", ids); // answers at once from what was read
    expect(stale.repos).toHaveLength(8);
    expect(provider.openFetches).toBe(8);
    await finished(16);
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
    await finished(12);
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

describe("ReviewQueueService read order", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let clock: Clock;
  let service: ReviewQueueService;
  /** Every read the service has started, in order, each held until the test releases it. */
  let started: { name: string; token: string; released: boolean; release: () => void }[];
  let held: boolean;
  let running: number;
  let peak: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    clock = new Clock();
    service = new ReviewQueueService(store, provider, clock.now);
    started = [];
    held = true;
    running = 0;
    peak = 0;
    const original = provider.fetchOpenPullRequests.bind(provider);
    provider.fetchOpenPullRequests = (token, owner, name) => {
      if (!held) return original(token, owner, name);
      peak = Math.max(peak, ++running);
      return new Promise((resolve) => {
        const read = { name, token, released: false, release: () => undefined };
        read.release = () => {
          read.released = true;
          running--;
          resolve(original(token, owner, name));
        };
        started.push(read);
      });
    };
  });

  const add = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => {
      store.addRepo("acme", `${prefix}${i}`, [], "main");
      provider.seed(`acme/${prefix}${i}`, {});
      return store.listRepos().find((r) => r.name === `${prefix}${i}`)!.id;
    });
  const names = () => started.map((r) => r.name);
  /** Lets the microtasks that hand a freed slot to the next waiter run; no timer is involved. */
  const tick = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };
  /** Releases the oldest unreleased read, then lets what follows run. */
  const releaseOne = async () => {
    started.find((r) => !r.released)!.release();
    await tick();
  };
  /** Releases reads as they start until every request has answered. */
  async function drain(...requests: Promise<unknown>[]) {
    let done = false;
    void Promise.all(requests).then(() => (done = true));
    for (let i = 0; i < 500 && !done; i++) {
      const next = started.find((r) => !r.released);
      if (next) next.release();
      await tick();
    }
    expect(done).toBe(true);
  }
  /** Reads every id once, ungated, then moves the clock so each read is stale but not yet expired. */
  async function goStale(ids: number[]) {
    held = false;
    await service.queue("token", ids);
    clock.advance(61);
    held = true;
  }
  const limitKeys = () => [...(service as unknown as { limits: Map<string, unknown> }).limits.keys()];

  it("starts a refresh before background reads that were already queued", async () => {
    const background = add("bg", 8);
    const [mine] = add("mine", 1);
    await goStale([...background, mine!]);
    await service.queue("token", background); // answers at once; starts eight background reads, four of them running
    expect(names()).toEqual(["bg0", "bg1", "bg2", "bg3"]);

    const refresh = service.queue("token", [mine!], { refresh: "all" });
    await releaseOne();
    expect(names().slice(4)).toEqual(["mine0"]);
    await drain(refresh);
    expect(names().slice(5)).toEqual(["bg4", "bg5", "bg6", "bg7"]);
  });

  it("moves a background read that a refresh joins ahead of the other background reads", async () => {
    const background = add("bg", 8);
    await goStale(background);
    await service.queue("token", background);
    // bg7 is the last of the background reads and still queued, but now a person is waiting for it.
    const refresh = service.queue("token", [background[7]!], { refresh: "all" });
    await releaseOne();
    expect(names().slice(4)).toEqual(["bg7"]);
    await drain(refresh);
    expect(names().slice(5)).toEqual(["bg4", "bg5", "bg6"]);
  });

  it("starts awaited reads in the order they were asked for", async () => {
    const ids = add("a", 7);
    const all = service.queue("token", ids);
    expect(names()).toEqual(["a0", "a1", "a2", "a3"]);
    await releaseOne();
    await releaseOne();
    await releaseOne();
    expect(names().slice(4)).toEqual(["a4", "a5", "a6"]);
    await drain(all);
  });

  it("starts background reads in the order they were asked for", async () => {
    const ids = add("b", 7);
    await goStale(ids);
    await service.queue("token", ids);
    await releaseOne();
    await releaseOne();
    await releaseOne();
    expect(names().slice(4)).toEqual(["b4", "b5", "b6"]);
    await drain();
  });

  it("holds two requests from one token that overlap to four reads at once", async () => {
    const first = service.queue("token", add("x", 6));
    const second = service.queue("token", add("y", 6));
    await tick();
    expect(started).toHaveLength(4);
    await drain(first, second);
    expect(peak).toBe(4);
    expect(started).toHaveLength(12);
  });

  it("still holds a request that arrives after slots were handed on to four reads at once", async () => {
    const first = service.queue("token", add("x", 6));
    await releaseOne(); // the slot passes straight to the next waiting read, so four are still running
    await releaseOne();
    expect(started).toHaveLength(6);
    const late = service.queue("token", add("late", 1));
    await tick();
    expect(started).toHaveLength(6); // the late read waits; a limiter that gave the slot back would have started it
    await drain(first, late);
    expect(peak).toBe(4);
  });

  it("keys the limiter on a hash of the token, and keeps nothing once the reads are done", async () => {
    const token = "secret-token-value";
    const request = service.queue(token, add("k", 5));
    await tick();
    const keys = limitKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.some((key) => key === token || key.includes(token))).toBe(false);
    await drain(request);
    expect(limitKeys()).toEqual([]);
  });
});

describe("ReviewQueueService over the GitHub adapter", () => {
  const openNode = {
    number: 12,
    title: "Add widgets",
    url: "https://github.com/acme/widgets/pull/12",
    state: "OPEN",
    createdAt: "2026-09-30T08:00:00Z",
    publishedAt: "2026-09-30T08:00:00Z",
    updatedAt: "2026-09-30T08:00:00Z",
    additions: 5,
    deletions: 1,
    mergedAt: null,
    closedAt: null,
    author: { login: "alice", __typename: "User" },
    changedFiles: 1,
    headRefName: "feature/widgets",
    isDraft: false,
    body: "",
    commits: { nodes: [] },
    reviews: { nodes: [] },
    latest: { nodes: [] },
    reviewRequests: { nodes: [] },
    closingIssuesReferences: { nodes: [] },
    labels: { nodes: [] },
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("drops the earlier read when GitHub answers 200 with NOT_FOUND on the repository, so the next request shows the error", async () => {
    const answers = [
      json({
        data: {
          repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 1, nodes: [openNode] } },
        },
      }),
    ];
    // Every read after the first is told the token cannot see the repository, as GitHub does after access is withdrawn.
    const http = vi.fn(
      async () =>
        answers.shift() ??
        json({
          data: { repository: null },
          errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository" }],
        }),
    );
    const store = new SqliteRepoStore(":memory:");
    const clock = new Clock();
    const service = new ReviewQueueService(store, new GitHubProvider(http), clock.now);
    const widgets = store.addRepo("acme", "widgets", [], "main").id;

    expect((await service.queue("token", [widgets])).entries).toHaveLength(1);
    clock.advance(61);
    // Served what was read earlier at once, while the background read learns that access has gone.
    expect((await service.queue("token", [widgets])).entries).toHaveLength(1);
    await settle();
    await settle();

    const next = await service.queue("token", [widgets]);
    expect(next.entries).toEqual([]);
    expect(next.errors).toEqual([
      { repoId: widgets, repo: "acme/widgets", message: "acme/widgets was not found, or your GitHub account cannot see it" },
    ]);
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

  it("reads again only the repositories named in refreshIds, and refresh=1 still reads them all", async () => {
    await app.inject("/api/review-queue");
    clock.advance(5);
    const some = await app.inject(`/api/review-queue?refreshIds=${ids[1]}`);
    expect(provider.openFetches).toBe(3);
    expect(some.json().repos.map((r: { fetchedAt: string }) => r.fetchedAt)).toEqual([
      "2026-09-30T12:00:00.000Z",
      "2026-09-30T12:00:05.000Z",
    ]);
    clock.advance(5);
    await app.inject(`/api/review-queue?refresh=1&refreshIds=${ids[1]}`);
    expect(provider.openFetches).toBe(5);
  });

  it("accepts a refreshIds list of exactly 50 ids", async () => {
    const res = await app.inject(`/api/review-queue?refreshIds=${Array(50).fill(ids[0]).join(",")}`);
    expect(res.statusCode).toBe(200);
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

  it.each([
    "ids=1;DROP",
    "ids=",
    "ids=abc",
    "refresh=yes",
    `ids=${Array(51).fill(1).join(",")}`,
    "refreshIds=",
    "refreshIds=abc",
    `refreshIds=${Array(51).fill(1).join(",")}`,
  ])("rejects %s", async (query) => {
    expect((await app.inject(`/api/review-queue?${query}`)).statusCode).toBe(400);
  });
});
