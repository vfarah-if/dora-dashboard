import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { UnauthorisedError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { CrawlService } from "../src/services/crawl-service.js";
import { config, FakeCli, FakeIssueProvider, FakeProvider, issue, pr, settled } from "./fakes.js";

describe("issues through the repository routes", () => {
  let app: FastifyInstance;
  let crawler: CrawlService;
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let issues: FakeIssueProvider;
  let cli: FakeCli;
  let id: number;

  beforeEach(async () => {
    provider = new FakeProvider();
    issues = new FakeIssueProvider();
    cli = new FakeCli();
    store = new SqliteRepoStore(":memory:");
    provider.seed("acme/widgets", { prs: [pr({ number: 1 })], workflows: [] });
    issues.seed("acme/widgets", [issue({ number: 1 }), issue({ number: 2, updatedAt: "2026-09-02T12:00:00Z" })]);
    ({ app, crawler } = await buildApp({
      config: config(),
      store,
      provider,
      issues,
      sessions: new MemorySessionStore(),
      cli,
      exchangeCode: async () => "unused",
    }));
    id = store.addRepo("acme", "widgets", [], "main").id;
  });

  afterEach(() => app.close());

  const put = (payload: unknown, url = `/api/repos/${id}/issue-labels`, headers: Record<string, string> = {}) =>
    app.inject({ method: "PUT", url, payload: payload as object, headers });

  describe("GET /api/repos", () => {
    it("carries the issue fields, empty before anything was read", async () => {
      const [row] = (await app.inject("/api/repos")).json<Record<string, unknown>[]>();

      expect(row).toMatchObject({ id, issues: 0, issuesEnabled: null, issueLabels: null, issueError: null });
    });

    it("counts the issues a crawl read and says issues are on", async () => {
      await crawler.crawl("token", id);

      const [row] = (await app.inject("/api/repos")).json<Record<string, unknown>[]>();

      expect(row).toMatchObject({ issues: 2, issuesEnabled: true, issueLabels: null, issueError: null });
    });

    it("says issues are off, and why a read failed", async () => {
      issues.setEnabled("acme/widgets", false);
      await crawler.crawl("token", id);
      expect((await app.inject("/api/repos")).json<{ issuesEnabled: boolean }[]>()[0]!.issuesEnabled).toBe(false);

      store.failIssueCrawl(id, "GitHub answered 500");
      expect((await app.inject("/api/repos")).json<{ issueError: string }[]>()[0]!.issueError).toBe("GitHub answered 500");
    });

    it("lists a repository with no issue provider wired as having none", async () => {
      const bare = await buildApp({
        config: config(),
        store,
        provider,
        sessions: new MemorySessionStore(),
        cli,
        exchangeCode: async () => "unused",
      });
      await bare.crawler.crawl("token", id);

      expect((await bare.app.inject("/api/repos")).json()).toEqual([expect.objectContaining({ issues: 0, issuesEnabled: null })]);
      await bare.app.close();
    });
  });

  describe("PUT /api/repos/:id/issue-labels", () => {
    it("saves the override and answers 200 with the repository's listing row", async () => {
      const res = await put({ labels: { kinds: { bug: ["defect"] }, priorities: { P0: ["sev1"] } } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id,
        owner: "acme",
        name: "widgets",
        issues: 0,
        issueLabels: { kinds: { bug: ["defect"] }, priorities: { P0: ["sev1"] } },
      });
      expect((await app.inject("/api/repos")).json<{ issueLabels: unknown }[]>()[0]!.issueLabels).toEqual({
        kinds: { bug: ["defect"] },
        priorities: { P0: ["sev1"] },
      });
    });

    it("tidies the names before saving them", async () => {
      const res = await put({ labels: { kinds: { bug: [" defect ", "Defect", "  ", "fault"], feature: [" "] } } });

      expect(res.json<{ issueLabels: unknown }>().issueLabels).toEqual({ kinds: { bug: ["defect", "fault"] } });
    });

    it("returns to the defaults when the labels are null, or nothing is left of them", async () => {
      await put({ labels: { kinds: { bug: ["defect"] } } });

      expect((await put({ labels: null })).json<{ issueLabels: unknown }>().issueLabels).toBeNull();

      await put({ labels: { kinds: { bug: ["defect"] } } });
      expect(
        (await put({ labels: { kinds: { bug: [" "] }, priorities: {} } })).json<{ issueLabels: unknown }>().issueLabels,
      ).toBeNull();
      expect(store.issueState(id).labels).toBeNull();
    });

    it("starts no crawl", async () => {
      await put({ labels: { kinds: { bug: ["defect"] } } });
      await settled(() => crawler.isCrawling(id));

      expect(crawler.isCrawling(id)).toBe(false);
      expect(provider.pagesServed).toBe(0);
      expect(issues.calls).toHaveLength(0);
      expect(store.getRepo(id)!.lastCrawledAt).toBeNull();
    });

    it.each([
      ["an extra key", { labels: null, extra: 1 }],
      ["an extra key inside labels", { labels: { colours: {} } }],
      ["an unknown kind", { labels: { kinds: { other: ["x"] } } }],
      ["an unknown priority", { labels: { priorities: { P5: ["x"] } } }],
      ["an over-long name", { labels: { kinds: { bug: ["x".repeat(101)] } } }],
      ["an empty name", { labels: { kinds: { bug: [""] } } }],
      ["a control character in a name", { labels: { kinds: { bug: ["bad\u0007name"] } } }],
      ["more than 30 names", { labels: { kinds: { bug: Array.from({ length: 31 }, (_, i) => `n${i}`) } } }],
      ["labels missing", {}],
    ])("rejects %s with 400", async (_why, payload) => {
      const res = await put(payload);

      expect(res.statusCode).toBe(400);
      expect(store.issueState(id).labels).toBeNull();
    });

    it("accepts a name of exactly 100 characters and 30 names", async () => {
      const names = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(100, "x"));

      expect((await put({ labels: { kinds: { bug: names } } })).statusCode).toBe(200);
    });

    it("refuses another origin with 403 and saves nothing", async () => {
      const res = await put({ labels: { kinds: { bug: ["defect"] } } }, undefined, { origin: "http://evil.example.test" });

      expect(res.statusCode).toBe(403);
      expect(store.issueState(id).labels).toBeNull();
    });

    it("accepts the dashboard's own origin", async () => {
      const res = await put({ labels: null }, undefined, { origin: "http://localhost:5181" });

      expect(res.statusCode).toBe(200);
    });

    it("answers 404 for a repository that is not tracked", async () => {
      expect((await put({ labels: null }, "/api/repos/999/issue-labels")).statusCode).toBe(404);
    });

    it("answers 400 for an id that is not a positive integer", async () => {
      expect((await put({ labels: null }, "/api/repos/0/issue-labels")).statusCode).toBe(400);
    });

    it("answers 401 when not signed in", async () => {
      cli.error = new UnauthorisedError("run gh auth login");

      expect((await put({ labels: null })).statusCode).toBe(401);
    });
  });
});

describe("the issue report", () => {
  let app: FastifyInstance;
  let store: SqliteRepoStore;
  let id: number;
  const NOW = new Date("2026-10-07T12:00:00Z");

  beforeEach(async () => {
    store = new SqliteRepoStore(":memory:");
    ({ app } = await buildApp({
      config: config(),
      store,
      provider: new FakeProvider(),
      sessions: new MemorySessionStore(),
      cli: new FakeCli(),
      exchangeCode: async () => "unused",
      clock: () => NOW,
    }));
    id = store.addRepo("acme", "widgets", [], "main").id;
    store.upsertIssues(id, [
      // Open, a bug named P1, assigned: not unclassified.
      issue({
        number: 1,
        state: "open",
        closeReason: null,
        closedAt: null,
        events: [],
        labels: ["bug", "P1"],
        assignees: ["bob"],
        createdAt: "2026-09-02T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
      }),
      // Open, no label and so unclassified, assigned to a person whose name must stay behind the toggle.
      issue({
        number: 2,
        state: "open",
        closeReason: null,
        closedAt: null,
        events: [],
        assignees: ["carol"],
        createdAt: "2026-09-03T00:00:00Z",
        updatedAt: "2026-09-03T00:00:00Z",
      }),
      // Created 1 September 00:00, closed as completed 2 September 12:00: 36 hours.
      issue({
        number: 3,
        createdAt: "2026-09-01T00:00:00Z",
        closedAt: "2026-09-02T12:00:00Z",
        updatedAt: "2026-09-02T12:00:00Z",
        events: [{ at: "2026-09-02T12:00:00Z", type: "closed", reason: "completed" }],
      }),
    ]);
  });

  afterEach(() => app.close());

  const get = (query = "", repo: number | string = id) => app.inject(`/api/repos/${repo}/issues/report${query}`);
  type Finding = { check: string; items?: { number: number; assigned: boolean; assignee?: string | null }[] };

  it("reports the stored issues over the range, hand-computed", async () => {
    const res = await get("?from=2026-09-01&to=2026-09-30");

    expect(res.statusCode).toBe(200);
    // All three opened in September; #3 closed as completed; #1 and #2 are still open.
    expect(res.json()).toMatchObject({
      repo: { id, owner: "acme", name: "widgets" },
      range: { from: "2026-09-01", to: "2026-09-30" },
      totals: { opened: 3, closed: 1, notPlanned: 0, open: 2, openEpics: 0 },
      timeToClose: { count: 1, median: 36 },
    });
  });

  it("builds the report at the injected clock when no end is given", async () => {
    const res = await get();

    expect(res.json<{ range: { from: string; to: string } }>().range).toEqual({ from: "2026-09-01", to: "2026-10-07" });
  });

  it("leaves names out unless people=1 is given", async () => {
    const without = (await get("?from=2026-09-01&to=2026-09-30")).json<{ hygiene: Finding[] }>();
    const withNames = (await get("?from=2026-09-01&to=2026-09-30&people=1")).json<{ hygiene: Finding[] }>();
    const unclassified = (report: { hygiene: Finding[] }) => report.hygiene.find((f) => f.check === "unclassified")!.items![0]!;

    expect(unclassified(without)).toMatchObject({ number: 2, assigned: true });
    expect("assignee" in unclassified(without)).toBe(false);
    expect(JSON.stringify(without)).not.toContain("carol");
    expect(unclassified(withNames)).toMatchObject({ number: 2, assignee: "carol" });
  });

  it("uses the repository's label override", async () => {
    store.upsertIssues(id, [
      issue({
        number: 2,
        state: "open",
        closeReason: null,
        closedAt: null,
        events: [],
        labels: ["glitch"],
        createdAt: "2026-09-03T00:00:00Z",
      }),
    ]);
    const kinds = async () =>
      Object.fromEntries(
        (await get("?from=2026-09-01&to=2026-09-30"))
          .json<{ ageing: { number: number; kind: string }[] }>()
          .ageing.map((a) => [a.number, a.kind]),
      );
    expect(await kinds()).toEqual({ 1: "bug", 2: "other" });

    store.setIssueLabels(id, { kinds: { bug: ["glitch"] } });

    // The override replaces the default names for bug, so the "bug" label stops counting and "glitch" starts.
    expect(await kinds()).toEqual({ 1: "other", 2: "bug" });
  });

  it("answers 404 for a repository that is not tracked", async () => {
    expect((await get("", 999)).statusCode).toBe(404);
  });

  it("answers 200 with nothing counted for a repository with no issues", async () => {
    const empty = store.addRepo("acme", "gadgets", [], "main").id;

    const res = await get("?to=2026-09-30", empty);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totals: { opened: 0, closed: 0, open: 0 } });
  });

  it.each([
    ["a malformed date", "?from=2026-9-1", "must match pattern"],
    ["a from after to", "?from=2026-09-30&to=2026-09-01", "from must not be after to"],
    ["a from after today", "?from=2026-10-08", "from must not be after today"],
    ["an unknown people value", "?people=yes", ""],
  ])("answers 400 for %s", async (_why, query, message) => {
    const res = await get(query);

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain(message);
  });

  it("answers 400 for an id that is not a positive integer", async () => {
    expect((await get("", 0)).statusCode).toBe(400);
  });

  it("answers 401 when not signed in", async () => {
    const cli = new FakeCli();
    cli.error = new UnauthorisedError("run gh auth login");
    const signedOut = await buildApp({
      config: config(),
      store,
      provider: new FakeProvider(),
      sessions: new MemorySessionStore(),
      cli,
      exchangeCode: async () => "unused",
    });

    expect((await signedOut.app.inject(`/api/repos/${id}/issues/report`)).statusCode).toBe(401);
    await signedOut.app.close();
  });
});
