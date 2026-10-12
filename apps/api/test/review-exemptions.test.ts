import { REVIEW_EXEMPTION_DEFAULTS } from "@dora-dashboard/core";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { UnauthorisedError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { Logger } from "../src/interfaces/logger.js";
import { config, FakeCli, FakeProvider, pr, settled } from "./fakes.js";
import type { CrawlService } from "../src/services/crawl-service.js";

const dbOf = (store: SqliteRepoStore) => (store as unknown as { db: DatabaseSync }).db;

describe("review exemptions in the store", () => {
  let store: SqliteRepoStore;
  let repoId: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("starts with no override, read as the defaults", () => {
    expect(store.reviewExemptionState(repoId)).toEqual({ kind: "defaults" });
  });

  it("saves an override, and clears it with null", () => {
    const rules = { titleWords: ["mirror"], labels: ["vendored"] };

    store.setReviewExemptions(repoId, rules);
    expect(store.reviewExemptionState(repoId)).toEqual({ kind: "override", rules });

    store.setReviewExemptions(repoId, null);
    expect(store.reviewExemptionState(repoId)).toEqual({ kind: "defaults" });
  });

  it("keeps an override whose lists are empty, which is not the defaults", () => {
    store.setReviewExemptions(repoId, { titleWords: [], labels: [] });

    expect(store.reviewExemptionState(repoId)).toEqual({ kind: "override", rules: { titleWords: [], labels: [] } });
  });

  it("keeps one repository's override from another's", () => {
    const other = store.addRepo("acme", "gadgets", [], "main").id;
    store.setReviewExemptions(repoId, { titleWords: ["mirror"], labels: [] });

    expect(store.reviewExemptionState(other)).toEqual({ kind: "defaults" });
  });

  it("reads a repository that does not exist as no override", () => {
    expect(store.reviewExemptionState(999)).toEqual({ kind: "defaults" });
  });

  it.each([
    "{not json",
    "[1]",
    "7",
    "null",
    '{"titleWords":"sync","labels":[]}',
    '{"titleWords":[],"labels":[1]}',
    '{"titleWords":[]}',
    '{"labels":[]}',
    '{"titleWords":[],"labels":[],"extra":1}',
  ])("reads %s as unreadable, and as the defaults, so a report cannot throw on it", (bad) => {
    dbOf(store).prepare("UPDATE repos SET review_exemptions = ? WHERE id = ?").run(bad, repoId);

    expect(store.reviewExemptionState(repoId)).toEqual({ kind: "unreadable" });

    store.setReviewExemptions(repoId, { titleWords: ["mirror"], labels: [] });
    expect(store.reviewExemptionState(repoId).kind).toBe("override");
  });

  it("logs an unreadable override once per repository, naming it", () => {
    const warnings: Record<string, unknown>[] = [];
    const log: Logger = {
      info: () => undefined,
      error: () => undefined,
      warn: (context) => void warnings.push(context as Record<string, unknown>),
    };
    const logged = new SqliteRepoStore(":memory:", undefined, log);
    const id = logged.addRepo("acme", "widgets", [], "main").id;
    dbOf(logged).prepare("UPDATE repos SET review_exemptions = '{not json' WHERE id = ?").run(id);

    logged.reviewExemptionState(id);
    logged.reviewExemptionState(id);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ repoId: id });
  });
});

describe("migrating a database made before review exemptions", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dora-migrate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function oldDatabase(path: string): void {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      deploy_workflows TEXT NOT NULL DEFAULT '[]',
      deploy_branch TEXT NOT NULL DEFAULT 'main',
      added_at TEXT NOT NULL,
      last_crawled_at TEXT,
      crawl_status TEXT NOT NULL DEFAULT 'idle',
      crawl_error TEXT,
      crawl_progress TEXT,
      crawl_cursor TEXT,
      issues_enabled INTEGER,
      issue_cursor TEXT,
      issue_labels TEXT,
      issue_error TEXT,
      UNIQUE (owner, name)
    )`);
    db.prepare("INSERT INTO repos (owner, name, added_at) VALUES ('acme', 'widgets', '2026-09-01T00:00:00Z')").run();
    db.close();
  }

  const exemptionColumns = (path: string) => {
    const db = new DatabaseSync(path);
    const found = db.prepare("PRAGMA table_info(repos)").all() as unknown as { name: string }[];
    db.close();
    return found.map((c) => c.name).filter((name) => name === "review_exemptions");
  };

  it("adds the column, keeps the repository, and reads it as the defaults", () => {
    const path = join(dir, "old.db");
    oldDatabase(path);
    expect(exemptionColumns(path)).toEqual([]);

    const store = new SqliteRepoStore(path);

    expect(exemptionColumns(path)).toEqual(["review_exemptions"]);
    const repo = store.findRepo("acme", "widgets")!;
    expect(store.reviewExemptionState(repo.id)).toEqual({ kind: "defaults" });
  });

  it("changes nothing when opened a second time", () => {
    const path = join(dir, "old.db");
    oldDatabase(path);
    const first = new SqliteRepoStore(path);
    const id = first.findRepo("acme", "widgets")!.id;
    first.setReviewExemptions(id, { titleWords: ["mirror"], labels: ["vendored"] });

    const again = new SqliteRepoStore(path);

    expect(exemptionColumns(path)).toHaveLength(1);
    expect(again.reviewExemptionState(id)).toEqual({ kind: "override", rules: { titleWords: ["mirror"], labels: ["vendored"] } });
  });
});

describe("review exemptions through the routes", () => {
  let app: FastifyInstance;
  let crawler: CrawlService;
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let cli: FakeCli;
  let id: number;

  beforeEach(async () => {
    provider = new FakeProvider();
    cli = new FakeCli();
    store = new SqliteRepoStore(":memory:");
    provider.seed("acme/widgets", { prs: [pr({ number: 1 })], workflows: [] });
    ({ app, crawler } = await buildApp({
      config: config(),
      store,
      provider,
      sessions: new MemorySessionStore(),
      cli,
      exchangeCode: async () => "unused",
    }));
    id = store.addRepo("acme", "widgets", [], "main").id;
  });

  afterEach(() => app.close());

  const put = (payload: unknown, url = `/api/repos/${id}/review-exemptions`, headers: Record<string, string> = {}) =>
    app.inject({ method: "PUT", url, payload: payload as object, headers });
  const listing = async () => (await app.inject("/api/repos")).json<{ reviewExemptions: { kind: string } }[]>()[0]!;

  describe("GET /api/repos", () => {
    it("carries no override at first, and says it can be read", async () => {
      expect(await listing()).toMatchObject({ reviewExemptions: { kind: "defaults" } });
    });

    it("says when a saved override cannot be read, until a good one is saved", async () => {
      dbOf(store).prepare("UPDATE repos SET review_exemptions = '{not json' WHERE id = ?").run(id);
      expect(await listing()).toMatchObject({ reviewExemptions: { kind: "unreadable" } });

      await put({ exemptions: { titleWords: ["mirror"], labels: [] } });
      expect(await listing()).toMatchObject({ reviewExemptions: { kind: "override" } });
    });
  });

  describe("PUT /api/repos/:id/review-exemptions", () => {
    it("saves the override and answers 200 with the repository's listing row", async () => {
      const res = await put({ exemptions: { titleWords: ["mirror"], labels: ["vendored"] } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id,
        owner: "acme",
        name: "widgets",
        reviewExemptions: { kind: "override", rules: { titleWords: ["mirror"], labels: ["vendored"] } },
      });
      expect((await listing()).reviewExemptions).toEqual({
        kind: "override",
        rules: { titleWords: ["mirror"], labels: ["vendored"] },
      });
    });

    it("tidies the entries before saving them", async () => {
      const res = await put({
        exemptions: { titleWords: [" Mirror ", "mirror", "  ", "Vendor"], labels: [" Vendored", "VENDORED"] },
      });

      expect(res.json<{ reviewExemptions: unknown }>().reviewExemptions).toEqual({
        kind: "override",
        rules: { titleWords: ["Mirror", "Vendor"], labels: ["Vendored"] },
      });
    });

    it.each(["---", "!!!", "...", "\u2014", "- -"])(
      "refuses the title word %j, which holds no letter or digit and would never match",
      async (word) => {
        const res = await put({ exemptions: { titleWords: ["mirror", word], labels: [] } });

        expect(res.statusCode).toBe(400);
        expect((await listing()).reviewExemptions).toEqual({ kind: "defaults" });
      },
    );

    it("accepts a title word with a digit or a non-Latin letter, and a label of any characters", async () => {
      const res = await put({ exemptions: { titleWords: ["v2", "\u540c\u671f", "release-1"], labels: ["---"] } });

      expect(res.statusCode).toBe(200);
    });

    it("keeps lists that are empty, so a repository can switch exemptions off", async () => {
      const res = await put({ exemptions: { titleWords: [], labels: [] } });

      expect(res.json<{ reviewExemptions: unknown }>().reviewExemptions).toEqual({
        kind: "override",
        rules: { titleWords: [], labels: [] },
      });
    });

    it("returns to the defaults when the exemptions are null", async () => {
      await put({ exemptions: { titleWords: ["mirror"], labels: [] } });

      expect((await put({ exemptions: null })).json<{ reviewExemptions: unknown }>().reviewExemptions).toEqual({
        kind: "defaults",
      });
      expect(store.reviewExemptionState(id)).toEqual({ kind: "defaults" });
    });

    it("starts no crawl", async () => {
      await put({ exemptions: { titleWords: ["mirror"], labels: [] } });
      await settled(() => crawler.isCrawling(id));

      expect(crawler.isCrawling(id)).toBe(false);
      expect(provider.pagesServed).toBe(0);
      expect(store.getRepo(id)!.lastCrawledAt).toBeNull();
    });

    it.each([
      ["an extra key", { exemptions: null, extra: 1 }],
      ["an extra key inside the exemptions", { exemptions: { titleWords: [], labels: [], patterns: [] } }],
      ["title words missing", { exemptions: { labels: [] } }],
      ["labels missing", { exemptions: { titleWords: [] } }],
      ["exemptions missing", {}],
      ["an over-long entry", { exemptions: { titleWords: ["x".repeat(101)], labels: [] } }],
      ["an empty entry", { exemptions: { titleWords: [""], labels: [] } }],
      ["a control character", { exemptions: { titleWords: [], labels: ["bad\u0007label"] } }],
      ["more than 30 title words", { exemptions: { titleWords: Array.from({ length: 31 }, (_, i) => `w${i}`), labels: [] } }],
      ["more than 30 labels", { exemptions: { titleWords: [], labels: Array.from({ length: 31 }, (_, i) => `l${i}`) } }],
      ["exemptions false, which would otherwise be coerced to null", { exemptions: false }],
      ["exemptions 0, which would otherwise be coerced to null", { exemptions: 0 }],
      ["exemptions as an empty string, which would otherwise be coerced to null", { exemptions: "" }],
      ["exemptions as an array", { exemptions: [] }],
    ])("rejects %s with 400 and saves nothing", async (_why, payload) => {
      const res = await put(payload);

      expect(res.statusCode).toBe(400);
      expect(store.reviewExemptionState(id)).toEqual({ kind: "defaults" });
    });

    it("accepts an entry of exactly 100 characters and 30 of each", async () => {
      const names = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(100, "x"));

      expect((await put({ exemptions: { titleWords: names, labels: names } })).statusCode).toBe(200);
    });

    it("refuses another origin with 403 and saves nothing", async () => {
      const res = await put({ exemptions: { titleWords: ["mirror"], labels: [] } }, undefined, {
        origin: "http://evil.example.test",
      });

      expect(res.statusCode).toBe(403);
      expect(store.reviewExemptionState(id)).toEqual({ kind: "defaults" });
    });

    it("accepts the dashboard's own origin", async () => {
      expect((await put({ exemptions: null }, undefined, { origin: "http://localhost:5181" })).statusCode).toBe(200);
    });

    it("answers 404 for a repository that is not tracked", async () => {
      expect((await put({ exemptions: null }, "/api/repos/999/review-exemptions")).statusCode).toBe(404);
    });

    it("answers 400 for an id that is not a positive integer", async () => {
      expect((await put({ exemptions: null }, "/api/repos/0/review-exemptions")).statusCode).toBe(400);
    });

    it("answers 401 when not signed in", async () => {
      cli.error = new UnauthorisedError("run gh auth login");

      expect((await put({ exemptions: null })).statusCode).toBe(401);
    });
  });

  describe("GET /api/review-exemptions/defaults", () => {
    it("answers the default words and labels with the limits an override must keep to", async () => {
      const res = await app.inject("/api/review-exemptions/defaults");

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ...REVIEW_EXEMPTION_DEFAULTS, limits: { titleWords: 30, labels: 30, length: 100 } });
      expect(res.json<{ titleWords: string[] }>().titleWords).toContain("sync");
      expect(res.json<{ labels: string[] }>().labels).toEqual(["reviewed-elsewhere"]);
    });

    it("answers 401 when not signed in", async () => {
      cli.error = new UnauthorisedError("run gh auth login");

      expect((await app.inject("/api/review-exemptions/defaults")).statusCode).toBe(401);
    });
  });

  describe("the report", () => {
    const totals = async () => {
      const { unreviewedCount, unreviewedShare, exemptCount } = (await app.inject(`/api/repos/${id}/report?to=2026-09-13`)).json<{
        totals: { unreviewedCount: number; unreviewedShare: number | null; exemptCount: number };
      }>().totals;
      return { unreviewedCount, unreviewedShare, exemptCount };
    };

    beforeEach(() => {
      store.upsertPullRequests(id, [
        pr({ number: 1, title: "Add widget" }),
        pr({ number: 2, title: "Sync shared library 23 September" }),
        pr({ number: 3, title: "Mirror upstream" }),
        pr({ number: 4, title: "Tidy", labels: ["Vendored"] }),
      ]);
    });

    it("leaves out the default sync titles until the repository says otherwise", async () => {
      // Merged 4; Sync is exempt; counted 3 with no review.
      expect(await totals()).toEqual({ unreviewedCount: 3, unreviewedShare: 1, exemptCount: 1 });
    });

    it("follows a saved override at once, with no crawl", async () => {
      await put({ exemptions: { titleWords: ["mirror"], labels: ["vendored"] } });

      // Mirror and the Vendored label are exempt now, and Sync no longer is: counted 2 (pull requests 1 and 2).
      expect(await totals()).toEqual({ unreviewedCount: 2, unreviewedShare: 1, exemptCount: 2 });
    });

    it("falls back to the default exemptions for an override that cannot be read, and the report still answers", async () => {
      dbOf(store).prepare("UPDATE repos SET review_exemptions = ? WHERE id = ?").run('{"titleWords":"sync"}', id);

      // As with no override at all: the sync title is exempt, so 3 of the 4 are counted.
      expect(await totals()).toEqual({ unreviewedCount: 3, unreviewedShare: 1, exemptCount: 1 });
      expect((await listing()).reviewExemptions.kind).toBe("unreadable");
    });

    it("applies each repository's own rules when repositories are compared", async () => {
      const other = store.addRepo("acme", "gadgets", [], "main").id;
      store.upsertPullRequests(other, [
        pr({ number: 1, title: "Add gadget" }),
        pr({ number: 2, title: "Sync shared library 23 September" }),
        pr({ number: 3, title: "Mirror upstream" }),
      ]);
      // Widgets keeps the defaults. Gadgets exempts mirrors instead, so its sync title is counted.
      await put({ exemptions: { titleWords: ["mirror"], labels: [] } }, `/api/repos/${other}/review-exemptions`);

      const compared = (await app.inject(`/api/compare?ids=${id},${other}&to=2026-09-13`)).json<
        { repo: { name: string }; totals: { unreviewedCount: number; exemptCount: number } }[]
      >();

      expect(compared.map((r) => [r.repo.name, r.totals.unreviewedCount, r.totals.exemptCount])).toEqual([
        // Widgets: 4 merged, the sync title exempt, so 3 counted.
        ["widgets", 3, 1],
        // Gadgets: 3 merged, the mirror exempt, so 2 counted.
        ["gadgets", 2, 1],
      ]);
    });

    it("returns to the defaults when the override is cleared", async () => {
      await put({ exemptions: { titleWords: [], labels: [] } });
      expect(await totals()).toEqual({ unreviewedCount: 4, unreviewedShare: 1, exemptCount: 0 });

      await put({ exemptions: null });
      expect((await totals()).exemptCount).toBe(1);
    });
  });
});
