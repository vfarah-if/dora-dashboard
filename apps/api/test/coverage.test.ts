import type { CodeSnapshot } from "@dora-dashboard/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { CoverageService } from "../src/services/coverage-service.js";
import { CrawlService } from "../src/services/crawl-service.js";
import { CodeHealthService } from "../src/services/code-health-service.js";
import {
  config,
  coverageArtefact,
  coverageSnapshot,
  FakeCli,
  FakeCodeAnalyser,
  FakeCoverageSource,
  FakeProvider,
  FakeSourceCheckout,
  fn,
  pr,
  run,
  settled,
} from "./fakes.js";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 10, minute));

const codeSnapshot = (overrides: Partial<CodeSnapshot> = {}): CodeSnapshot => ({
  commitSha: "abc1234",
  analysedAt: "2026-09-29T10:00:00.000Z",
  functions: [fn({ file: "src/index.ts", ccn: 14, startLine: 1, endLine: 10 })],
  partlyMeasured: [],
  unmeasuredFiles: 0,
  error: null,
  tooling: null,
  snapshotVersion: 6,
  ...overrides,
});

describe("coverage snapshots in the store", () => {
  let store: SqliteRepoStore;
  let id: number;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    id = store.addRepo("acme", "widgets", [], "main").id;
  });

  it("round trips a snapshot and answers null before any", () => {
    expect(store.latestCoverageSnapshot(id)).toBeNull();
    expect(store.latestSuccessfulCoverageSnapshot(id)).toBeNull();
    const snapshot = coverageSnapshot();

    store.saveCoverageSnapshot(id, snapshot);

    expect(store.latestCoverageSnapshot(id)).toEqual(snapshot);
    expect(store.latestSuccessfulCoverageSnapshot(id)).toEqual(snapshot);
  });

  it("keeps the newest read apart from the newest successful one", () => {
    const good = coverageSnapshot({ fetchedAt: "2026-09-29T10:00:00.000Z" });
    const failed = coverageSnapshot({ fetchedAt: "2026-09-29T10:05:00.000Z", reports: [], error: "boom" });
    store.saveCoverageSnapshot(id, good);
    store.saveCoverageSnapshot(id, failed);

    expect(store.latestCoverageSnapshot(id)).toEqual(failed);
    expect(store.latestSuccessfulCoverageSnapshot(id)).toEqual(good);
  });

  it("keeps the newest five and the newest successful one", () => {
    store.saveCoverageSnapshot(id, coverageSnapshot({ fetchedAt: "2026-09-29T10:00:00.000Z" }));
    for (let minute = 1; minute <= 6; minute++) {
      store.saveCoverageSnapshot(id, coverageSnapshot({ fetchedAt: at(minute).toISOString(), reports: [], error: "boom" }));
    }

    // Seven were saved; the five newest are failures, and the oldest successful one is spared.
    const rows = (store as unknown as { db: { prepare(s: string): { all(): unknown[] } } }).db
      .prepare("SELECT fetched_at FROM coverage_snapshots ORDER BY fetched_at")
      .all();
    expect(rows).toHaveLength(6);
    expect(store.latestSuccessfulCoverageSnapshot(id)?.fetchedAt).toBe("2026-09-29T10:00:00.000Z");
  });

  it("removes a repository's snapshots with it", () => {
    store.saveCoverageSnapshot(id, coverageSnapshot());

    store.deleteRepo(id);

    expect(store.latestCoverageSnapshot(id)).toBeNull();
  });
});

describe("CoverageService", () => {
  let store: SqliteRepoStore;
  let source: FakeCoverageSource;
  let service: CoverageService;
  let clock: number;
  let repo: NonNullable<ReturnType<SqliteRepoStore["getRepo"]>>;

  beforeEach(() => {
    store = new SqliteRepoStore(":memory:");
    source = new FakeCoverageSource();
    clock = 0;
    service = new CoverageService(store, source, () => at(clock++));
    repo = store.addRepo("acme", "widgets", [], "release");
    store.saveCodeSnapshot(repo.id, codeSnapshot());
  });

  it("asks for the deploy branch with the token and stores what it read", async () => {
    source.publish(coverageArtefact({ id: 1, name: "coverage" }));

    await service.read("secret-token", repo, false);

    expect(source.finds).toEqual([{ token: "secret-token", owner: "acme", name: "widgets", branch: "release" }]);
    expect(store.latestCoverageSnapshot(repo.id)).toMatchObject({
      version: 1,
      runId: 100,
      commitSha: "abc1234",
      error: null,
      artefacts: [expect.objectContaining({ id: 1 })],
      reports: [expect.objectContaining({ format: "lcov" })],
    });
  });

  it("changes nothing when no artefact is found", async () => {
    await service.read("t", repo, false);

    expect(store.latestCoverageSnapshot(repo.id)).toBeNull();
  });

  it("does not read again while the run, artefacts and version are unchanged", async () => {
    source.publish(coverageArtefact({ id: 1 }));
    await service.read("t", repo, false);

    await service.read("t", repo, false);

    expect(source.reads).toEqual([1]);
  });

  it("reads again when forced", async () => {
    source.publish(coverageArtefact({ id: 1 }));
    await service.read("t", repo, false);

    await service.read("t", repo, true);

    expect(source.reads).toEqual([1, 1]);
  });

  it("reads again when the stored snapshot is from another version", async () => {
    source.publish(coverageArtefact({ id: 1 }));
    store.saveCoverageSnapshot(repo.id, coverageSnapshot({ version: 0, artefacts: [coverageArtefact({ id: 1 })] }));

    await service.read("t", repo, false);

    expect(source.reads).toEqual([1]);
    expect(store.latestCoverageSnapshot(repo.id)?.version).toBe(1);
  });

  it("prefers the run that built the analysed commit over a newer one", async () => {
    source.publish(coverageArtefact({ id: 1, runId: 100, commitSha: "abc1234", createdAt: "2026-09-29T09:00:00Z" }));
    source.publish(coverageArtefact({ id: 2, runId: 101, commitSha: "def5678", createdAt: "2026-09-29T09:30:00Z" }));

    await service.read("t", repo, false);

    expect(source.reads).toEqual([1]);
    expect(store.latestCoverageSnapshot(repo.id)?.commitSha).toBe("abc1234");
  });

  it("falls back to the newest run when none built the analysed commit", async () => {
    store.saveCodeSnapshot(repo.id, codeSnapshot({ commitSha: "zzz9999", analysedAt: "2026-09-29T10:01:00.000Z" }));
    source.publish(coverageArtefact({ id: 1, runId: 100, createdAt: "2026-09-29T09:00:00Z" }));
    source.publish(coverageArtefact({ id: 2, runId: 101, commitSha: "def5678", createdAt: "2026-09-29T09:30:00Z" }));

    await service.read("t", repo, false);

    expect(source.reads).toEqual([2]);
  });

  it("keeps every artefact of the chosen run, so a matrix is read whole", async () => {
    source.publish(coverageArtefact({ id: 1, name: "coverage-api" }));
    source.publish(coverageArtefact({ id: 2, name: "coverage-web" }));

    await service.read("t", repo, false);

    expect(source.reads.sort()).toEqual([1, 2]);
    expect(store.latestCoverageSnapshot(repo.id)?.reports).toHaveLength(2);
  });

  it("stores a failure as an error snapshot and keeps the last good one", async () => {
    source.publish(coverageArtefact({ id: 1 }));
    await service.read("t", repo, false);
    source.publish(coverageArtefact({ id: 2, runId: 101, createdAt: "2026-09-29T09:30:00Z", commitSha: "abc1234" }));
    source.readFailWith = new UpstreamError("The archive is corrupt", 502);

    await service.read("t", repo, false);

    expect(store.latestCoverageSnapshot(repo.id)).toMatchObject({ error: "The archive is corrupt", reports: [], runId: 101 });
    expect(store.latestSuccessfulCoverageSnapshot(repo.id)).toMatchObject({ runId: 100, error: null });
  });

  it("tries a failed read again on the next crawl", async () => {
    source.publish(coverageArtefact({ id: 1 }));
    source.readFailWith = new UpstreamError("busy", 502);
    await service.read("t", repo, false);
    source.readFailWith = null;

    await service.read("t", repo, false);

    expect(store.latestCoverageSnapshot(repo.id)).toMatchObject({ error: null, reports: [expect.anything()] });
  });

  it("stores a failure to find artefacts without a run", async () => {
    source.findFailWith = new UpstreamError("GitHub is unavailable", 502);

    await service.read("t", repo, false);

    expect(store.latestCoverageSnapshot(repo.id)).toMatchObject({
      error: "GitHub is unavailable",
      runId: null,
      commitSha: null,
      artefacts: [],
    });
  });

  it("hides an unexpected failure's message from the stored snapshot", async () => {
    source.publish(coverageArtefact({ id: 1 }));
    source.readFailWith = new Error("ENOENT /home/runner/work/client-x/secret.lcov");

    await service.read("t", repo, false);

    expect(store.latestCoverageSnapshot(repo.id)?.error).toBe("Reading coverage failed unexpectedly. See the API log.");
  });

  it("stores an error when the artefacts held no readable report", async () => {
    source.publish(coverageArtefact({ id: 1 }), []);

    await service.read("t", repo, false);

    expect(store.latestCoverageSnapshot(repo.id)?.error).toMatch(/no report in a format that is read/);
  });

  it("rethrows a rejected credential and stores nothing", async () => {
    source.findFailWith = new UnauthorisedError("Bad credentials");

    await expect(service.read("t", repo, false)).rejects.toBeInstanceOf(UnauthorisedError);
    expect(store.latestCoverageSnapshot(repo.id)).toBeNull();
  });

  it("works when no code snapshot exists yet, taking the newest run", async () => {
    const bare = store.addRepo("acme", "gadgets", [], "main");
    source.publish(coverageArtefact({ id: 1 }));

    await service.read("t", bare, false);

    expect(store.latestCoverageSnapshot(bare.id)?.runId).toBe(100);
  });
});

describe("coverage during a crawl", () => {
  let store: SqliteRepoStore;
  let provider: FakeProvider;
  let source: FakeCoverageSource;
  let checkout: FakeSourceCheckout;
  let crawler: CrawlService;
  let repoId: number;

  const build = (overrides: { coverage?: boolean } = {}) => {
    store = new SqliteRepoStore(":memory:");
    provider = new FakeProvider();
    source = new FakeCoverageSource();
    checkout = new FakeSourceCheckout();
    const health = new CodeHealthService(store, checkout, new FakeCodeAnalyser(), () => at(0));
    const coverage = overrides.coverage === false ? undefined : new CoverageService(store, source, () => at(clock++));
    crawler = new CrawlService(store, provider, health, undefined, undefined, coverage);
    provider.seed("acme/widgets", { prs: [pr({ number: 1 })], runs: [run({ runId: 1 })] });
    repoId = store.addRepo("acme", "widgets", ["deploy.yml"], "main").id;
  };
  let clock = 0;

  beforeEach(() => {
    clock = 1;
  });

  it("reads coverage after analysing the code", async () => {
    build();
    source.publish(coverageArtefact({ id: 1 }));

    await crawler.crawl("t", repoId);

    expect(store.latestCoverageSnapshot(repoId)).toMatchObject({ runId: 100, error: null });
  });

  it("reads no coverage without the collaborator", async () => {
    build({ coverage: false });
    source.publish(coverageArtefact({ id: 1 }));

    await crawler.crawl("t", repoId);

    expect(source.finds).toEqual([]);
  });

  it("is not failed by a coverage error", async () => {
    build();
    source.findFailWith = new UpstreamError("GitHub is unavailable", 502);

    await expect(crawler.crawl("t", repoId)).resolves.toBeUndefined();

    expect(store.getRepo(repoId)?.crawlStatus).toBe("idle");
    expect(store.latestCoverageSnapshot(repoId)?.error).toBe("GitHub is unavailable");
  });

  it("is failed by a rejected credential", async () => {
    build();
    source.findFailWith = new UnauthorisedError("Bad credentials");

    await expect(crawler.crawl("t", repoId)).rejects.toBeInstanceOf(UnauthorisedError);

    expect(store.getRepo(repoId)?.crawlStatus).toBe("failed");
  });

  it("logs and carries on when the service throws something that is not a rejected credential", async () => {
    build();
    const broken = new CrawlService(store, provider, undefined, undefined, undefined, {
      read: async () => {
        throw new Error("boom");
      },
    } as unknown as CoverageService);

    await expect(broken.crawl("t", repoId)).resolves.toBeUndefined();
  });

  it("picks up coverage that CI publishes after a crawl, with the head unchanged", async () => {
    build();
    await crawler.crawl("t", repoId);
    expect(store.latestCoverageSnapshot(repoId)).toBeNull();
    const clones = checkout.requests.length;

    source.publish(coverageArtefact({ id: 1, commitSha: "abc1234" }));
    await crawler.crawl("t", repoId);

    expect(checkout.requests.length).toBe(clones);
    expect(store.latestCoverageSnapshot(repoId)).toMatchObject({ commitSha: "abc1234", error: null });
  });
});

describe("code detail route", () => {
  let app: FastifyInstance;
  let store: SqliteRepoStore;
  let crawler: CrawlService;
  let source: FakeCoverageSource;
  let id: number;

  const build = async (codeAnalysis = true) => {
    const provider = new FakeProvider();
    provider.seed("acme/widgets", { prs: [pr({ number: 1 })], runs: [run({ runId: 1 })], workflows: ["deploy.yml"] });
    store = new SqliteRepoStore(":memory:");
    source = new FakeCoverageSource();
    ({ app, crawler } = await buildApp({
      config: config({ codeAnalysis }),
      store,
      provider,
      sessions: new MemorySessionStore(),
      cli: new FakeCli(),
      exchangeCode: async () => "unused",
      checkout: new FakeSourceCheckout(),
      analyser: new FakeCodeAnalyser(),
      coverage: source,
    }));
    id = store.addRepo("acme", "widgets", [], "main").id;
  };

  beforeEach(() => build());
  afterEach(() => app.close());

  const detail = (query = "") => app.inject(`/api/repos/${id}/code-detail${query}`);

  it("answers none before any analysis", async () => {
    expect((await detail()).json()).toEqual({ status: "none" });
  });

  it("answers error when no analysis has ever succeeded", async () => {
    store.saveCodeSnapshot(id, codeSnapshot({ commitSha: "", error: "clone failed", functions: [] }));

    expect((await detail()).json()).toEqual({
      status: "error",
      message: "clone failed",
      analysedAt: "2026-09-29T10:00:00.000Z",
      reason: "failed",
    });
  });

  it("reports the repository with no coverage yet", async () => {
    store.saveCodeSnapshot(id, codeSnapshot());

    const body = (await detail()).json();

    expect(body).toMatchObject({ status: "ok", commitSha: "abc1234", area: null, coverage: { status: "none" } });
    expect(body.functions.total).toBe(1);
  });

  it("includes the last measured coverage", async () => {
    store.saveCodeSnapshot(id, codeSnapshot({ files: ["src/index.ts"], layout: { manifests: [], workspaces: null } }));
    store.saveCoverageSnapshot(id, coverageSnapshot());

    const body = (await detail()).json();

    expect(body.coverage).toMatchObject({
      status: "ok",
      otherCommit: false,
      lines: { covered: 8, total: 10 },
      files: { inReport: 1, matched: 1, unmatched: 0 },
    });
  });

  it("keeps the last good figures and says when a newer analysis failed", async () => {
    store.saveCodeSnapshot(id, codeSnapshot());
    store.saveCodeSnapshot(
      id,
      codeSnapshot({ commitSha: "", analysedAt: "2026-09-29T11:00:00.000Z", error: "clone failed", functions: [] }),
    );

    expect((await detail()).json()).toMatchObject({
      status: "ok",
      commitSha: "abc1234",
      lastError: { message: "clone failed", reason: "failed" },
    });
  });

  it("scopes the report to a valid area", async () => {
    store.saveCodeSnapshot(
      id,
      codeSnapshot({
        functions: [fn({ file: "packages/core/src/a.ts" }), fn({ file: "apps/api/src/b.ts" })],
        files: ["apps/api/src/b.ts", "packages/core/src/a.ts"],
        layout: { manifests: ["apps/api/package.json", "packages/core/package.json"], workspaces: null },
      }),
    );

    const body = (await detail("?area=packages%2Fcore")).json();

    expect(body).toMatchObject({ status: "ok", area: "packages/core" });
    expect(body).not.toHaveProperty("missingArea");
    expect(body.functions.total).toBe(1);
  });

  it("falls back to the whole repository for an unknown area and says so", async () => {
    store.saveCodeSnapshot(id, codeSnapshot());

    const body = (await detail("?area=nowhere")).json();

    expect(body).toMatchObject({ status: "ok", area: null, missingArea: "nowhere" });
  });

  it.each([
    ["a backslash", "?area=a%5Cb"],
    ["a control character", "?area=a%0Ab"],
    ["more than 500 characters", `?area=${"a".repeat(501)}`],
  ])("answers 400 for an area with %s", async (_label, query) => {
    store.saveCodeSnapshot(id, codeSnapshot());

    expect((await detail(query)).statusCode).toBe(400);
  });

  it("answers 404 for an unknown repository and 400 for a bad id", async () => {
    expect((await app.inject("/api/repos/99/code-detail")).statusCode).toBe(404);
    expect((await app.inject("/api/repos/abc/code-detail")).statusCode).toBe(400);
  });

  it("reads coverage during a crawl started through the app", async () => {
    source.publish(coverageArtefact({ id: 1 }));

    await app.inject({ method: "POST", url: `/api/repos/${id}/crawl` });
    await settled(() => crawler.isCrawling(id));

    expect(store.latestCoverageSnapshot(id)).toMatchObject({ runId: 100 });
  });

  it("builds no coverage service when analysis is off", async () => {
    await app.close();
    await build(false);
    source.publish(coverageArtefact({ id: 1 }));

    await crawler.crawl("t", id);

    expect(source.finds).toEqual([]);
  });
});
