import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { statusFor } from "../src/routes/errors.js";
import type { CrawlService } from "../src/services/crawl-service.js";
import { config, FakeCli, FakeProvider, pr, run, settled } from "./fakes.js";

describe("repository and report routes (gh-cli mode)", () => {
  let app: FastifyInstance;
  let crawler: CrawlService;
  let provider: FakeProvider;
  let cli: FakeCli;

  beforeEach(async () => {
    provider = new FakeProvider();
    cli = new FakeCli();
    provider.seed("acme/widgets", {
      prs: [pr({ number: 1 }), pr({ number: 2 })],
      runs: [run({ runId: 1 })],
      workflows: ["deploy.yml"],
    });
    provider.seed("acme/gadgets", { prs: [pr({ number: 7 })] });
    ({ app, crawler } = await buildApp({
      config: config(),
      store: new SqliteRepoStore(":memory:"),
      provider,
      sessions: new MemorySessionStore(),
      cli,
      exchangeCode: async () => "unused",
    }));
  });

  afterEach(() => app.close());

  const add = (repo: string) => app.inject({ method: "POST", url: "/api/repos", payload: { repo } });

  it("reports the local CLI user", async () => {
    const res = await app.inject("/api/auth/me");
    expect(res.json()).toEqual({
      mode: "gh-cli",
      user: { login: "local-dev", avatarUrl: "" },
      error: null,
      source: "cli",
      deviceFlow: false,
    });
  });

  it("explains a missing CLI login rather than failing", async () => {
    cli.error = new UnauthorisedError("run gh auth login");
    expect((await app.inject("/api/auth/me")).json()).toMatchObject({ user: null, error: "run gh auth login" });
    expect((await app.inject("/api/repos")).statusCode).toBe(401);
  });

  it("adds a repository, crawls it in the background and reports on it", async () => {
    const created = await add("acme/widgets");
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: number }>();
    await settled(() => crawler.isCrawling(id));

    const list = (await app.inject("/api/repos")).json();
    expect(list).toEqual([expect.objectContaining({ id, pullRequests: 2, deployRuns: 1, crawlStatus: "idle" })]);

    const report = await app.inject(`/api/repos/${id}/report?to=2026-09-30`);
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ totals: { merged: 2 }, dora: { deploymentFrequency: { total: 1 } } });
  });

  it("leaves the authors named in excludeAuthors out of a report", async () => {
    const { id } = (await add("acme/widgets")).json<{ id: number }>();
    await settled(() => crawler.isCrawling(id));

    const res = await app.inject(`/api/repos/${id}/report?to=2026-09-30&excludeAuthors=${encodeURIComponent(" alice ,,alice")}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totals: { opened: 0, merged: 0 }, authorChoices: [{ author: "alice", excluded: true }] });
    expect((await app.inject(`/api/repos/${id}/report?excludeAuthors=${"a".repeat(4001)}`)).statusCode).toBe(400);
  });

  it("compares two repositories", async () => {
    const a = (await add("acme/widgets")).json<{ id: number }>().id;
    const b = (await add("acme/gadgets")).json<{ id: number }>().id;
    await settled(() => crawler.isCrawling(a) || crawler.isCrawling(b));

    const res = await app.inject(`/api/compare?ids=${a},${b}&to=2026-09-30`);
    expect(res.json<{ repo: { name: string } }[]>().map((r) => r.repo.name)).toEqual(["widgets", "gadgets"]);
  });

  it("grades against the default profile and reports the AI cohorts", async () => {
    const { id } = (await add("acme/widgets")).json<{ id: number }>();
    await settled(() => crawler.isCrawling(id));

    const report = (await app.inject(`/api/repos/${id}/report?to=2026-09-30`)).json();
    expect(report.dora.profile.id).toBe("dora-2023");
    expect(report.aiCohorts).toMatchObject({ assisted: { prs: expect.any(Number) }, unassisted: { prs: expect.any(Number) } });
    expect(report.aiCohorts.unknown).toEqual(expect.any(Number));
  });

  it("rejects an unknown profile on a report and on a comparison, and accepts a known one on both", async () => {
    const a = (await add("acme/widgets")).json<{ id: number }>().id;
    const b = (await add("acme/gadgets")).json<{ id: number }>().id;
    await settled(() => crawler.isCrawling(a) || crawler.isCrawling(b));

    expect((await app.inject(`/api/repos/${a}/report?profile=nope`)).statusCode).toBe(400);
    expect((await app.inject(`/api/compare?ids=${a},${b}&profile=nope`)).statusCode).toBe(400);

    expect((await app.inject(`/api/repos/${a}/report?profile=dora-2023`)).json().dora.profile.id).toBe("dora-2023");
    const compared = await app.inject(`/api/compare?ids=${a},${b}&profile=dora-2023&to=2026-09-30`);
    expect(compared.statusCode).toBe(200);
    expect(compared.json<{ dora: { profile: { id: string } } }[]>().map((r) => r.dora.profile.id)).toEqual([
      "dora-2023",
      "dora-2023",
    ]);
  });

  it("maps service errors onto statuses with a readable body", async () => {
    expect((await add("nonsense")).statusCode).toBe(400);
    expect((await add("acme/missing")).json()).toEqual({ error: "acme/missing was not found" });
    await add("acme/widgets");
    expect((await add("acme/widgets")).statusCode).toBe(409);
    expect((await app.inject("/api/repos/999/report")).statusCode).toBe(404);
  });

  it("validates bodies and query strings before a handler runs", async () => {
    expect(
      (await app.inject({ method: "POST", url: "/api/repos", payload: { repo: "acme/widgets", extra: 1 } })).statusCode,
    ).toBe(400);
    expect((await app.inject("/api/repos/1/report?from=yesterday")).statusCode).toBe(400);
    expect((await app.inject("/api/compare?ids=1;DROP")).statusCode).toBe(400);
    expect((await app.inject("/api/repos/abc/report")).statusCode).toBe(400);
  });

  it("reconfigures, re-crawls, lists workflows and deletes", async () => {
    const id = (await add("acme/widgets")).json<{ id: number }>().id;
    await settled(() => crawler.isCrawling(id));

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/repos/${id}`,
      payload: { deployWorkflows: ["deploy.yml"], deployBranch: "release" },
    });
    expect(patched.json()).toMatchObject({ deployBranch: "release" });
    await settled(() => crawler.isCrawling(id));

    expect((await app.inject({ method: "POST", url: `/api/repos/${id}/crawl?full=1` })).statusCode).toBe(202);
    await settled(() => crawler.isCrawling(id));
    expect((await app.inject(`/api/repos/${id}/workflows`)).json()).toEqual(["deploy.yml"]);
    expect((await app.inject({ method: "DELETE", url: `/api/repos/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: `/api/repos/${id}/crawl` })).statusCode).toBe(404);
  });

  it("hides the detail of an unexpected error", async () => {
    app.get("/api/boom", async () => {
      throw new Error("secret internals");
    });
    const res = await app.inject("/api/boom");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Something went wrong on the server" });
  });

  it("answers health with the auth mode and provider", async () => {
    expect((await app.inject("/api/health")).json()).toEqual({ ok: true, authMode: "gh-cli", provider: "fake" });
  });
});

describe("statusFor", () => {
  it("maps an upstream failure to 502 and anything unknown to 500", () => {
    expect(statusFor(new UpstreamError("x", 500))).toBe(502);
    expect(statusFor(new Error("x"))).toBe(500);
  });
});
