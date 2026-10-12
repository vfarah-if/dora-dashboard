import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../src/app.js";
import { UnauthorisedError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import {
  FakeCli,
  FakeCodeAnalyser,
  FakeCoverageSource,
  FakeProvider,
  FakeScorecardSource,
  FakeSecurityAlertSource,
  FakeSourceCheckout,
  FakeVulnerabilityDatabase,
  FakeWorkspaceReader,
  config,
  dependabotAlert,
  lockedPackage,
  pr,
  repoPosture,
  scorecardResult,
  secretScanningAlert,
  supplyChainRecord,
  vulnerability,
} from "./fakes.js";

const LOCKFILE = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { name: "widgets" },
    "node_modules/lodash": { version: "4.17.20", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz" },
  },
});

describe("security routes and wiring", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length > 0) await apps.pop()!.close();
  });

  async function setup(deps: Partial<AppDeps> = {}) {
    const store = new SqliteRepoStore(":memory:");
    const cli = new FakeCli();
    const built = await buildApp({
      config: config(),
      store,
      provider: new FakeProvider(),
      sessions: new MemorySessionStore(),
      cli,
      exchangeCode: async () => "unused",
      ...deps,
    });
    apps.push(built.app);
    const id = store.addRepo("acme", "widgets", [], "main").id;
    return { ...built, store, cli, id };
  }

  describe("access", () => {
    it("answers 401 on both routes without a session", async () => {
      const { app, cli, id } = await setup();
      cli.error = new UnauthorisedError("run gh auth login");

      expect((await app.inject("/api/security")).statusCode).toBe(401);
      expect((await app.inject(`/api/repos/${id}/security`)).statusCode).toBe(401);
    });
  });

  describe("health", () => {
    const flags = async (deps: Partial<AppDeps>) => {
      const { app } = await setup(deps);
      const body = (await app.inject("/api/health")).json<{ osv: boolean; scorecard: boolean }>();
      return { osv: body.osv, scorecard: body.scorecard };
    };

    it("says both lookups are off by default", async () => {
      expect(await flags({})).toEqual({ osv: false, scorecard: false });
    });

    it("says each is on only when its switch is on and its adapter is wired", async () => {
      expect(await flags({ config: config({ osvLookup: true, scorecardLookup: true }) })).toEqual({
        osv: false,
        scorecard: false,
      });
      expect(
        await flags({
          config: config({ osvLookup: false }),
          vulnerabilities: new FakeVulnerabilityDatabase(),
          scorecard: new FakeScorecardSource(),
        }),
      ).toEqual({ osv: false, scorecard: false });
      expect(
        await flags({
          config: config({ osvLookup: true, scorecardLookup: true }),
          vulnerabilities: new FakeVulnerabilityDatabase(),
          scorecard: new FakeScorecardSource(),
        }),
      ).toEqual({ osv: true, scorecard: true });
    });
  });

  describe("the report", () => {
    it("works from stored data with nothing wired", async () => {
      const { app, store, id } = await setup();
      store.saveSecurityAlerts(id, "dependabot", [dependabotAlert({ key: "1" })], "replace");

      const res = await app.inject(`/api/repos/${id}/security?from=2026-01-01&to=2026-01-31`);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        repo: { id, owner: "acme", name: "widgets", deployBranch: "main" },
        range: { from: "2026-01-01", to: "2026-01-31" },
        used: { dependabot: false, code_scanning: false, secret_scanning: false, osv: false },
        lastGoodAt: { dependabot: null, code_scanning: null, secret_scanning: null, osv: null },
        supplyChain: { status: "none", reason: "not_read" },
        scorecard: { status: "off" },
        sources: { dependabot: { status: "not_read" } },
      });
    });

    it("answers 404 for an unknown repository and 400 for a bad id, date, range or extra parameter", async () => {
      const { app, id } = await setup();

      expect((await app.inject("/api/repos/999/security")).statusCode).toBe(404);
      expect((await app.inject("/api/repos/0/security")).statusCode).toBe(400);
      expect((await app.inject(`/api/repos/${id}/security?from=yesterday`)).statusCode).toBe(400);
      expect((await app.inject(`/api/repos/${id}/security?from=2026-02-30`)).statusCode).toBe(400);
      expect((await app.inject(`/api/repos/${id}/security?from=2026-03-01&to=2026-02-01`)).statusCode).toBe(400);
      expect((await app.inject(`/api/repos/${id}/security?from=2999-01-01`)).statusCode).toBe(400);
      expect((await app.inject(`/api/repos/${id}/security?people=1`)).statusCode).toBe(400);
    });

    it("never carries a secret value or a login, even for a secret alert and a pull request with people on it", async () => {
      const { app, store, id } = await setup();
      store.saveSecurityAlerts(id, "secret_scanning", [secretScanningAlert()], "replace");
      store.setSourceState(id, "secret_scanning", {
        status: "ok",
        readAt: "2026-09-29T09:00:00.000Z",
        attemptedAt: "2026-09-29T09:00:00.000Z",
        truncated: false,
        skipped: 0,
      });
      store.upsertPullRequests(id, [
        pr({
          number: 1,
          author: "alice-the-author",
          mergedBy: "mallory-the-merger",
          reviews: [{ author: "bob-the-reviewer", state: "APPROVED", submittedAt: "2026-09-01T11:00:00Z" }],
        }),
      ]);

      const report = (await app.inject(`/api/repos/${id}/security`)).body;
      const list = (await app.inject("/api/security")).body;

      for (const text of [report, list]) {
        expect(text).not.toMatch(/"secret"\s*:/);
        for (const login of ["alice-the-author", "mallory-the-merger", "bob-the-reviewer", "local-dev"]) {
          expect(text).not.toContain(login);
        }
      }
      // The seeded alert is really in the report, so the assertions above prove something.
      expect(JSON.parse(report)).toMatchObject({ open: { bySource: { secret_scanning: 1 } } });
    });
  });

  describe("stored rows that cannot be read", () => {
    it("keeps the failure to the one repository, so the list and the other report still answer", async () => {
      const { app, store, id } = await setup();
      const raw = (store as unknown as { db: DatabaseSync }).db;
      const bad = store.addRepo("acme", "gadgets", [], "main").id;
      for (const repoId of [id, bad]) {
        store.finishCrawl(repoId, null);
        store.saveSecurityAlerts(
          repoId,
          "dependabot",
          [dependabotAlert({ key: "1", severity: "critical", createdAt: "2020-01-01T00:00:00Z" }), dependabotAlert({ key: "2" })],
          "replace",
        );
        store.setSourceState(repoId, "dependabot", {
          status: "ok",
          readAt: "2026-09-29T09:00:00.000Z",
          attemptedAt: "2026-09-29T09:00:00.000Z",
          truncated: false,
          skipped: 0,
        });
        store.saveSupplyChain(repoId, supplyChainRecord(), []);
        store.savePosture(repoId, repoPosture({ visibility: "public" }), "2026-09-29T09:00:00.000Z");
        store.saveScorecard(repoId, "2026-09-29T09:00:00.000Z", scorecardResult());
      }
      // Valid JSON in another shape, and text that is not JSON, in every kind of row that one repository holds.
      raw.prepare("UPDATE security_alerts SET data = '{}' WHERE repo_id = ? AND key = '1'").run(bad);
      raw.prepare("UPDATE supply_chain SET facts = '{}' WHERE repo_id = ?").run(bad);
      raw.prepare("UPDATE security_posture SET data = '[]' WHERE repo_id = ?").run(bad);
      raw.prepare("UPDATE security_scorecard SET data = 'x' WHERE repo_id = ?").run(bad);

      const list = await app.inject("/api/security");
      const report = await app.inject(`/api/repos/${bad}/security`);
      const healthy = await app.inject(`/api/repos/${id}/security`);

      expect(list.statusCode).toBe(200);
      const rows = list.json<{ repo: { id: number }; open: { critical: number } }[]>();
      expect(rows.map((r) => r.repo.id).sort()).toEqual([id, bad].sort());
      // The healthy repository still counts its critical alert; the other lost the one that could not be read.
      expect(rows.find((r) => r.repo.id === id)!.open.critical).toBe(1);
      expect(rows.find((r) => r.repo.id === bad)!.open.critical).toBe(0);
      expect(report.statusCode).toBe(200);
      expect(report.json()).toMatchObject({ supplyChain: { status: "none", reason: "not_read" }, posture: null });
      expect(healthy.statusCode).toBe(200);
      expect(healthy.json()).toMatchObject({ open: { bySeverity: { critical: 1 } }, supplyChain: { status: "ok" } });
    });
  });

  describe("the list", () => {
    it("answers one summary per repository, worst first", async () => {
      const { app, store, id } = await setup();
      const second = store.addRepo("acme", "gadgets", [], "main").id;
      for (const repoId of [id, second]) {
        store.finishCrawl(repoId, null);
        store.setSourceState(repoId, "dependabot", {
          status: "ok",
          readAt: "2026-09-29T09:00:00.000Z",
          attemptedAt: "2026-09-29T09:00:00.000Z",
          truncated: false,
          skipped: 0,
        });
      }
      store.saveSecurityAlerts(
        second,
        "dependabot",
        [dependabotAlert({ severity: "critical", createdAt: "2020-01-01T00:00:00Z" })],
        "replace",
      );

      const rows = (await app.inject("/api/security")).json<{ repo: { id: number }; band: string | null }[]>();

      expect(rows.map((r) => r.repo.id)).toEqual([second, id]);
      expect(rows[0]).toMatchObject({ band: "low", pastFix: 1, sources: { dependabot: "ok" }, failed: false });
    });

    it("answers every repository when one has a pull request row that cannot be read, rather than failing the list", async () => {
      const { app, store, id } = await setup();
      const second = store.addRepo("acme", "gadgets", [], "main").id;
      for (const repoId of [id, second]) store.finishCrawl(repoId, null);
      (store as unknown as { db: DatabaseSync }).db
        .prepare("INSERT INTO pull_requests (repo_id, number, updated_at, data) VALUES (?, 1, 't', ?)")
        .run(second, "{not json");

      const response = await app.inject("/api/security");

      expect(response.statusCode).toBe(200);
      expect(
        response
          .json<{ repo: { id: number } }[]>()
          .map((r) => r.repo.id)
          .sort(),
      ).toEqual([id, second].sort());
    });

    it("limits to the ids asked for, and refuses a bad list, an unknown id or an extra parameter", async () => {
      const { app, store, id } = await setup();
      store.addRepo("acme", "gadgets", [], "main");

      expect((await app.inject(`/api/security?ids=${id}`)).json<unknown[]>()).toHaveLength(1);
      expect((await app.inject("/api/security?ids=999")).statusCode).toBe(404);
      for (const query of ["ids=", "ids=abc", "ids=1;2", `ids=${Array(51).fill(1).join(",")}`, "refresh=1"]) {
        expect((await app.inject(`/api/security?${query}`)).statusCode).toBe(400);
      }
    });

    it("refuses an id of more than nine digits as a bad request, not an unknown repository", async () => {
      const { app } = await setup();

      for (const ids of ["1234567890", "9".repeat(400), `1,${"9".repeat(40)}`]) {
        expect((await app.inject(`/api/security?ids=${ids}`)).statusCode).toBe(400);
      }
      // Nine digits is a well formed id for a repository that is not there.
      expect((await app.inject("/api/security?ids=999999999")).statusCode).toBe(404);
    });
  });

  describe("a crawl through the app", () => {
    async function wired(overrides: Partial<AppDeps> = {}) {
      const order: string[] = [];
      const source = new FakeSecurityAlertSource();
      const checkout = new FakeSourceCheckout();
      const analyser = new FakeCodeAnalyser();
      const reader = new FakeWorkspaceReader();
      const coverage = new FakeCoverageSource();
      const scorecard = new FakeScorecardSource();
      const osv = new FakeVulnerabilityDatabase();
      reader.files.set("package-lock.json", LOCKFILE);
      reader.files.set(".github/workflows/ci.yml", "on: push\njobs: {}\n");
      const analyse = analyser.analyse.bind(analyser);
      analyser.analyse = async (dir) => (order.push("code"), analyse(dir));
      const posture = source.posture.bind(source);
      source.posture = async (...args) => (order.push("posture"), posture(...args));
      const find = coverage.findArtefacts.bind(coverage);
      coverage.findArtefacts = async (...args) => (order.push("coverage"), find(...args));
      const asked = scorecard.scorecard.bind(scorecard);
      scorecard.scorecard = async (...args) => (order.push("scorecard"), asked(...args));
      const provider = new FakeProvider();
      provider.seed("acme/widgets", { prs: [pr({ number: 1 })], workflows: [] });
      const ctx = await setup({
        provider,
        checkout,
        analyser,
        reader,
        coverage,
        securityAlerts: source,
        vulnerabilities: osv,
        scorecard,
        ...overrides,
      });
      return { ...ctx, order, source, checkout, scorecard, osv, reader };
    }

    it("reads the code, then the posture, then the Scorecard, then coverage", async () => {
      const { crawler, id, order, source, scorecard } = await wired({ config: config({ scorecardLookup: true }) });
      source.postureIs = repoPosture({ visibility: "public" });
      scorecard.set("acme/widgets", scorecardResult());

      await crawler.crawl("tok", id);

      expect(order).toEqual(["code", "posture", "scorecard", "coverage"]);
    });

    it("stores the alerts and shows them in the report, with the supply chain read from the same clone", async () => {
      const { app, crawler, id, source, checkout } = await wired();
      source.seed("dependabot", [dependabotAlert({ key: "7", severity: "high" })]);

      await crawler.crawl("tok", id);
      const report = (await app.inject(`/api/repos/${id}/security`)).json<{
        openAlertTotal: number;
        sources: { dependabot: { status: string } };
        supplyChain: { status: string; workflowsRead: number };
        posture: unknown;
      }>();

      expect(report.sources.dependabot.status).toBe("ok");
      expect(report.openAlertTotal).toBe(1);
      expect(report.supplyChain).toMatchObject({ status: "ok", workflowsRead: 1 });
      expect(report.posture).not.toBeNull();
      expect(checkout.requests).toHaveLength(1);
    });

    it("says in the report that the supply chain could not be read, when the clone cannot be listed", async () => {
      const { app, crawler, id, reader } = await wired();
      reader.listFailWith = new Error("too deep: /srv/secret-path");

      await crawler.crawl("tok", id);
      const report = (await app.inject(`/api/repos/${id}/security`)).json<{
        supplyChainFailure: { message: string; attemptedAt: string } | null;
        supplyChain: { status: string };
      }>();

      expect(report.supplyChain.status).toBe("none");
      expect(report.supplyChainFailure?.message).toMatch(/could not be listed/);
      expect(JSON.stringify(report)).not.toContain("secret-path");
    });

    it("does not clone again for the supply chain on the next crawl while the head has not moved", async () => {
      const { crawler, id, checkout } = await wired();

      await crawler.crawl("tok", id);
      await crawler.crawl("tok", id);

      expect(checkout.requests).toHaveLength(1);
    });

    it("reads no supply chain, and says code analysis is off, when analysis is off", async () => {
      const { app, crawler, id, store, source, checkout } = await wired({ config: config({ codeAnalysis: false }) });

      await crawler.crawl("tok", id);

      expect(checkout.requests).toHaveLength(0);
      expect(store.supplyChain(id)).toBeNull();
      expect(source.count("dependabot")).toBe(1);
      expect((await app.inject(`/api/repos/${id}/security`)).json()).toMatchObject({
        supplyChain: { status: "none", reason: "analysis_off" },
      });
    });

    it("reads no security when no alert source is wired", async () => {
      const { crawler, id, store } = await wired({ securityAlerts: undefined });

      await crawler.crawl("tok", id);

      expect(store.sourceStates(id).dependabot.status).toBe("not_read");
      expect(store.posture(id)).toBeNull();
    });

    it("looks packages up in OSV only when the switch is on and Dependabot cannot be used", async () => {
      const off = await wired();
      off.source.set("dependabot", { status: "off", reason: "disabled" });
      off.osv.know(lockedPackage(), [vulnerability()]);
      await off.crawler.crawl("tok", off.id);
      expect(off.osv.asked).toEqual([]);
      expect(off.store.sourceStates(off.id).osv).toMatchObject({ status: "not_used", reason: "lookup_off" });

      const on = await wired({ config: config({ osvLookup: true }) });
      on.source.set("dependabot", { status: "off", reason: "disabled" });
      on.osv.know(lockedPackage(), [vulnerability()]);
      await on.crawler.crawl("tok", on.id);
      expect(on.osv.asked).toEqual([[lockedPackage()]]);
      expect((await on.app.inject(`/api/repos/${on.id}/security`)).json()).toMatchObject({
        openAlertTotal: 1,
        open: { bySource: { osv: 1 } },
      });
    });

    it("hands the configured private scopes to the lookup", async () => {
      const ctx = await wired({ config: config({ osvLookup: true, osvPrivateNpmScopes: ["@corp"] }) });
      ctx.source.set("dependabot", { status: "off", reason: "disabled" });
      ctx.reader.files.set(
        "package-lock.json",
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/lodash": { version: "4.17.20", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz" },
            "node_modules/@corp/ui": { version: "1.0.0", resolved: "https://registry.npmjs.org/@corp/ui/-/ui-1.0.0.tgz" },
          },
        }),
      );

      await ctx.crawler.crawl("tok", ctx.id);

      expect(ctx.osv.asked[0]!.map((p) => p.name)).toEqual(["lodash"]);
    });

    it("fails the crawl on a rejected credential and leaves the security state as it was", async () => {
      const { crawler, id, store, source } = await wired();
      await crawler.crawl("tok", id);
      const before = store.sourceStates(id);
      source.postureFailWith = new UnauthorisedError("sign in again");

      await expect(crawler.crawl("tok", id, true)).rejects.toBeInstanceOf(UnauthorisedError);

      expect(store.getRepo(id)).toMatchObject({ crawlStatus: "failed" });
      expect(store.sourceStates(id)).toEqual(before);
    });

    it("never asks a Scorecard adapter that is wired but switched off, even for a public repository", async () => {
      const { crawler, id, order, source, scorecard, store } = await wired({ config: config({ scorecardLookup: false }) });
      source.postureIs = repoPosture({ visibility: "public" });
      scorecard.set("acme/widgets", scorecardResult());

      await crawler.crawl("tok", id, true);

      expect(scorecard.asked).toEqual([]);
      expect(order).not.toContain("scorecard");
      expect(store.scorecard(id)).toBeNull();
    });

    it("names no settings page when no alert source is wired", async () => {
      const { app, id } = await wired({ securityAlerts: undefined });
      expect((await app.inject(`/api/repos/${id}/security`)).json()).toMatchObject({ settingsUrl: "" });
    });

    it("uses the alert source's settings page in the report", async () => {
      const { app, id } = await wired();
      expect((await app.inject(`/api/repos/${id}/security`)).json()).toMatchObject({
        settingsUrl: "https://example.test/acme/widgets/settings/security_analysis",
      });
    });
  });
});
