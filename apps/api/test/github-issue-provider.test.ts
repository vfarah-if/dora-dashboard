import { describe, expect, it, vi } from "vitest";
import { NotFoundError, UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { GitHubIssueProvider } from "../src/infrastructure/github/github-issue-provider.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const node = {
  number: 12,
  title: "Widgets crash on save",
  url: "https://github.com/acme/widgets/issues/12",
  state: "CLOSED",
  stateReason: "COMPLETED",
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-03T10:00:00Z",
  closedAt: "2026-09-02T10:00:00Z",
  assignees: { nodes: [{ login: "bob" }] },
  labels: { nodes: [{ name: "bug" }, { name: "P1" }] },
  issueType: { name: "Bug" },
  closedByPullRequestsReferences: { nodes: [{ number: 30, repository: { nameWithOwner: "acme/widgets" } }] },
  timelineItems: {
    pageInfo: { hasPreviousPage: false },
    nodes: [
      { __typename: "ClosedEvent", createdAt: "2026-09-02T10:00:00Z" },
      { __typename: "ReopenedEvent", createdAt: "2026-09-01T18:00:00Z" },
    ],
  },
};

const connection = (nodes: unknown[], more: string | null = null, totalCount = nodes.length) => ({
  hasIssuesEnabled: true,
  issues: { totalCount, pageInfo: { hasNextPage: more !== null, endCursor: more }, nodes },
});
const answer = (repository: unknown) => json({ data: { repository } });
const readAny = (http: typeof fetch, request = { updatedSince: null as string | null, cursor: null as string | null }) =>
  new GitHubIssueProvider(http).fetchIssuePage("t", "acme", "widgets", request);
/** A page the test expects to be enabled, so its issues can be read. */
const read = async (...args: Parameters<typeof readAny>) => {
  const page = await readAny(...args);
  if (!page.enabled) throw new Error("expected an enabled page");
  return page;
};
const variablesOf = (http: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse((http.mock.calls[call]![1] as RequestInit).body as string).variables;

describe("GitHubIssueProvider", () => {
  it("maps an issue, qualifying its closing pull requests and sorting events oldest first", async () => {
    const http = vi.fn(async () => answer(connection([node], "c2", 9)));

    const page = await read(http);

    expect(page).toMatchObject({ enabled: true, totalCount: 9, nextCursor: "c2" });
    expect(page.items[0]).toEqual({
      number: 12,
      title: "Widgets crash on save",
      url: "https://github.com/acme/widgets/issues/12",
      state: "closed",
      closeReason: "completed",
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-03T10:00:00Z",
      closedAt: "2026-09-02T10:00:00Z",
      assignees: ["bob"],
      labels: ["bug", "P1"],
      issueType: "Bug",
      closedBy: [{ repo: "acme/widgets", number: 30 }],
      events: [
        { at: "2026-09-01T18:00:00Z", type: "reopened" },
        { at: "2026-09-02T10:00:00Z", type: "closed" },
      ],
    });
    expect("eventsTruncated" in page.items[0]!).toBe(false);
    const [url, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/graphql");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it.each([
    ["COMPLETED", "completed"],
    ["NOT_PLANNED", "not_planned"],
    ["DUPLICATE", "duplicate"],
    ["SOMETHING_NEW", "completed"],
    ["REOPENED", "completed"],
    [null, "completed"],
  ])("reads a closed issue with reason %s as %s", async (stateReason, expected) => {
    const page = await read(vi.fn(async () => answer(connection([{ ...node, stateReason }]))));

    expect(page.items[0]!.closeReason).toBe(expected);
  });

  it("gives an open issue no close reason and no close date, whatever REOPENED says", async () => {
    const open = { ...node, state: "OPEN", stateReason: "REOPENED", closedAt: null };

    const issue = (await read(vi.fn(async () => answer(connection([open]))))).items[0]!;

    expect(issue).toMatchObject({ state: "open", closeReason: null, closedAt: null });
  });

  it("keeps closes and reopens, drops other timeline items and entries without a time, and sorts oldest first", async () => {
    const events = [
      { __typename: "ClosedEvent", createdAt: "2026-09-03T10:00:00Z" },
      { __typename: "SomethingElse", createdAt: "2026-09-04T10:00:00Z" },
      { __typename: "ClosedEvent" },
      null,
      { __typename: "ReopenedEvent", createdAt: "2026-09-01T10:00:00Z" },
    ];

    const issue = (
      await read(
        vi.fn(async () =>
          answer(connection([{ ...node, timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: events } }])),
        ),
      )
    ).items[0]!;

    expect(issue.events).toEqual([
      { at: "2026-09-01T10:00:00Z", type: "reopened" },
      { at: "2026-09-03T10:00:00Z", type: "closed" },
    ]);
  });

  it("flags events as truncated when GitHub held older ones than it sent", async () => {
    const truncated = { ...node, timelineItems: { ...node.timelineItems, pageInfo: { hasPreviousPage: true } } };

    const issue = (await read(vi.fn(async () => answer(connection([truncated]))))).items[0]!;

    expect(issue.eventsTruncated).toBe(true);
  });

  it("reads an issue with every optional field missing", async () => {
    const bare = {
      number: 3,
      title: "Bare",
      url: "https://github.com/acme/widgets/issues/3",
      state: "OPEN",
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-01T10:00:00Z",
    };

    const [issue] = (await read(vi.fn(async () => answer(connection([bare, null]))))).items;

    expect(issue).toEqual({
      number: 3,
      title: "Bare",
      url: "https://github.com/acme/widgets/issues/3",
      state: "open",
      closeReason: null,
      createdAt: "2026-09-01T10:00:00Z",
      updatedAt: "2026-09-01T10:00:00Z",
      closedAt: null,
      assignees: [],
      labels: [],
      issueType: null,
      closedBy: [],
      events: [],
    });
  });

  it("tolerates null entries and nulls inside the connections", async () => {
    const sparse = {
      ...node,
      issueType: null,
      assignees: { nodes: [null, { login: "bob" }] },
      labels: { nodes: [null, { name: "bug" }] },
      closedByPullRequestsReferences: {
        nodes: [null, { number: 5, repository: null }, { number: 6, repository: { nameWithOwner: "acme/gadgets" } }],
      },
    };

    const issue = (await read(vi.fn(async () => answer(connection([sparse]))))).items[0]!;

    expect(issue).toMatchObject({
      issueType: null,
      assignees: ["bob"],
      labels: ["bug"],
      closedBy: [{ repo: "acme/gadgets", number: 6 }],
    });
  });

  it("returns the cursor only while GitHub says there is another page, and reads to the end", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(answer(connection([node], "c2", 2)))
      .mockResolvedValueOnce(answer(connection([{ ...node, number: 13 }], null, 2)));

    const first = await read(http);
    const second = await read(http, { updatedSince: null, cursor: first.nextCursor });

    expect(first.nextCursor).toBe("c2");
    expect(second.nextCursor).toBeNull();
    expect(variablesOf(http, 1)).toMatchObject({ cursor: "c2", first: 50 });
  });

  it("filters by the since instant when given, and sends an empty filter otherwise", async () => {
    const http = vi.fn(async () => answer(connection([])));

    await read(http, { updatedSince: "2026-09-01T00:00:00.000Z", cursor: null });
    await read(http);

    expect(variablesOf(http, 0)).toEqual({
      owner: "acme",
      name: "widgets",
      cursor: null,
      first: 50,
      filter: { since: "2026-09-01T00:00:00.000Z" },
    });
    expect(variablesOf(http, 1).filter).toEqual({});
  });

  it("orders by last update, newest first, in the query it sends", async () => {
    const http = vi.fn(async () => answer(connection([])));

    await read(http);

    const [, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string).query as string;
    expect(body).toContain("orderBy: {field: UPDATED_AT, direction: DESC}");
    expect(body).toContain("stateReason(enableDuplicate: true)");
  });

  it("answers a switched-off page without reading issues", async () => {
    const http = vi.fn(async () =>
      answer({
        hasIssuesEnabled: false,
        issues: { totalCount: 4, pageInfo: { hasNextPage: true, endCursor: "x" }, nodes: [node] },
      }),
    );

    expect(await readAny(http)).toEqual({ enabled: false });
  });

  it("raises a 502 when GitHub sends no issues list, rather than an empty page", async () => {
    const failure = await read(vi.fn(async () => answer({ hasIssuesEnabled: true, issues: null }))).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(UpstreamError);
    expect(failure).toMatchObject({ status: 502, message: "GitHub sent no issues list for acme/widgets" });
  });

  it("tolerates an error inside one field of an issue, reading that field as empty", async () => {
    const http = vi.fn(async () =>
      json({
        data: { repository: connection([{ ...node, labels: null }]) },
        errors: [{ message: "labels timed out", path: ["repository", "issues", "nodes", 0, "labels"] }],
      }),
    );

    const issue = (await read(http)).items[0]!;

    expect(issue).toMatchObject({ number: 12, labels: [] });
  });

  it("raises an error inside a field when it left its whole issue null, so a full read cannot drop the issue", async () => {
    const http = vi.fn(async () =>
      json({
        data: { repository: connection([node, null]) },
        errors: [{ message: "timeline failed", path: ["repository", "issues", "nodes", 1, "timelineItems", "nodes", 0] }],
      }),
    );

    await expect(read(http)).rejects.toMatchObject({ name: "UpstreamError", message: "timeline failed" });
  });

  it.each([
    ["on an issue node itself", ["repository", "issues", "nodes", 0]],
    ["on the issues connection", ["repository", "issues"]],
    ["elsewhere", ["viewer", "login"]],
    ["with no path", undefined],
    ["inside a field but not of a numbered node", ["repository", "issues", "nodes", "x", "labels"]],
  ])("still raises an error %s, even when issues arrived", async (_name, path) => {
    const http = vi.fn(async () =>
      json({ data: { repository: connection([node]) }, errors: [{ message: "node failed", ...(path ? { path } : {}) }] }),
    );

    await expect(read(http)).rejects.toMatchObject({ name: "UpstreamError", message: "node failed" });
  });

  it("explains a rate limit rather than repeating GitHub's text, whether or not issues arrived", async () => {
    const limited = { type: "RATE_LIMITED", message: "API rate limit already exceeded for user ID 123." };
    for (const data of [{ repository: null }, { repository: connection([node]) }]) {
      const failure = await read(vi.fn(async () => json({ data, errors: [limited] }))).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(UpstreamError);
      expect((failure as Error).message).toMatch(/rate limit for this token was reached.*Crawl again once it resets/);
      expect((failure as Error).message).not.toContain("user ID");
    }
  });

  it("raises the GraphQL errors, not a missing repository, when both arrive", async () => {
    const http = vi.fn(async () =>
      json({ data: { repository: null }, errors: [{ message: "API rate limit exceeded" }, { message: "try later" }] }),
    );

    const failure = await read(http).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(UpstreamError);
    expect((failure as Error).message).toBe("API rate limit exceeded; try later");
  });

  it("raises NotFoundError for a NOT_FOUND error on the repository path, with a null repository", async () => {
    const http = vi.fn(async () =>
      json({
        data: { repository: null },
        errors: [
          { type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository with the name 'acme/widgets'." },
        ],
      }),
    );

    await expect(read(http)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ["a NOT_FOUND on another path", { type: "NOT_FOUND", path: ["viewer"], message: "gone" }],
    ["a different type on the repository path", { type: "FORBIDDEN", path: ["repository"], message: "slow down" }],
    ["an error with no type", { message: "boom" }],
  ])("keeps %s as an UpstreamError", async (_name, error) => {
    const http = vi.fn(async () => json({ data: { repository: null }, errors: [error] }));

    await expect(read(http)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("raises NotFoundError for a repository GitHub does not return", async () => {
    await expect(read(vi.fn(async () => json({ data: { repository: null } })))).rejects.toBeInstanceOf(NotFoundError);
    await expect(read(vi.fn(async () => json({})))).rejects.toBeInstanceOf(NotFoundError);
    await expect(read(vi.fn(async () => json({}, 404)))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("raises UnauthorisedError on a 401 without echoing the token", async () => {
    const http = vi.fn(async () => json({ message: "Bad credentials" }, 401));

    const failure = await new GitHubIssueProvider(http)
      .fetchIssuePage("secret-token-value", "acme", "widgets", { updatedSince: null, cursor: null })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(UnauthorisedError);
    expect((failure as Error).message).not.toContain("secret-token-value");
  });

  it.each([502, 504])("retries once with a smaller page after a %i", async (status) => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(new Response("gateway", { status }))
      .mockResolvedValueOnce(answer(connection([node])));

    const page = await read(http);

    expect(page.items).toHaveLength(1);
    expect(http).toHaveBeenCalledTimes(2);
    expect(variablesOf(http, 0).first).toBe(50);
    expect(variablesOf(http, 1).first).toBe(20);
  });

  it("keeps the cursor and the since filter on the smaller retry", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(new Response("gateway", { status: 504 }))
      .mockResolvedValueOnce(answer(connection([node])));

    await read(http, { updatedSince: "2026-09-01T00:00:00.000Z", cursor: "c7" });

    expect(variablesOf(http, 0)).toMatchObject({ cursor: "c7", filter: { since: "2026-09-01T00:00:00.000Z" }, first: 50 });
    expect(variablesOf(http, 1)).toMatchObject({ cursor: "c7", filter: { since: "2026-09-01T00:00:00.000Z" }, first: 20 });
  });

  it("gives up after the one retry, and does not retry other failures", async () => {
    const twice = vi.fn(async () => new Response("gateway", { status: 502 }));
    await expect(read(twice)).rejects.toBeInstanceOf(UpstreamError);
    expect(twice).toHaveBeenCalledTimes(2);

    const once = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(read(once)).rejects.toMatchObject({ status: 500 });
    expect(once).toHaveBeenCalledTimes(1);
  });
});
