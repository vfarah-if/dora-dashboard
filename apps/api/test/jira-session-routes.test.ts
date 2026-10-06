import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loggedUrl, buildApp } from "../src/app.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { MemoryTrackerGrantStore } from "../src/infrastructure/auth/memory-tracker-grant-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import type { WorkItemCrawlService } from "../src/services/work-item-crawl-service.js";
import {
  config,
  FakeCli,
  FakeProvider,
  FakeTrackerAuthorisation,
  FakeWorkItemProvider,
  grant,
  settled,
  SITE,
  workItem,
} from "./fakes.js";

const OTHER_SITE = { id: "cloud-2", url: "https://other.example.test", name: "Other" };

describe("Jira with sign-out, crawl conflicts and several sites", () => {
  let app: FastifyInstance;
  let workItemCrawler: WorkItemCrawlService;
  let store: SqliteRepoStore;
  let sessions: MemorySessionStore;
  let grants: MemoryTrackerGrantStore;
  let tracker: FakeWorkItemProvider;
  let repoId: number;
  const logLines: string[] = [];

  beforeEach(async () => {
    logLines.length = 0;
    store = new SqliteRepoStore(":memory:");
    sessions = new MemorySessionStore();
    grants = new MemoryTrackerGrantStore();
    tracker = new FakeWorkItemProvider();
    tracker.seedSite(SITE);
    tracker.seedSite(OTHER_SITE);
    tracker.seedSpace(SITE.id, "WID", { name: "Widgets", items: [workItem({ key: "WID-1" })] });
    tracker.seedSpace(SITE.id, "GAD", { name: "Gadgets" });
    tracker.seedSpace(OTHER_SITE.id, "OPS", { name: "Operations" });
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        logLines.push(chunk.toString());
        done();
      },
    });
    ({ app, workItemCrawler } = (await buildApp({
      config: config(),
      store,
      provider: new FakeProvider(),
      sessions,
      cli: new FakeCli(),
      exchangeCode: async () => "unused",
      jira: { provider: tracker, auth: new FakeTrackerAuthorisation(), grants },
      logger: { stream },
    })) as { app: FastifyInstance; workItemCrawler: WorkItemCrawlService });
    repoId = store.addRepo("acme", "widgets", [], "main").id;
    grants.set("local-dev", grant());
  });

  afterEach(() => app.close());

  const link = (siteId: string, keys: string[]) =>
    app.inject({ method: "PUT", url: `/api/repos/${repoId}/spaces`, payload: { siteId, keys } });

  describe("signing out", () => {
    const signIn = (login: string) =>
      app.signCookie(sessions.create({ token: "gh-token", login, avatarUrl: "https://example.test/a.png" }));

    it("drops the person's Jira grant along with their session", async () => {
      grants.set("alice", grant());
      grants.set("bob", grant());

      const res = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: { dora_sid: signIn("alice") } });

      expect(res.statusCode).toBe(200);
      expect(grants.get("alice")).toBeNull();
      expect(grants.get("bob")).not.toBeNull();
    });

    it("signs out without a session, leaving every grant alone", async () => {
      const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
      expect(res.statusCode).toBe(200);
      expect(grants.get("local-dev")).not.toBeNull();
    });

    it("still signs out when Jira is not wired", async () => {
      const bareSessions = new MemorySessionStore();
      const { app: bare } = await buildApp({
        config: config({ jiraEnabled: false }),
        store: new SqliteRepoStore(":memory:"),
        provider: new FakeProvider(),
        sessions: bareSessions,
        cli: new FakeCli(),
        exchangeCode: async () => "unused",
      });
      const id = bareSessions.create({ token: "t", login: "alice", avatarUrl: "https://example.test/a.png" });

      const res = await bare.inject({ method: "POST", url: "/api/auth/logout", cookies: { dora_sid: bare.signCookie(id) } });

      expect(res.statusCode).toBe(200);
      expect(bareSessions.get(id)).toBeNull();
      await bare.close();
    });
  });

  describe("crawling a space already being crawled", () => {
    it("answers 409 with the reason", async () => {
      const [space] = (await link(SITE.id, ["WID"])).json<{ id: number }[]>();
      await settled(() => workItemCrawler.isCrawling());
      const running = workItemCrawler.crawl("local-dev", space!.id, true);

      const res = await app.inject({ method: "POST", url: `/api/spaces/${space!.id}/crawl` });
      await running;

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "A crawl of this space is already running" });
    });

    it("answers 202 once the earlier crawl has finished", async () => {
      const [space] = (await link(SITE.id, ["WID"])).json<{ id: number }[]>();
      await settled(() => workItemCrawler.isCrawling());
      expect((await app.inject({ method: "POST", url: `/api/spaces/${space!.id}/crawl` })).statusCode).toBe(202);
      await settled(() => workItemCrawler.isCrawling());
    });
  });

  describe("linking spaces on more than one site", () => {
    const names = (res: { json: <T>() => T }) => res.json<{ siteId: string; key: string }[]>().map((s) => `${s.siteId}/${s.key}`);

    it("replaces only the links on the site given and answers with every linked space", async () => {
      await link(SITE.id, ["WID", "GAD"]);
      const res = await link(OTHER_SITE.id, ["OPS"]);

      expect(res.statusCode).toBe(202);
      expect(names(res)).toEqual(["cloud-1/GAD", "cloud-1/WID", "cloud-2/OPS"]);

      const narrowed = await link(SITE.id, ["WID"]);
      expect(names(narrowed)).toEqual(["cloud-1/WID", "cloud-2/OPS"]);
      await settled(() => workItemCrawler.isCrawling());
    });

    it("unlinks only the given site's spaces when keys are empty", async () => {
      await link(SITE.id, ["WID"]);
      await link(OTHER_SITE.id, ["OPS"]);

      const res = await link(SITE.id, []);

      expect(res.statusCode).toBe(202);
      expect(names(res)).toEqual(["cloud-2/OPS"]);
      expect(store.spacesFor(repoId).map((s) => s.key)).toEqual(["OPS"]);
      await settled(() => workItemCrawler.isCrawling());
    });
  });

  describe("request logs", () => {
    it("keep no query string for the Jira callback, so its code and state are never logged", async () => {
      await app.inject("/api/auth/jira/callback?code=secret-code&state=secret-state");

      const logged = logLines.join("");
      expect(logged).toContain("/api/auth/jira/callback");
      expect(logged).not.toContain("secret-code");
      expect(logged).not.toContain("secret-state");
    });

    it("keep other URLs as they were", () => {
      expect(loggedUrl("/api/repos?x=1")).toBe("/api/repos?x=1");
      expect(loggedUrl("/api/auth/jira/callback?code=c")).toBe("/api/auth/jira/callback");
    });
  });
});
