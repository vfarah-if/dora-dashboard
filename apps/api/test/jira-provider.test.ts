import { describe, expect, it, vi } from "vitest";
import { NotFoundError, RateLimitedError, UnauthorisedError, UpstreamError, ValidationError } from "../src/core/errors.js";
import { JiraCloudProvider, STATUS_CACHE_TTL_MS } from "../src/infrastructure/jira/jira-cloud-provider.js";

const BASE = "https://api.atlassian.com";
const SITE = "cloud-1";
const API = `${BASE}/ex/jira/${SITE}`;
const TOKEN = "token-secret";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

type Route = (url: string, init: RequestInit) => Response | undefined;

function build(...routes: Route[]) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> | null }[] = [];
  const http = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    for (const route of routes) {
      const reply = route(url, init);
      if (reply) return reply;
    }
    throw new Error(`unrouted ${url}`);
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const clock = { now: 1_000_000 };
  const provider = new JiraCloudProvider(http as unknown as typeof fetch, BASE, sleep, () => clock.now);
  return { provider, calls, sleep, http, clock };
}

const on =
  (suffix: string, reply: () => Response): Route =>
  (url) =>
    url.includes(suffix) ? reply() : undefined;

const statusRoute = on("/project/WID/statuses", () =>
  json([
    {
      id: "1",
      name: "Story",
      statuses: [
        { id: "10", name: "To Do", statusCategory: { key: "new" } },
        { id: "11", name: "In Progress", statusCategory: { key: "indeterminate" } },
      ],
    },
    {
      id: "2",
      name: "Bug",
      statuses: [
        { id: "11", name: "In Progress", statusCategory: { key: "indeterminate" } },
        { id: "12", name: "Done", statusCategory: { key: "done" } },
        { id: "13", name: "Odd", statusCategory: { key: "mystery" } },
      ],
    },
  ]),
);

describe("listSites", () => {
  it("maps resources that can read Jira work and drops the rest", async () => {
    const { provider, calls } = build(
      on("/oauth/token/accessible-resources", () =>
        json([
          {
            id: "cloud-1",
            url: "https://acme.example.test",
            name: "Acme",
            scopes: ["read:jira-work", "read:jira-user"],
            avatarUrl: "x",
          },
          { id: "cloud-2", url: "https://other.example.test", name: "Other", scopes: ["read:confluence-content.all"] },
          { id: "cloud-3", url: "https://none.example.test", name: "None" },
        ]),
      ),
    );
    expect(await provider.listSites(TOKEN)).toEqual([{ id: "cloud-1", url: "https://acme.example.test", name: "Acme" }]);
    expect(calls[0]!.url).toBe(`${BASE}/oauth/token/accessible-resources`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(provider.kind).toBe("jira-cloud");
  });
});

describe("listSpaces", () => {
  it("pages to the end and maps type, null when absent", async () => {
    const pages = [
      { startAt: 0, isLast: false, values: [{ key: "WID", name: "Widgets", projectTypeKey: "software" }] },
      { startAt: 1, isLast: true, values: [{ key: "OPS", name: "Operations" }] },
    ];
    const { provider, calls } = build((url) => (url.includes("project/search") ? json(pages[calls.length - 1]) : undefined));
    expect(await provider.listSpaces(TOKEN, SITE)).toEqual([
      { key: "WID", name: "Widgets", type: "software" },
      { key: "OPS", name: "Operations", type: null },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/rest/api/3/project/search?startAt=0&maxResults=50`,
      `${API}/rest/api/3/project/search?startAt=1&maxResults=50`,
    ]);
  });

  it("stops on an empty page, and uses total when isLast is missing", async () => {
    const empty = build(on("project/search", () => json({ isLast: false, values: [] })));
    expect(await empty.provider.listSpaces(TOKEN, SITE)).toEqual([]);
    const byTotal = build(on("project/search", () => json({ total: 1, values: [{ key: "WID", name: "Widgets" }] })));
    expect(await byTotal.provider.listSpaces(TOKEN, SITE)).toHaveLength(1);
    expect(byTotal.calls).toHaveLength(1);
    const bare = build(on("project/search", () => json({})));
    expect(await bare.provider.listSpaces(TOKEN, SITE)).toEqual([]);
  });
});

describe("fetchStatuses", () => {
  it("dedupes across issue types and maps the three categories", async () => {
    const { provider } = build(statusRoute);
    expect(await provider.fetchStatuses(TOKEN, SITE, "WID")).toEqual([
      { id: "10", name: "To Do", category: "todo" },
      { id: "11", name: "In Progress", category: "in_progress" },
      { id: "12", name: "Done", category: "done" },
    ]);
  });

  it("tolerates an issue type with no statuses", async () => {
    const { provider } = build(on("/statuses", () => json([{ id: "1" }])));
    expect(await provider.fetchStatuses(TOKEN, SITE, "WID")).toEqual([]);
  });
});

describe("fetchBoardColumns", () => {
  const boards = on("/agile/1.0/board?", () => json({ values: [{ id: 7 }, { id: 8 }], isLast: true }));
  const config = on("/board/7/configuration", () =>
    json({
      columnConfig: {
        columns: [
          { name: "To Do", statuses: [{ id: "10" }] },
          { name: "In Review", statuses: [{ id: "14" }, { id: "15" }] },
          { name: "Backlog" },
        ],
      },
    }),
  );

  it("reads the first board's columns", async () => {
    const { provider, calls } = build(boards, config);
    expect(await provider.fetchBoardColumns(TOKEN, SITE, "WID")).toEqual([
      { name: "To Do", statusIds: ["10"] },
      { name: "In Review", statusIds: ["14", "15"] },
      { name: "Backlog", statusIds: [] },
    ]);
    expect(calls[0]!.url).toBe(`${API}/rest/agile/1.0/board?projectKeyOrId=WID&maxResults=1`);
  });

  it("returns an empty list when there is no board or no column config", async () => {
    expect(await build(on("/board?", () => json({ values: [] }))).provider.fetchBoardColumns(TOKEN, SITE, "WID")).toEqual([]);
    expect(await build(on("/board?", () => json({}))).provider.fetchBoardColumns(TOKEN, SITE, "WID")).toEqual([]);
    expect(
      await build(
        boards,
        on("/configuration", () => json({})),
      ).provider.fetchBoardColumns(TOKEN, SITE, "WID"),
    ).toEqual([]);
  });

  it.each([403, 404])("returns an empty list when the agile API answers %s", async (status) => {
    expect(await build(on("/board?", () => json({}, status))).provider.fetchBoardColumns(TOKEN, SITE, "WID")).toEqual([]);
    expect(
      await build(
        boards,
        on("/configuration", () => json({}, status)),
      ).provider.fetchBoardColumns(TOKEN, SITE, "WID"),
    ).toEqual([]);
  });

  it("still throws on 401 and on other failures", async () => {
    await expect(build(on("/board?", () => json({}, 401))).provider.fetchBoardColumns(TOKEN, SITE, "WID")).rejects.toBeInstanceOf(
      UnauthorisedError,
    );
    await expect(build(on("/board?", () => json({}, 500))).provider.fetchBoardColumns(TOKEN, SITE, "WID")).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});

describe("fetchWorkItemPage", () => {
  const issue = (over: Record<string, unknown> = {}) => ({
    id: "1001",
    key: "WID-1",
    fields: {
      summary: "Add widget",
      issuetype: { name: "Story" },
      status: { id: "12", name: "Done", statusCategory: { key: "done" } },
      created: "2024-05-01T09:00:00.000+0100",
      updated: "2024-05-03T10:00:00.000+0000",
      resolutiondate: "2024-05-03T10:00:00.000+0000",
      assignee: { accountId: "acct-1", displayName: "Someone", emailAddress: "someone@example.test" },
      parent: { key: "WID-100" },
      labels: ["api"],
      ...over,
    },
  });
  const history = (created: string, from: string, fromString: string, to: string, toString: string) => ({
    created,
    items: [
      { field: "status", fieldId: "status", from, fromString, to, toString },
      { field: "assignee", from: null, to: "x" },
    ],
  });
  const search = (body: unknown) => on("/search/jql", () => json(body));
  const changelog = (...pages: unknown[]) => {
    let n = 0;
    return on("/changelog/bulkfetch", () => json(pages[Math.min(n++, pages.length - 1)]));
  };

  it("maps an issue, joins its changelog and synthesises the creation entry", async () => {
    const { provider } = build(
      search({ issues: [issue()], isLast: true }),
      statusRoute,
      changelog({
        issueChangeLogs: [
          {
            issueId: "1001",
            changeHistories: [
              history("2024-05-03T10:00:00.000+0000", "11", "In Progress", "12", "Done"),
              history("2024-05-02T08:00:00.000+0000", "10", "To Do", "11", "In Progress"),
            ],
          },
        ],
      }),
    );
    const page = await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      {
        key: "WID-1",
        spaceKey: "WID",
        type: "Story",
        summary: "Add widget",
        status: "Done",
        statusCategory: "done",
        createdAt: "2024-05-01T08:00:00.000Z",
        updatedAt: "2024-05-03T10:00:00.000Z",
        resolvedAt: "2024-05-03T10:00:00.000Z",
        assigneeId: "acct-1",
        parentKey: "WID-100",
        labels: ["api"],
        transitions: [
          { at: "2024-05-01T08:00:00.000Z", from: null, to: "To Do", fromCategory: null, toCategory: "todo" },
          { at: "2024-05-02T08:00:00.000Z", from: "To Do", to: "In Progress", fromCategory: "todo", toCategory: "in_progress" },
          { at: "2024-05-03T10:00:00.000Z", from: "In Progress", to: "Done", fromCategory: "in_progress", toCategory: "done" },
        ],
      },
    ]);
    // The name travels beside the items, never on them, and the email address is not kept at all.
    expect(page.people).toEqual({ "acct-1": "Someone" });
    expect(JSON.stringify(page.items)).not.toContain("Someone");
    expect(JSON.stringify(page)).not.toContain("someone@example.test");
  });

  it.each([
    [-1, "subtask"],
    [0, "standard"],
    [1, "epic"],
    [2, "epic"],
  ])("maps issue type hierarchy level %i to %s", async (hierarchyLevel, level) => {
    const { provider } = build(
      search({ issues: [issue({ issuetype: { name: "Anything", hierarchyLevel } })], isLast: true }),
      statusRoute,
      changelog({}),
    );
    const [item] = (await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).items;
    expect(item!.level).toBe(level);
  });

  it("leaves level off an item whose issue type carries no hierarchy level", async () => {
    const { provider } = build(search({ issues: [issue()], isLast: true }), statusRoute, changelog({}));
    const [item] = (await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).items;
    expect("level" in item!).toBe(false);
  });

  it("collects one name per assignee and skips unassigned issues and assignees without a name", async () => {
    const { provider } = build(
      search({
        issues: [
          issue(),
          { ...issue({ assignee: { accountId: "acct-1", displayName: "Someone" } }), id: "1002", key: "WID-2" },
          { ...issue({ assignee: { accountId: "acct-2", displayName: "Another" } }), id: "1003", key: "WID-3" },
          { ...issue({ assignee: { accountId: "acct-3" } }), id: "1004", key: "WID-4" },
          { ...issue({ assignee: null }), id: "1005", key: "WID-5" },
        ],
        isLast: true,
      }),
      statusRoute,
      changelog({}),
    );
    const page = await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null);
    expect(page.people).toEqual({ "acct-1": "Someone", "acct-2": "Another" });
  });

  it("reads changelog times sent as epoch milliseconds, as the bulk changelog does", async () => {
    const { provider } = build(
      search({ issues: [issue()], isLast: true }),
      statusRoute,
      changelog({
        issueChangeLogs: [
          {
            issueId: "1001",
            changeHistories: [
              { ...history("", "11", "In Progress", "12", "Done"), created: Date.UTC(2024, 4, 3, 10) },
              { ...history("", "10", "To Do", "11", "In Progress"), created: Date.UTC(2024, 4, 2, 8) },
            ],
          },
        ],
      }),
    );
    const [item] = (await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).items;
    expect(item!.transitions.map((t) => [t.at, t.to])).toEqual([
      ["2024-05-01T08:00:00.000Z", "To Do"],
      ["2024-05-02T08:00:00.000Z", "In Progress"],
      ["2024-05-03T10:00:00.000Z", "Done"],
    ]);
  });

  it("asks Jira for the space's statuses once across the pages of a crawl", async () => {
    const { provider, calls } = build(
      search({ issues: [issue()], isLast: true }),
      statusRoute,
      changelog({ issueChangeLogs: [] }),
    );
    await provider.fetchStatuses(TOKEN, SITE, "WID");
    await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null);
    await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, "tok-1");
    await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, "tok-2");

    expect(calls.filter((c) => c.url.endsWith("/project/WID/statuses"))).toHaveLength(1);
  });

  it("reads the statuses again once the cached ones are older than the time to live", async () => {
    const { provider, calls, clock } = build(
      search({ issues: [issue()], isLast: true }),
      statusRoute,
      changelog({ issueChangeLogs: [] }),
    );
    const statusCalls = () => calls.filter((c) => c.url.endsWith("/project/WID/statuses")).length;
    await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null);
    clock.now += STATUS_CACHE_TTL_MS - 1;
    await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null);
    expect(statusCalls()).toBe(1);

    clock.now += 1;
    await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null);
    expect(statusCalls()).toBe(2);
  });

  it("keeps statuses of different spaces apart", async () => {
    const { provider, calls } = build(
      search({ issues: [issue()], isLast: true }),
      on("/project/GAD/statuses", () => json([])),
      statusRoute,
      changelog({ issueChangeLogs: [] }),
    );
    await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null);
    await provider.fetchWorkItemPage(TOKEN, SITE, "GAD", null, null);
    expect(calls.filter((c) => c.url.includes("/statuses"))).toHaveLength(2);
  });

  it("starts from the current status when there is no history", async () => {
    const { provider } = build(search({ issues: [issue()], isLast: true }), statusRoute, changelog({ issueChangeLogs: [] }));
    const [item] = (await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).items;
    expect(item!.transitions).toEqual([
      { at: "2024-05-01T08:00:00.000Z", from: null, to: "Done", fromCategory: null, toCategory: "done" },
    ]);
  });

  it("copes with a changelog that has no histories, no items or no status field", async () => {
    const { provider } = build(
      search({ issues: [issue(), issue()], isLast: true }),
      statusRoute,
      changelog({
        issueChangeLogs: [{ issueId: "1001" }, { issueId: "1002", changeHistories: [{ created: "2024-05-02T00:00:00.000Z" }] }],
      }),
    );
    expect((await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).items).toHaveLength(2);
  });

  it("leaves categories null for an unknown status id and no inline category", async () => {
    const { provider } = build(
      search({ issues: [issue({ status: { id: "99", name: "Archived" } })], isLast: true }),
      statusRoute,
      changelog({
        issueChangeLogs: [
          {
            issueId: "1001",
            changeHistories: [
              {
                created: "2024-05-02T08:00:00.000Z",
                items: [{ field: "status", from: "98", fromString: "Gone", to: "99", toString: "Archived" }],
              },
            ],
          },
        ],
      }),
    );
    const [item] = (await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).items;
    expect(item!.statusCategory).toBeNull();
    expect(item!.transitions.map((t) => [t.fromCategory, t.toCategory])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it("falls back to the issue's own status category when the space statuses lack it", async () => {
    const { provider } = build(
      search({ issues: [issue({ status: { id: "99", name: "Archived", statusCategory: { key: "done" } } })], isLast: true }),
      statusRoute,
      changelog({ issueChangeLogs: [] }),
    );
    expect((await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).items[0]!.statusCategory).toBe("done");
  });

  it("handles missing optional fields", async () => {
    const { provider } = build(
      search({
        issues: [
          { id: "1002", key: "WID-2", fields: { created: "2024-05-01T09:00:00.000Z", updated: "2024-05-01T09:00:00.000Z" } },
        ],
        isLast: true,
      }),
      statusRoute,
      changelog({}),
    );
    const [item] = (await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).items;
    expect(item).toMatchObject({
      type: "",
      summary: "",
      status: "",
      statusCategory: null,
      resolvedAt: null,
      assigneeId: null,
      parentKey: null,
      labels: [],
    });
  });

  it("keeps an unparseable timestamp as sent", async () => {
    const { provider } = build(search({ issues: [issue({ created: "not a date" })], isLast: true }), statusRoute, changelog({}));
    expect((await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).items[0]!.createdAt).toBe("not a date");
  });

  it("returns the next token, sends the cursor and follows the changelog's pages", async () => {
    const { provider, calls } = build(
      search({ issues: [issue()], nextPageToken: "tok-2", isLast: false }),
      statusRoute,
      changelog(
        {
          issueChangeLogs: [
            { issueId: "1001", changeHistories: [history("2024-05-02T08:00:00.000Z", "10", "To Do", "11", "In Progress")] },
          ],
          nextPageToken: "cl-2",
        },
        {
          issueChangeLogs: [
            { issueId: "1001", changeHistories: [history("2024-05-03T08:00:00.000Z", "11", "In Progress", "12", "Done")] },
          ],
        },
      ),
    );
    const page = await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, "tok-1");
    expect(page.nextCursor).toBe("tok-2");
    expect(page.items[0]!.transitions).toHaveLength(3);
    const searchCall = calls.find((c) => c.url.endsWith("/search/jql"))!;
    expect(searchCall.body).toMatchObject({ maxResults: 50, nextPageToken: "tok-1" });
    expect(searchCall.body!.fields).toEqual([
      "summary",
      "issuetype",
      "status",
      "created",
      "updated",
      "resolutiondate",
      "assignee",
      "parent",
      "labels",
    ]);
    const logs = calls.filter((c) => c.url.endsWith("/changelog/bulkfetch"));
    expect(logs).toHaveLength(2);
    expect(logs[0]!.body).toMatchObject({ issueIdsOrKeys: ["1001"], fieldIds: ["status"] });
    expect("nextPageToken" in logs[0]!.body!).toBe(false);
    expect(logs[1]!.body).toMatchObject({ nextPageToken: "cl-2" });
  });

  it("gives a null cursor when isLast is set even if a token is present, or when no token comes", async () => {
    const a = build(search({ issues: [issue()], nextPageToken: "tok", isLast: true }), statusRoute, changelog({}));
    expect((await a.provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).nextCursor).toBeNull();
    const b = build(search({ issues: [issue()] }), statusRoute, changelog({}));
    expect((await b.provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).nextCursor).toBeNull();
  });

  it("makes no follow-up calls for an empty page", async () => {
    const { provider, calls } = build(search({ isLast: true }));
    expect(await provider.fetchWorkItemPage(TOKEN, SITE, "WID", null, null)).toEqual({ items: [], nextCursor: null, people: {} });
    expect(calls).toHaveLength(1);
  });

  it("builds JQL newest first, with the key escaped and no date filter by default", async () => {
    const { provider, calls } = build(search({ issues: [], isLast: true }));
    await provider.fetchWorkItemPage(TOKEN, SITE, 'W"I\\D', null, null);
    expect(calls[0]!.body!.jql).toBe('project = "W\\"I\\\\D" ORDER BY updated DESC');
    expect("nextPageToken" in calls[0]!.body!).toBe(false);
  });

  it("subtracts a day from updatedSince as a time zone margin", async () => {
    const { provider, calls } = build(search({ issues: [], isLast: true }));
    await provider.fetchWorkItemPage(TOKEN, SITE, "WID", "2024-03-01T00:05:00.000Z", null);
    // 1 March 00:05 minus one day is 29 February 2024 (a leap year) 00:05.
    expect(calls[0]!.body!.jql).toBe('project = "WID" AND updated >= "2024/02/29 00:05" ORDER BY updated DESC');
  });

  it("rejects an updatedSince that is not a date", async () => {
    const { provider } = build();
    await expect(provider.fetchWorkItemPage(TOKEN, SITE, "WID", "yesterday", null)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("error mapping", () => {
  it("maps 401 to UnauthorisedError", async () => {
    await expect(build(() => json({}, 401)).provider.listSites(TOKEN)).rejects.toBeInstanceOf(UnauthorisedError);
  });

  it.each([403, 404])("maps %s to NotFoundError", async (status) => {
    await expect(build(() => json({}, status)).provider.fetchStatuses(TOKEN, SITE, "WID")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("says on a 403 that the space cannot be seen or the app lacks a scope, without the token", async () => {
    const error = (await build(() => json({}, 403))
      .provider.fetchStatuses(TOKEN, SITE, "WID")
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("The Jira space cannot be seen by this account, or the app lacks a required scope");
    expect(error.message).not.toContain(TOKEN);
  });

  it.each([400, 500, 503])("maps %s to UpstreamError carrying the status", async (status) => {
    const failure = await build(() => json({}, status))
      .provider.listSpaces(TOKEN, SITE)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UpstreamError);
    expect(failure).toMatchObject({ status });
  });

  it("maps an unreadable body and a network failure to UpstreamError", async () => {
    await expect(build(() => new Response("<html>", { status: 200 })).provider.listSites(TOKEN)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    const down = build(() => {
      throw new Error("offline");
    });
    await expect(down.provider.listSites(TOKEN)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("never puts the token in an error message", async () => {
    for (const status of [401, 404, 500, 429]) {
      const failure = await build(() => json({}, status))
        .provider.listSites(TOKEN)
        .catch((e: unknown) => e);
      expect((failure as Error).message).not.toContain(TOKEN);
    }
  });
});

describe("rate limiting", () => {
  it("waits the Retry-After seconds once, then succeeds", async () => {
    let n = 0;
    const { provider, sleep, calls } = build(() => (n++ === 0 ? json({}, 429, { "Retry-After": "7" }) : json([])));
    expect(await provider.listSites(TOKEN)).toEqual([]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(7000);
    expect(calls).toHaveLength(2);
  });

  it("raises RateLimitedError when the retry is limited too", async () => {
    const { provider, sleep, calls } = build(() => json({}, 429, { "Retry-After": "2" }));
    await expect(provider.listSites(TOKEN)).rejects.toBeInstanceOf(RateLimitedError);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["is absent", undefined, 1000],
    ["is not a number", "soon", 1000],
    ["is zero", "0", 1000],
    ["exceeds the cap", "120", 30_000],
  ])("when Retry-After %s it waits %i ms", async (_name, header, expected) => {
    let n = 0;
    const { provider, sleep } = build(() =>
      n++ === 0 ? json({}, 429, header === undefined ? {} : { "Retry-After": header }) : json([]),
    );
    await provider.listSites(TOKEN);
    expect(sleep).toHaveBeenCalledWith(expected);
  });

  it("sleeps on a real timer by default", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const http = vi.fn(async () => (n++ === 0 ? json({}, 429, { "Retry-After": "3" }) : json([])));
      const provider = new JiraCloudProvider(http as unknown as typeof fetch);
      const pending = provider.listSites(TOKEN);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
