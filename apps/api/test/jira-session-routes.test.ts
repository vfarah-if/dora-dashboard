import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loggedUrl, buildApp } from "../src/app.js";
import { UnauthorisedError } from "../src/core/errors.js";
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
  let authorisation: FakeTrackerAuthorisation;
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
    authorisation = new FakeTrackerAuthorisation();
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
      jira: { provider: tracker, auth: authorisation, grants },
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
        config: config({ jira: null }),
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

    it("keep no query string for the GitHub callback either", async () => {
      // The route exists only in OAuth mode, so this needs an app of its own.
      const lines: string[] = [];
      const stream = new Writable({
        write(chunk: Buffer, _enc, done) {
          lines.push(chunk.toString());
          done();
        },
      });
      const oauth = (
        await buildApp({
          config: config({ authMode: "oauth", jira: null }),
          store: new SqliteRepoStore(":memory:"),
          provider: new FakeProvider(),
          sessions: new MemorySessionStore(),
          cli: new FakeCli(),
          exchangeCode: async () => "unused",
          logger: { stream },
        })
      ).app;
      await oauth.inject("/api/auth/github/callback?code=gh-secret-code&state=gh-secret-state");
      await oauth.close();

      const logged = lines.join("");
      expect(logged).toContain("/api/auth/github/callback");
      expect(logged).not.toContain("gh-secret-code");
      expect(logged).not.toContain("gh-secret-state");
    });

    it("keep other URLs as they were", () => {
      expect(loggedUrl("/api/repos?x=1")).toBe("/api/repos?x=1");
      expect(loggedUrl("/api/auth/jira/callback?code=c")).toBe("/api/auth/jira/callback");
      expect(loggedUrl("/api/auth/github/callback?code=c&state=s")).toBe("/api/auth/github/callback");
    });
  });

  describe("callback failures are logged with a reason and no secrets", () => {
    const warnings = () =>
      logLines
        .join("")
        .split("\n")
        .filter((line) => line.includes("jira connection failed"))
        .map((line) => JSON.parse(line) as { level: number; reason: string; providerError?: string });

    it.each([
      ["error=access_denied&state=s-secret", "provider_error"],
      ["state=s-secret", "missing_code"],
      ["code=c-secret", "state_missing"],
      ["code=c-secret&state=s-secret", "state_missing"],
    ])("for ?%s as %s", async (query, reason) => {
      await app.inject(`/api/auth/jira/callback?${query}`);

      const [entry] = warnings();
      expect(entry).toMatchObject({ level: 40, reason });
      expect(logLines.join("")).not.toMatch(/c-secret|s-secret/);
    });

    it("names Atlassian's error code for a provider error", async () => {
      await app.inject("/api/auth/jira/callback?error=access_denied");
      expect(warnings()[0]).toMatchObject({ reason: "provider_error", providerError: "access_denied" });
    });

    it("says state_mismatch when the state differs from the cookie", async () => {
      const start = await app.inject("/api/auth/jira/start");
      const cookie = ([] as string[])
        .concat(start.headers["set-cookie"] as string[])
        .find((c) => c.startsWith("dora_jira_state="))!
        .split(";")[0]!;
      await app.inject({ method: "GET", url: "/api/auth/jira/callback?code=c-secret&state=forged-secret", headers: { cookie } });

      expect(warnings()[0]).toMatchObject({ reason: "state_mismatch" });
      expect(logLines.join("")).not.toMatch(/c-secret|forged-secret/);
    });

    it("says exchange_failed when the code exchange is refused", async () => {
      authorisation.exchangeFailWith = new UnauthorisedError("code refused");
      const start = await app.inject("/api/auth/jira/start");
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      const cookie = ([] as string[])
        .concat(start.headers["set-cookie"] as string[])
        .find((c) => c.startsWith("dora_jira_state="))!
        .split(";")[0]!;
      await app.inject({ method: "GET", url: `/api/auth/jira/callback?code=c-secret&state=${state}`, headers: { cookie } });

      expect(warnings()[0]).toMatchObject({ reason: "exchange_failed" });
      expect(logLines.join("")).not.toMatch(/c-secret/);
      expect(logLines.join("")).not.toContain(state);
    });
  });
});
