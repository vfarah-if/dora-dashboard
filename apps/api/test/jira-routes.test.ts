import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
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

const WEB = "http://localhost:5181";

/** The `name=value` pair of a response cookie as the browser would send it back. */
function cookieHeader(res: LightMyRequestResponse, ...names: string[]): string {
  const set = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  return names.map((name) => set.find((c) => c.startsWith(`${name}=`))!.split(";")[0]!).join("; ");
}

describe("Jira routes", () => {
  let app: FastifyInstance;
  let workItemCrawler: WorkItemCrawlService;
  let store: SqliteRepoStore;
  let tracker: FakeWorkItemProvider;
  let authorisation: FakeTrackerAuthorisation;
  let grants: MemoryTrackerGrantStore;
  let cli: FakeCli;
  let repoId: number;

  beforeEach(async () => {
    store = new SqliteRepoStore(":memory:");
    tracker = new FakeWorkItemProvider();
    tracker.seedSite(SITE);
    tracker.seedSpace(SITE.id, "WID", {
      name: "Widgets",
      statuses: [{ id: "1", name: "To Do", category: "todo" }],
      columns: [{ name: "Backlog", statusIds: ["1"] }],
      items: [workItem({ key: "WID-1" }), workItem({ key: "WID-2", updatedAt: "2026-09-02T12:00:00Z" })],
    });
    tracker.seedSpace(SITE.id, "GAD", { name: "Gadgets" });
    authorisation = new FakeTrackerAuthorisation();
    grants = new MemoryTrackerGrantStore();
    cli = new FakeCli();
    const provider = new FakeProvider();
    ({ app, workItemCrawler } = (await buildApp({
      config: config(),
      store,
      provider,
      sessions: new MemorySessionStore(),
      cli,
      exchangeCode: async () => "unused",
      jira: { provider: tracker, auth: authorisation, grants },
    })) as { app: FastifyInstance; workItemCrawler: WorkItemCrawlService });
    repoId = store.addRepo("acme", "widgets", [], "main").id;
  });

  afterEach(() => app.close());

  const connect = () => grants.set("local-dev", grant({ accessToken: "access-1" }));

  describe("when Jira is not configured", () => {
    let bare: FastifyInstance;
    beforeEach(async () => {
      ({ app: bare } = await buildApp({
        config: config({ jiraEnabled: false }),
        store: new SqliteRepoStore(":memory:"),
        provider: new FakeProvider(),
        sessions: new MemorySessionStore(),
        cli: new FakeCli(),
        exchangeCode: async () => "unused",
      }));
    });
    afterEach(() => bare.close());

    it.each([
      ["GET", "/api/jira"],
      ["DELETE", "/api/jira"],
      ["GET", "/api/auth/jira/start"],
      ["GET", "/api/auth/jira/callback"],
      ["GET", "/api/jira/sites/cloud-1/spaces"],
      ["GET", "/api/jira/sites/cloud-1/spaces/WID"],
      ["GET", "/api/repos/1/spaces"],
      ["PUT", "/api/repos/1/spaces"],
      ["POST", "/api/spaces/1/crawl"],
    ])("answers 404 to %s %s", async (method, url) => {
      expect((await bare.inject({ method: method as "GET", url })).statusCode).toBe(404);
    });

    it("reports on the health route that Jira is off", async () => {
      expect((await bare.inject("/api/health")).json()).toMatchObject({ jira: false });
    });
  });

  it("reports on the health route that Jira is on", async () => {
    expect((await app.inject("/api/health")).json()).toMatchObject({ ok: true, jira: true });
  });

  it("answers 401 to every Jira route without a GitHub sign-in", async () => {
    cli.error = new UnauthorisedError("run gh auth login");
    for (const [method, url] of [
      ["GET", "/api/jira"],
      ["DELETE", "/api/jira"],
      ["GET", "/api/auth/jira/start"],
      ["GET", "/api/auth/jira/callback?code=c&state=s"],
      ["GET", "/api/jira/sites/cloud-1/spaces"],
      ["GET", `/api/repos/${repoId}/spaces`],
      ["PUT", `/api/repos/${repoId}/spaces`],
      ["POST", "/api/spaces/1/crawl"],
    ] as const) {
      const payload = method === "PUT" ? { siteId: SITE.id, keys: ["WID"] } : undefined;
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json()).toEqual({ error: "run gh auth login" });
    }
  });

  describe("connecting", () => {
    it("redirects to the consent page with a fresh state, held in a signed http-only cookie", async () => {
      const res = await app.inject("/api/auth/jira/start");

      expect(res.statusCode).toBe(302);
      const state = new URL(res.headers.location as string).searchParams.get("state")!;
      expect(res.headers.location).toBe(`https://auth.example.test/authorize?state=${state}`);
      expect(state).toMatch(/^[0-9a-f]{32}$/);
      const set = ([] as string[]).concat(res.headers["set-cookie"] as string[]);
      const stateCookie = set.find((c) => c.startsWith("dora_jira_state="))!;
      expect(stateCookie).toContain("HttpOnly");
      expect(stateCookie).toContain("Max-Age=600");
      expect(stateCookie).toContain("SameSite=Lax");
      // Signed: the value is not the bare state.
      expect(decodeURIComponent(stateCookie.split(";")[0]!.split("=")[1]!)).not.toBe(state);
    });

    it("uses a different state each time", async () => {
      const states = await Promise.all(
        [1, 2].map(async () =>
          new URL((await app.inject("/api/auth/jira/start")).headers.location as string).searchParams.get("state"),
        ),
      );
      expect(states[0]).not.toBe(states[1]);
    });

    it.each([
      "https://evil.example.test/x",
      "//evil.example.test",
      "/\\evil.example.test",
      "repos",
      "/a b",
      "javascript:alert(1)",
    ])("rejects the return path %s", async (returnTo) => {
      const res = await app.inject({ method: "GET", url: "/api/auth/jira/start", query: { returnTo } });
      expect(res.statusCode).toBe(400);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    async function callbackAfterStart(returnTo: string | null, query: (state: string) => Record<string, string>) {
      const start = await app.inject({
        method: "GET",
        url: "/api/auth/jira/start",
        ...(returnTo ? { query: { returnTo } } : {}),
      });
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      const names = returnTo ? ["dora_jira_state", "dora_jira_return"] : ["dora_jira_state"];
      return app.inject({
        method: "GET",
        url: "/api/auth/jira/callback",
        query: query(state),
        headers: { cookie: cookieHeader(start, ...names) },
      });
    }

    it("connects on a matching state and sends the person back to the repository page they came from", async () => {
      const res = await callbackAfterStart("/repos/1?tab=jira", (state) => ({ code: "the-code", state }));

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${WEB}/repos/1?tab=jira`);
      expect(authorisation.codes).toEqual(["the-code"]);
      expect(grants.get("local-dev")).not.toBeNull();
      // Both short-lived cookies are cleared.
      const set = ([] as string[]).concat(res.headers["set-cookie"] as string[]).join("\n");
      expect(set).toMatch(/dora_jira_state=;/);
      expect(set).toMatch(/dora_jira_return=;/);
    });

    it("sends the person to the repository list when no return path was given", async () => {
      const res = await callbackAfterStart(null, (state) => ({ code: "c", state }));
      expect(res.headers.location).toBe(`${WEB}/repos`);
    });

    it("redirects with jira=error, connecting nothing, when the state does not match", async () => {
      const res = await callbackAfterStart("/repos/1", () => ({ code: "c", state: "forged" }));

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${WEB}/repos/1?jira=error`);
      expect(authorisation.codes).toEqual([]);
      expect(grants.get("local-dev")).toBeNull();
    });

    it("redirects with jira=error when there is no state cookie at all", async () => {
      const res = await app.inject("/api/auth/jira/callback?code=c&state=anything");
      expect(res.headers.location).toBe(`${WEB}/repos?jira=error`);
      expect(authorisation.codes).toEqual([]);
    });

    it("redirects with jira=error when the state cookie is not one the server signed", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/jira/callback?code=c&state=abc",
        headers: { cookie: "dora_jira_state=abc.forgedsignature" },
      });
      expect(res.headers.location).toBe(`${WEB}/repos?jira=error`);
    });

    it("redirects with jira=error when the person declined at Atlassian", async () => {
      const res = await callbackAfterStart("/repos/1", (state) => ({ error: "access_denied", state }));
      expect(res.headers.location).toBe(`${WEB}/repos/1?jira=error`);
      expect(authorisation.codes).toEqual([]);
    });

    it("redirects with jira=error when no code came back", async () => {
      const res = await callbackAfterStart(null, (state) => ({ state }));
      expect(res.headers.location).toBe(`${WEB}/repos?jira=error`);
    });

    it("redirects with jira=error when the code exchange fails, and stores no grant", async () => {
      authorisation.exchangeFailWith = new UnauthorisedError("code refused");
      const res = await callbackAfterStart(null, (state) => ({ code: "stale", state }));
      expect(res.headers.location).toBe(`${WEB}/repos?jira=error`);
      expect(grants.get("local-dev")).toBeNull();
    });

    it("appends jira=error with & when the return path already has a query", async () => {
      const res = await callbackAfterStart("/repos/1?tab=jira", () => ({ error: "access_denied" }));
      expect(res.headers.location).toBe(`${WEB}/repos/1?tab=jira&jira=error`);
    });

    it("rejects a state cookie reused once it has been cleared by an earlier callback", async () => {
      const start = await app.inject("/api/auth/jira/start");
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      const headers = { cookie: cookieHeader(start, "dora_jira_state") };
      const first = await app.inject({ method: "GET", url: "/api/auth/jira/callback", query: { code: "c", state }, headers });
      expect(first.headers.location).toBe(`${WEB}/repos`);
      // The browser honours the clearing cookie, so a replay carries none.
      const replay = await app.inject({ method: "GET", url: "/api/auth/jira/callback", query: { code: "c", state } });
      expect(replay.headers.location).toBe(`${WEB}/repos?jira=error`);
    });
  });

  describe("connection status", () => {
    it("reports not connected, with no sites, before consent", async () => {
      const res = await app.inject("/api/jira");
      expect(res.json()).toEqual({ enabled: true, connected: false, sites: [] });
      expect(tracker.calls).toEqual([]);
    });

    it("reports connected with the sites the account reaches", async () => {
      connect();
      expect((await app.inject("/api/jira")).json()).toEqual({ enabled: true, connected: true, sites: [SITE] });
    });

    it("reports not connected when the grant can no longer be refreshed", async () => {
      grants.set("local-dev", grant({ expiresAt: 0 }));
      authorisation.refreshFailWith = new UnauthorisedError("refused");
      expect((await app.inject("/api/jira")).json()).toEqual({ enabled: true, connected: false, sites: [] });
    });

    it("passes other failures on rather than hide them as not connected", async () => {
      connect();
      tracker.failWith = new Error("boom");
      expect((await app.inject("/api/jira")).statusCode).toBe(500);
    });

    it("never returns a token", async () => {
      connect();
      const text = (await app.inject("/api/jira")).body;
      expect(text).not.toContain("access-1");
      expect(text).not.toContain("refresh-1");
    });

    it("disconnects, with no body, and forgets the grant", async () => {
      connect();
      const res = await app.inject({ method: "DELETE", url: "/api/jira" });
      expect(res.statusCode).toBe(204);
      expect(grants.get("local-dev")).toBeNull();
    });

    it("refuses a disconnect from another origin and keeps the grant", async () => {
      connect();
      const res = await app.inject({ method: "DELETE", url: "/api/jira", headers: { origin: "http://evil.example.test" } });
      expect(res.statusCode).toBe(403);
      expect(grants.get("local-dev")).not.toBeNull();
    });

    it("accepts a disconnect from the dashboard's own origin", async () => {
      connect();
      const res = await app.inject({ method: "DELETE", url: "/api/jira", headers: { origin: WEB } });
      expect(res.statusCode).toBe(204);
    });
  });

  describe("spaces", () => {
    it("lists the spaces on a site", async () => {
      connect();
      const res = await app.inject(`/api/jira/sites/${SITE.id}/spaces`);
      expect(res.json()).toEqual([
        { key: "WID", name: "Widgets", type: "software" },
        { key: "GAD", name: "Gadgets", type: "software" },
      ]);
    });

    it("describes one space with its statuses and board columns", async () => {
      connect();
      const res = await app.inject(`/api/jira/sites/${SITE.id}/spaces/WID`);
      expect(res.json()).toEqual({
        statuses: [{ id: "1", name: "To Do", category: "todo" }],
        columns: [{ name: "Backlog", statusIds: ["1"] }],
      });
    });

    it("answers 404 for a site or space the account cannot see", async () => {
      connect();
      expect((await app.inject("/api/jira/sites/cloud-9/spaces")).statusCode).toBe(404);
      expect((await app.inject(`/api/jira/sites/${SITE.id}/spaces/NOPE`)).statusCode).toBe(404);
    });

    it("answers 400 to a malformed site id or space key", async () => {
      connect();
      expect((await app.inject("/api/jira/sites/not%20valid/spaces")).statusCode).toBe(400);
      expect((await app.inject(`/api/jira/sites/${SITE.id}/spaces/lower`)).statusCode).toBe(400);
    });

    it("answers 401 with a body the web can recognise when Jira is not connected", async () => {
      const res = await app.inject(`/api/jira/sites/${SITE.id}/spaces`);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "jira_unauthorised", message: "Jira is not connected. Connect Jira first" });
    });

    it("answers 401 with the same body when Atlassian rejects the token", async () => {
      connect();
      tracker.failWith = new UnauthorisedError("Atlassian said 401");
      const res = await app.inject(`/api/jira/sites/${SITE.id}/spaces/WID`);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "jira_unauthorised" });
    });

    it("keeps the GitHub sign-in error shape for a GitHub 401", async () => {
      cli.error = new UnauthorisedError("run gh auth login");
      expect((await app.inject(`/api/jira/sites/${SITE.id}/spaces`)).json()).toEqual({ error: "run gh auth login" });
    });
  });

  describe("linking spaces to a repository", () => {
    const link = (payload: unknown, id = repoId) =>
      app.inject({ method: "PUT", url: `/api/repos/${id}/spaces`, payload: payload as object });

    it("links the spaces, answers 202 and crawls them in the background", async () => {
      connect();
      const res = await link({ siteId: SITE.id, keys: ["WID", "GAD"] });

      expect(res.statusCode).toBe(202);
      expect(res.json<{ key: string }[]>().map((s) => s.key)).toEqual(["GAD", "WID"]);
      await settled(() => workItemCrawler.isCrawling());

      const listed = (await app.inject(`/api/repos/${repoId}/spaces`)).json<
        { key: string; workItemCount: number; crawlStatus: string; statuses: unknown[]; siteUrl: string }[]
      >();
      expect(listed.map((s) => [s.key, s.workItemCount, s.crawlStatus])).toEqual([
        ["GAD", 0, "idle"],
        ["WID", 2, "idle"],
      ]);
      expect(listed[1]!.statuses).toHaveLength(1);
      expect(listed[1]!.siteUrl).toBe("https://acme.example.test");
    });

    it("lists nothing for a repository with no spaces, and 404s for an unknown repository", async () => {
      expect((await app.inject(`/api/repos/${repoId}/spaces`)).json()).toEqual([]);
      expect((await app.inject("/api/repos/999/spaces")).statusCode).toBe(404);
      connect();
      expect((await link({ siteId: SITE.id, keys: ["WID"] }, 999)).statusCode).toBe(404);
    });

    it("answers 404 and links nothing when a key does not exist on the site", async () => {
      connect();
      const res = await link({ siteId: SITE.id, keys: ["WID", "NOPE"] });
      expect(res.statusCode).toBe(404);
      expect(store.spacesFor(repoId)).toEqual([]);
    });

    it("answers 401 with the Jira shape when Jira is not connected", async () => {
      const res = await link({ siteId: SITE.id, keys: ["WID"] });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "jira_unauthorised" });
    });

    it("unlinks every space when given no keys", async () => {
      connect();
      await link({ siteId: SITE.id, keys: ["WID"] });
      await settled(() => workItemCrawler.isCrawling());
      const res = await link({ siteId: SITE.id, keys: [] });
      expect(res.statusCode).toBe(202);
      expect(store.spacesFor(repoId)).toEqual([]);
    });

    it.each([
      ["a missing site id", { keys: ["WID"] }],
      ["missing keys", { siteId: SITE.id }],
      ["a lower-case key", { siteId: SITE.id, keys: ["wid"] }],
      ["a key that is too short", { siteId: SITE.id, keys: ["W"] }],
      ["more than 20 keys", { siteId: SITE.id, keys: Array.from({ length: 21 }, (_, i) => `K${i}`) }],
      ["an unknown body field", { siteId: SITE.id, keys: ["WID"], extra: true }],
      ["keys that are not strings", { siteId: SITE.id, keys: [7] }],
    ])("rejects %s with 400", async (_name, body) => {
      connect();
      expect((await link(body)).statusCode).toBe(400);
    });

    it("accepts exactly 20 keys when they all exist", async () => {
      connect();
      const keys = Array.from({ length: 20 }, (_, i) => `K${String.fromCharCode(65 + i)}`);
      for (const key of keys) tracker.seedSpace(SITE.id, key, { name: key });
      const res = await link({ siteId: SITE.id, keys });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toHaveLength(20);
      await settled(() => workItemCrawler.isCrawling());
    });

    it("refuses a link from another origin", async () => {
      connect();
      const res = await app.inject({
        method: "PUT",
        url: `/api/repos/${repoId}/spaces`,
        payload: { siteId: SITE.id, keys: ["WID"] },
        headers: { origin: "http://evil.example.test" },
      });
      expect(res.statusCode).toBe(403);
      expect(store.spacesFor(repoId)).toEqual([]);
    });
  });

  describe("crawling a space", () => {
    async function linked(): Promise<number> {
      connect();
      const res = await app.inject({
        method: "PUT",
        url: `/api/repos/${repoId}/spaces`,
        payload: { siteId: SITE.id, keys: ["WID"] },
      });
      await settled(() => workItemCrawler.isCrawling());
      return res.json<{ id: number }[]>()[0]!.id;
    }

    it("answers 202 and re-reads everything when asked for a full crawl", async () => {
      const id = await linked();
      store.resetSpaceCrawlCursor(id);
      store.upsertWorkItems(id, [workItem({ key: "WID-9", updatedAt: "2026-08-01T00:00:00Z" })]);
      tracker.calls.length = 0;

      const res = await app.inject({ method: "POST", url: `/api/spaces/${id}/crawl?full=1` });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });
      await settled(() => workItemCrawler.isCrawling());
      const asked = tracker.calls.filter((c) => c.method === "fetchWorkItemPage").map((c) => c.updatedSince);
      expect(asked).toEqual([null]);
    });

    it("answers 202 and reads only what changed on an ordinary crawl", async () => {
      const id = await linked();
      tracker.calls.length = 0;

      expect((await app.inject({ method: "POST", url: `/api/spaces/${id}/crawl` })).statusCode).toBe(202);
      await settled(() => workItemCrawler.isCrawling());

      const asked = tracker.calls.filter((c) => c.method === "fetchWorkItemPage").map((c) => c.updatedSince);
      expect(asked).toEqual(["2026-09-02T11:55:00.000Z"]);
    });

    it("records a failed crawl on the space, readably, when Jira is disconnected", async () => {
      const id = await linked();
      grants.delete("local-dev");
      expect((await app.inject({ method: "POST", url: `/api/spaces/${id}/crawl` })).statusCode).toBe(202);
      await settled(() => workItemCrawler.isCrawling());
      expect(store.getSpace(id)).toMatchObject({
        crawlStatus: "failed",
        crawlError: "Jira is not connected. Connect Jira first",
      });
    });

    it("answers 404 for an unknown space and 400 for a bad id or query", async () => {
      expect((await app.inject({ method: "POST", url: "/api/spaces/999/crawl" })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/spaces/abc/crawl" })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/spaces/1/crawl?full=2" })).statusCode).toBe(400);
    });

    it("refuses a crawl request from another origin", async () => {
      const id = await linked();
      const res = await app.inject({
        method: "POST",
        url: `/api/spaces/${id}/crawl`,
        headers: { origin: "http://evil.example.test" },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
