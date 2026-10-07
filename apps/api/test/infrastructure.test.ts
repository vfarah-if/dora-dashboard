import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { NotFoundError, UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { GhCliTokenSource } from "../src/infrastructure/auth/gh-cli-token-source.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { GitHubProvider, parseCoAuthors } from "../src/infrastructure/github/github-provider.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { FakeProvider, pr, run } from "./fakes.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const gqlNode = {
  number: 12,
  title: "Add widgets",
  url: "https://github.com/acme/widgets/pull/12",
  state: "MERGED",
  createdAt: "2026-09-01T10:00:00Z",
  publishedAt: "2026-09-01T10:00:00Z",
  mergedAt: "2026-09-01T11:00:00Z",
  closedAt: "2026-09-01T11:00:00Z",
  updatedAt: "2026-09-01T11:00:00Z",
  additions: 5,
  deletions: 1,
  baseRefName: "main",
  headRefName: "feature/WID-12-widgets",
  author: { login: "renovate", __typename: "Bot" },
  mergedBy: null,
  commits: { nodes: [{ commit: { authoredDate: "2026-09-01T08:00:00Z", committedDate: "2026-09-01T09:30:00Z" } }] },
  reviews: { nodes: [{ author: null, state: "APPROVED", submittedAt: "2026-09-01T10:30:00Z" }] },
};

describe("parseCoAuthors", () => {
  it("returns every trailer name, matching the key in any case", () => {
    const message =
      "Add widgets\n\nBody text\n\nCo-Authored-By: Claude <noreply@example.com>\nco-authored-by: Sam Lee <sam@example.com>\nCO-AUTHORED-BY: Pat";
    expect(parseCoAuthors(message)).toEqual(["Claude", "Sam Lee", "Pat"]);
  });

  it("keeps a name given without an email and strips the email otherwise", () => {
    expect(parseCoAuthors("x\n\nCo-Authored-By:   Copilot  ")).toEqual(["Copilot"]);
    const names = parseCoAuthors("Co-Authored-By: Claude <secret@example.com>\r\nCo-authored-by: Sam <>");
    expect(names).toEqual(["Claude", "Sam"]);
    expect(names.join(" ")).not.toMatch(/@|</);
  });

  it("removes duplicates and ignores messages without trailers", () => {
    expect(parseCoAuthors("Co-Authored-By: Claude <a@example.com>\nCo-Authored-By: Claude <b@example.com>")).toEqual(["Claude"]);
    expect(parseCoAuthors("Fix widgets\n\nMentions co-authored-by: in prose")).toEqual([]);
    expect(parseCoAuthors("")).toEqual([]);
  });
});

describe("GitHubProvider", () => {
  it("records labels and co-author names only, never an email or a commit message", async () => {
    const node = {
      ...gqlNode,
      labels: { nodes: [{ name: "ai-assisted" }, { name: "bug" }] },
      trailers: {
        nodes: [
          { commit: { message: "One\n\nCo-Authored-By: Claude <private@example.com>" } },
          { commit: { message: "Two\n\nCo-authored-by: Claude <private@example.com>\nCo-authored-by: Sam Lee" } },
          { commit: { message: "Three, no trailer" } },
        ],
      },
    };
    const http = vi.fn(async () =>
      json({
        data: {
          repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 1, nodes: [node] } },
        },
      }),
    );
    const mapped = (await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;

    expect(mapped.labels).toEqual(["ai-assisted", "bug"]);
    expect(mapped.coAuthors).toEqual(["Claude", "Sam Lee"]);
    const serialised = JSON.stringify(mapped);
    expect(serialised).not.toContain("private@example.com");
    expect(serialised).not.toContain("no trailer");
  });

  it("leaves labels and coAuthors absent when GitHub sent neither", async () => {
    const http = vi.fn(async () =>
      json({
        data: {
          repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 1, nodes: [gqlNode] } },
        },
      }),
    );
    const mapped = (await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;
    expect("labels" in mapped).toBe(false);
    expect("coAuthors" in mapped).toBe(false);
  });

  it("maps a GraphQL page onto the domain, taking the earlier of the first commit's two dates", async () => {
    const http = vi.fn(async () =>
      json({
        data: {
          repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "c2" }, totalCount: 9, nodes: [gqlNode] } },
        },
      }),
    );
    const page = await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null);

    expect(page).toMatchObject({ totalCount: 9, nextCursor: "c2" });
    expect(page.pullRequests[0]).toMatchObject({
      number: 12,
      author: "renovate",
      authorIsBot: true,
      mergedBy: null,
      firstCommitAt: "2026-09-01T08:00:00Z",
      headRef: "feature/WID-12-widgets",
      reviews: [{ author: null, state: "APPROVED" }],
    });
    const [, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("asks for the head branch name and records null when GitHub sent none", async () => {
    const respond = (node: object) =>
      vi.fn(async () =>
        json({
          data: {
            repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 1, nodes: [node] } },
          },
        }),
      );
    const { headRefName: _omitted, ...withoutHead } = gqlNode;
    const http = respond(withoutHead);
    const mapped = (await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;

    expect(mapped.headRef).toBeNull();
    const [, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body as string).toContain("headRefName");
  });

  it("records the changed file paths, and leaves files absent when GitHub sent none", async () => {
    const page = (node: object) =>
      vi.fn(async () =>
        json({
          data: {
            repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: "x" }, totalCount: 1, nodes: [node] } },
          },
        }),
      );
    const withFiles = await new GitHubProvider(
      page({ ...gqlNode, files: { nodes: [{ path: "src/a.ts" }, { path: "src/a.test.ts" }] } }),
    ).fetchPullRequestPage("t", "acme", "widgets", null);
    const without = await new GitHubProvider(page(gqlNode)).fetchPullRequestPage("t", "acme", "widgets", null);

    expect(withFiles.pullRequests[0]!.files).toEqual(["src/a.ts", "src/a.test.ts"]);
    expect("files" in without.pullRequests[0]!).toBe(false);
  });

  it("marks a pull request that changed more than 100 files as truncated, and only then", async () => {
    const page = (node: object) =>
      vi.fn(async () =>
        json({
          data: {
            repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: "x" }, totalCount: 1, nodes: [node] } },
          },
        }),
      );
    const calls: number[] = [];
    const fetchOne = async (files: object) => {
      const http = page({ ...gqlNode, files });
      const mapped = (await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;
      calls.push(http.mock.calls.length);
      return mapped;
    };
    const paths = Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.ts` }));

    const over = await fetchOne({ totalCount: 101, nodes: paths });
    const exactly = await fetchOne({ totalCount: 100, nodes: paths });

    expect(over.filesTruncated).toBe(true);
    expect(over.files).toHaveLength(100);
    expect("filesTruncated" in exactly).toBe(false);
    // Without a cursor to follow, nothing more is asked for.
    expect(calls).toEqual([1, 1]);
  });

  describe("a pull request with more than 100 changed files", () => {
    const paths = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ path: `src/f${from + i}.ts` }));
    const listPage = (files: object) =>
      json({
        data: {
          repository: {
            pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 1, nodes: [{ ...gqlNode, files }] },
          },
        },
      });
    const filesPage = (files: object | null) => json({ data: { repository: { pullRequest: files && { files } } } });
    const more = (cursor: string | null) => ({ hasNextPage: cursor !== null, endCursor: cursor });
    const variablesOf = (http: ReturnType<typeof vi.fn>) =>
      http.mock.calls.slice(1).map(([, init]) => JSON.parse((init as RequestInit).body as string).variables);

    it("reads the rest of the list 100 at a time from where the first page stopped", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce(listPage({ totalCount: 250, pageInfo: more("c1"), nodes: paths(0, 100) }))
        .mockResolvedValueOnce(filesPage({ totalCount: 250, pageInfo: more("c2"), nodes: paths(100, 100) }))
        .mockResolvedValueOnce(filesPage({ totalCount: 250, pageInfo: more(null), nodes: paths(200, 50) }));
      const mapped = (await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;

      expect(mapped.files).toHaveLength(250);
      expect(mapped.files![249]).toBe("src/f249.ts");
      expect("filesTruncated" in mapped).toBe(false);
      expect(variablesOf(http)).toEqual([
        { owner: "acme", name: "widgets", number: 12, cursor: "c1" },
        { owner: "acme", name: "widgets", number: 12, cursor: "c2" },
      ]);
      const [, init] = http.mock.calls[1] as unknown as [string, RequestInit];
      expect(JSON.parse(init.body as string).query).toContain("pullRequest(number: $number)");
    });

    it("stops at 3000 files and keeps the pull request marked as cut", async () => {
      let next = 100;
      const http = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (!(init?.body as string).includes("pullRequest(number")) {
          return listPage({ totalCount: 3500, pageInfo: more("c100"), nodes: paths(0, 100) });
        }
        next += 100;
        return filesPage({ totalCount: 3500, pageInfo: more(`c${next}`), nodes: paths(next - 100, 100) });
      });
      const mapped = (await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;

      // The first page and 29 more of 100 make 3000.
      expect(http).toHaveBeenCalledTimes(30);
      expect(mapped.files).toHaveLength(3000);
      expect(mapped.filesTruncated).toBe(true);
    });

    it("keeps the pull request marked as cut when GitHub ends the list short of its total or loses the pull request", async () => {
      const short = vi
        .fn()
        .mockResolvedValueOnce(listPage({ totalCount: 250, pageInfo: more("c1"), nodes: paths(0, 100) }))
        .mockResolvedValueOnce(filesPage({ totalCount: 250, pageInfo: more(null), nodes: paths(100, 100) }));
      const lost = vi
        .fn()
        .mockResolvedValueOnce(listPage({ totalCount: 250, pageInfo: more("c1"), nodes: paths(0, 100) }))
        .mockResolvedValueOnce(filesPage(null));

      const shortPr = (await new GitHubProvider(short).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;
      const lostPr = (await new GitHubProvider(lost).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;

      expect([shortPr.files?.length, shortPr.filesTruncated]).toEqual([200, true]);
      expect([lostPr.files?.length, lostPr.filesTruncated]).toEqual([100, true]);
    });

    const fetchWith = async (...answers: Response[]) => {
      const http = vi.fn();
      http.mockResolvedValueOnce(listPage({ totalCount: 250, pageInfo: more("c1"), nodes: paths(0, 100) }));
      for (const answer of answers) http.mockResolvedValueOnce(answer);
      const mapped = (await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;
      return { mapped, http };
    };

    it("keeps the paths already read and marks the list as cut when a file request fails upstream", async () => {
      const gateway = await fetchWith(
        filesPage({ totalCount: 250, pageInfo: more("c2"), nodes: paths(100, 100) }),
        new Response("bad gateway", { status: 502 }),
      );
      const refused = await fetchWith(json({ errors: [{ message: "API rate limit exceeded" }] }));

      expect([gateway.mapped.files?.length, gateway.mapped.filesTruncated]).toEqual([200, true]);
      expect([refused.mapped.files?.length, refused.mapped.filesTruncated]).toEqual([100, true]);
    });

    it("still fails the page when a file request is refused the credential or cannot see the repository", async () => {
      for (const [status, name] of [
        [401, "UnauthorisedError"],
        [404, "NotFoundError"],
      ] as const) {
        await expect(fetchWith(new Response("", { status }))).rejects.toMatchObject({ name });
      }
    });

    it("stops at an empty page, a missing answer or a cursor that does not move", async () => {
      const empty = await fetchWith(filesPage({ totalCount: 250, pageInfo: more("c2"), nodes: [] }));
      const missing = await fetchWith(json({}));
      const stuck = await fetchWith(filesPage({ totalCount: 250, pageInfo: more("c1"), nodes: paths(100, 100) }));

      expect([empty.mapped.files?.length, empty.http.mock.calls.length]).toEqual([100, 2]);
      expect([missing.mapped.files?.length, missing.http.mock.calls.length]).toEqual([100, 2]);
      expect([stuck.mapped.files?.length, stuck.mapped.filesTruncated, stuck.http.mock.calls.length]).toEqual([200, true, 2]);
    });

    it("asks for nothing more when the first page offers no cursor", async () => {
      const http = vi
        .fn()
        .mockResolvedValueOnce(
          listPage({ totalCount: 250, pageInfo: { hasNextPage: true, endCursor: null }, nodes: paths(0, 100) }),
        );
      const mapped = (await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;

      expect(http).toHaveBeenCalledTimes(1);
      expect([mapped.files?.length, mapped.filesTruncated]).toEqual([100, true]);
    });

    it("reads to the end whatever size of page GitHub sends", async () => {
      // 100 with the pull request, then 60, 60 and 30 make the 250 GitHub counts.
      const { mapped, http } = await fetchWith(
        filesPage({ totalCount: 250, pageInfo: more("c2"), nodes: paths(100, 60) }),
        filesPage({ totalCount: 250, pageInfo: more("c3"), nodes: paths(160, 60) }),
        filesPage({ totalCount: 250, pageInfo: more(null), nodes: paths(220, 30) }),
      );

      expect(http).toHaveBeenCalledTimes(4);
      expect(mapped.files).toHaveLength(250);
      expect("filesTruncated" in mapped).toBe(false);
    });
  });

  it("retries once with a page of 10 after a 502 or 504, and only then", async () => {
    const ok = json({
      data: {
        repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 1, nodes: [gqlNode] } },
      },
    });
    for (const status of [502, 504]) {
      const http = vi.fn().mockResolvedValueOnce(new Response("bad gateway", { status })).mockResolvedValueOnce(ok.clone());
      const result = await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", "c1");

      expect(result.pullRequests).toHaveLength(1);
      const sizes = http.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).variables);
      expect(sizes).toEqual([
        { owner: "acme", name: "widgets", cursor: "c1", first: 25 },
        { owner: "acme", name: "widgets", cursor: "c1", first: 10 },
      ]);
    }
  });

  it("gives up after the smaller retry fails too, and does not retry other errors", async () => {
    const twice = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    await expect(new GitHubProvider(twice).fetchPullRequestPage("t", "acme", "widgets", null)).rejects.toMatchObject({
      status: 502,
    });
    expect(twice).toHaveBeenCalledTimes(2);

    const rejected = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(new GitHubProvider(rejected).fetchPullRequestPage("t", "acme", "widgets", null)).rejects.toMatchObject({
      status: 403,
    });
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("asks GitHub for the first 100 changed files of each pull request, with a cursor for the rest", async () => {
    const http = vi.fn(async () =>
      json({
        data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0, nodes: [] } } },
      }),
    );
    await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null);

    const [, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).query).toContain(
      "files(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { path } }",
    );
  });

  it("returns a null cursor on the last page and tolerates a PR with no commits", async () => {
    const http = vi.fn(async () =>
      json({
        data: {
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: "x" },
              totalCount: 1,
              nodes: [{ ...gqlNode, author: null, commits: { nodes: [] } }],
            },
          },
        },
      }),
    );
    const page = await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", "c1");
    expect(page.nextCursor).toBeNull();
    expect(page.pullRequests[0]).toMatchObject({ author: null, authorIsBot: false, firstCommitAt: null });
  });

  it("raises NotFoundError for an invisible repository and UpstreamError for GraphQL errors", async () => {
    const missing = new GitHubProvider(vi.fn(async () => json({ data: { repository: null } })));
    await expect(missing.fetchPullRequestPage("t", "acme", "secret", null)).rejects.toBeInstanceOf(NotFoundError);

    const broken = new GitHubProvider(
      vi.fn(async () =>
        json({
          data: { repository: { pullRequests: { pageInfo: {}, totalCount: 0, nodes: [] } } },
          errors: [{ message: "boom" }],
        }),
      ),
    );
    await expect(broken.fetchPullRequestPage("t", "acme", "widgets", null)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("maps HTTP statuses onto domain errors", async () => {
    await expect(new GitHubProvider(vi.fn(async () => json({}, 401))).fetchViewer("t")).rejects.toBeInstanceOf(UnauthorisedError);
    await expect(new GitHubProvider(vi.fn(async () => json({}, 404))).listWorkflows("t", "a", "b")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(new GitHubProvider(vi.fn(async () => json({}, 500))).fetchViewer("t")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("gives every request a 60 second timeout unless the caller brings its own signal", async () => {
    const http = vi.fn(async () => json({ login: "alice" }));
    await new GitHubProvider(http).fetchViewer("t");
    const [, init] = http.mock.calls[0] as unknown as [string, RequestInit];

    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("maps a timeout onto a 504, so the page readers retry it smaller", async () => {
    const timedOut = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    await expect(new GitHubProvider(timedOut).fetchViewer("t")).rejects.toMatchObject({
      name: "UpstreamError",
      status: 504,
      message: "GitHub did not answer within 60 seconds",
    });
    const retried = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockResolvedValueOnce(json({ data: { repository: { pullRequests: { pageInfo: {}, totalCount: 0, nodes: [] } } } }));
    await new GitHubProvider(retried).fetchPullRequestPage("t", "acme", "widgets", null);
    expect(retried).toHaveBeenCalledTimes(2);
  });

  it("lets other network failures through unchanged", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(new GitHubProvider(down).fetchViewer("t")).rejects.toBeInstanceOf(TypeError);
  });

  it("says when GitHub's rate limit lifts, from the reset header or the retry-after header", async () => {
    const limited = (status: number, headers: Record<string, string>) =>
      new GitHubProvider(vi.fn(async () => new Response("slow down", { status, headers }))).fetchViewer("t");

    await expect(limited(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1788000000" })).rejects.toMatchObject({
      name: "UpstreamError",
      status: 403,
      message: "GitHub's rate limit for this token was reached; try again after 2026-08-29T10:40:00.000Z",
    });

    vi.useFakeTimers({ now: new Date("2026-09-01T10:00:00Z") });
    try {
      await expect(limited(429, { "retry-after": "90" })).rejects.toMatchObject({
        status: 429,
        message: "GitHub's rate limit for this token was reached; try again after 2026-09-01T10:01:30.000Z",
      });
      // A secondary limit says how long to wait; that wins over the primary window's reset time.
      await expect(
        limited(403, { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1788000000" }),
      ).rejects.toMatchObject({
        message: "GitHub's rate limit for this token was reached; try again after 2026-09-01T10:01:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
    await expect(limited(403, { "x-ratelimit-remaining": "0" })).rejects.toMatchObject({
      message: "GitHub's rate limit for this token was reached; try again later",
    });
  });

  it("keeps the ordinary message for a 403 that is not a rate limit", async () => {
    const forbidden = new GitHubProvider(
      vi.fn(async () => new Response("no access", { status: 403, headers: { "x-ratelimit-remaining": "4999" } })),
    );

    await expect(forbidden.fetchViewer("t")).rejects.toMatchObject({ status: 403, message: "GitHub answered 403: no access" });
  });

  it("pages through workflow runs until a short page, within the cap", async () => {
    const restRun = (id: number) => ({
      id,
      head_branch: "main",
      status: "completed",
      conclusion: "success",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:05:00Z",
    });
    const pages = [Array.from({ length: 100 }, (_, i) => restRun(i)), [restRun(100)]];
    const http = vi.fn(async () => json({ workflow_runs: pages.shift() ?? [] }));

    const runs = await new GitHubProvider(http).fetchDeployRuns("t", "acme", "widgets", "deploy.yml");
    expect(runs).toHaveLength(101);
    expect(runs[0]).toEqual({
      runId: 0,
      workflow: "deploy.yml",
      branch: "main",
      status: "completed",
      conclusion: "success",
      createdAt: "2026-09-01T00:00:00Z",
      completedAt: "2026-09-01T00:05:00Z",
    });

    const capped = vi.fn(async () => json({ workflow_runs: Array.from({ length: 100 }, (_, i) => restRun(i)) }));
    expect(await new GitHubProvider(capped, 150).fetchDeployRuns("t", "a", "b", "d.yml")).toHaveLength(200);
    expect(capped).toHaveBeenCalledTimes(2);
  });

  it("lists workflow file names and reads the viewer", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(json({ workflows: [{ path: ".github/workflows/deploy.yml" }, { path: "" }] }))
      .mockResolvedValueOnce(json({ login: "alice", avatar_url: "https://a" }));
    const provider = new GitHubProvider(http);
    expect(await provider.listWorkflows("t", "acme", "widgets")).toEqual(["deploy.yml"]);
    expect(await provider.fetchViewer("t")).toEqual({ login: "alice", avatarUrl: "https://a" });
  });
});

describe("SqliteRepoStore", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("round-trips repositories, pull requests and deploy runs, and cascades a delete", () => {
    const store = new SqliteRepoStore(":memory:");
    const repo = store.addRepo("acme", "widgets", ["deploy.yml"], "main");
    store.upsertPullRequests(repo.id, [pr({ number: 1 }), pr({ number: 1, title: "edited" }), pr({ number: 2 })]);
    store.replaceDeployRuns(repo.id, [run({ runId: 1 }), run({ runId: 2 })]);

    expect(store.findRepo("ACME", "WIDGETS")?.id).toBe(repo.id);
    expect(store.pullRequests(repo.id).find((p) => p.number === 1)?.title).toBe("edited");
    expect(store.counts(repo.id)).toEqual({ pullRequests: 2, deployRuns: 2, issues: 0 });

    store.deleteRepo(repo.id);
    expect(store.getRepo(repo.id)).toBeNull();
    expect(store.counts(repo.id)).toEqual({ pullRequests: 0, deployRuns: 0, issues: 0 });
  });

  it("tracks crawl state and keeps the previous cursor when a crawl saw nothing", () => {
    const store = new SqliteRepoStore(":memory:");
    const { id } = store.addRepo("acme", "widgets", [], "main");
    store.setCrawlState(id, "crawling", "Reading");
    expect(store.getRepo(id)).toMatchObject({ crawlStatus: "crawling", crawlProgress: "Reading" });
    store.finishCrawl(id, "2026-09-01T00:00:00Z");
    store.finishCrawl(id, null);
    expect(store.crawlCursor(id)).toBe("2026-09-01T00:00:00Z");
    store.resetCrawlCursor(id);
    expect(store.crawlCursor(id)).toBeNull();
  });

  it("rolls back a batch that fails part way", () => {
    const store = new SqliteRepoStore(":memory:");
    const { id } = store.addRepo("acme", "widgets", [], "main");
    const bad = { ...pr({ number: 2 }), updatedAt: undefined as unknown as string };
    expect(() => store.upsertPullRequests(id, [pr({ number: 1 }), bad])).toThrow();
    expect(store.counts(id).pullRequests).toBe(0);
  });

  it("resets a crawl left running by a restart", () => {
    dir = mkdtempSync(join(tmpdir(), "dora-"));
    const path = join(dir, "nested", "dora.sqlite");
    const first = new SqliteRepoStore(path);
    const { id } = first.addRepo("acme", "widgets", [], "main");
    first.setCrawlState(id, "crawling", "Reading");

    expect(new SqliteRepoStore(path).getRepo(id)).toMatchObject({ crawlStatus: "idle", crawlProgress: null });
  });
});

describe("MemorySessionStore", () => {
  it("expires sessions after their lifetime", () => {
    let now = 1_000;
    const store = new MemorySessionStore(100, () => now);
    const id = store.create({ token: "t", login: "a", avatarUrl: "" });
    expect(store.get(id)?.token).toBe("t");
    now = 1_100;
    expect(store.get(id)).toBeNull();
    expect(store.get("unknown")).toBeNull();
  });
});

describe("GhCliTokenSource", () => {
  it("resolves the viewer once and caches it", async () => {
    const read = vi.fn(async () => "gho_local");
    const source = new GhCliTokenSource(new FakeProvider(), read, () => 0);
    expect(await source.session()).toMatchObject({ token: "gho_local", login: "user-of-gho_local" });
    await source.session();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("explains a missing login whether gh fails or prints nothing", async () => {
    await expect(new GhCliTokenSource(new FakeProvider(), async () => "").session()).rejects.toThrow("gh auth login");
    await expect(
      new GhCliTokenSource(new FakeProvider(), async () => {
        throw new Error("not logged in");
      }).session(),
    ).rejects.toBeInstanceOf(UnauthorisedError);
  });
});

describe("loadConfig", () => {
  it("defaults to the CLI login, a repo-root database and a random session secret", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ authMode: "gh-cli", port: 8787, webOrigin: "http://localhost:5181" });
    expect(config.databasePath).toMatch(/data[/\\]dora\.sqlite$/);
    expect(config.sessionSecret.length).toBeGreaterThan(20);
  });

  it.each([
    [{ ATLASSIAN_CLIENT_ID: "a" }],
    [{ ATLASSIAN_CLIENT_SECRET: "b" }],
    [{ ATLASSIAN_CLIENT_ID: "a", ATLASSIAN_CLIENT_SECRET: "" }],
  ])("refuses to start with only one Atlassian credential %j", (env) => {
    expect(() => loadConfig(env)).toThrow("ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET");
  });

  it("derives the Jira callback from the web origin unless one is given", () => {
    expect(loadConfig({ ATLASSIAN_CLIENT_ID: "a", ATLASSIAN_CLIENT_SECRET: "b" }).jira?.redirectUri).toBe(
      "http://localhost:5181/api/auth/jira/callback",
    );
    expect(
      loadConfig({ WEB_ORIGIN: "https://dora.example.test", ATLASSIAN_CLIENT_ID: "a", ATLASSIAN_CLIENT_SECRET: "b" }).jira
        ?.redirectUri,
    ).toBe("https://dora.example.test/api/auth/jira/callback");
    expect(
      loadConfig({
        WEB_ORIGIN: "https://dora.example.test",
        ATLASSIAN_REDIRECT_URI: "https://other.example.test/cb",
        ATLASSIAN_CLIENT_ID: "a",
        ATLASSIAN_CLIENT_SECRET: "b",
      }).jira?.redirectUri,
    ).toBe("https://other.example.test/cb");
  });

  it("treats blank values as unset", () => {
    expect(loadConfig({ PORT: "", DATABASE_PATH: "", AUTH_MODE: "" }).port).toBe(8787);
  });

  it("requires OAuth credentials and a real secret in OAuth mode, and rejects an unknown mode", () => {
    expect(() => loadConfig({ AUTH_MODE: "oauth" })).toThrow("GITHUB_CLIENT_ID");
    expect(() => loadConfig({ AUTH_MODE: "oauth", GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b" })).toThrow("SESSION_SECRET");
    expect(() => loadConfig({ AUTH_MODE: "password" })).toThrow("AUTH_MODE");
    expect(
      loadConfig({ AUTH_MODE: "oauth", GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b", SESSION_SECRET: "s".repeat(32) })
        .authMode,
    ).toBe("oauth");
  });
});

describe("GitHubProvider open pull requests", () => {
  const openNode = {
    ...gqlNode,
    state: "OPEN",
    mergedAt: null,
    closedAt: null,
    author: { login: "alice", __typename: "User" },
    changedFiles: 7,
    headRefName: "feature/WID-3-widgets",
    isDraft: true,
    body: "Related: #4",
    latest: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
    reviewRequests: {
      nodes: [
        { requestedReviewer: { __typename: "User", login: "bob" } },
        { requestedReviewer: { __typename: "Team", name: "platform" } },
        { requestedReviewer: null },
        null,
      ],
    },
    closingIssuesReferences: {
      nodes: [
        { number: 12, repository: { nameWithOwner: "acme/widgets" } },
        { number: 7, repository: { nameWithOwner: "acme/gadgets" } },
        { number: 9 },
        null,
      ],
    },
    labels: { nodes: [{ name: "on hold" }] },
  };
  const connection = (nodes: unknown[], next: string | null = null) => ({
    data: {
      repository: {
        pullRequests: { pageInfo: { hasNextPage: next !== null, endCursor: next }, totalCount: nodes.length, nodes },
      },
    },
  });
  const variablesOf = (http: ReturnType<typeof vi.fn>) =>
    http.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as { query: string; variables: object });

  it("maps drafts, requested reviewers, checks, head branch, linked issues and files", async () => {
    const http = vi.fn(async () => json(connection([openNode])));
    const [mapped] = (await new GitHubProvider(http).fetchOpenPullRequests("t", "acme", "widgets")).pullRequests;

    expect(mapped).toMatchObject({
      number: 12,
      state: "OPEN",
      isDraft: true,
      headRef: "feature/WID-3-widgets",
      checks: "failing",
      changedFiles: 7,
      body: "Related: #4",
      linkedIssues: ["acme/widgets#12", "acme/gadgets#7", "acme/widgets#9"],
      labels: ["on hold"],
      requestedReviewers: [
        { name: "bob", isTeam: false },
        { name: "platform", isTeam: true },
      ],
    });
    expect(variablesOf(http)[0]!.query).toContain("states: OPEN");
  });

  it.each([
    ["SUCCESS", "passing"],
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
    ["ERROR", "failing"],
    ["SOMETHING_NEW", "none"],
  ])("maps the check rollup %s to %s", async (state, checks) => {
    const node = { ...openNode, latest: { nodes: [{ commit: { statusCheckRollup: { state } } }] } };
    const http = vi.fn(async () => json(connection([node])));
    expect((await new GitHubProvider(http).fetchOpenPullRequests("t", "acme", "widgets")).pullRequests[0]!.checks).toBe(checks);
  });

  it("copes with a pull request that reports no optional fields", async () => {
    const { headRefName: _head, ...bare } = gqlNode;
    const http = vi.fn(async () => json(connection([{ ...bare, state: "OPEN" }])));
    const [mapped] = (await new GitHubProvider(http).fetchOpenPullRequests("t", "acme", "widgets")).pullRequests;
    expect(mapped).toMatchObject({
      isDraft: false,
      headRef: "",
      checks: "none",
      changedFiles: 0,
      requestedReviewers: [],
      linkedIssues: [],
    });
    expect("body" in mapped!).toBe(false);
  });

  it("pages to the end, passing each cursor on", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(json(connection([openNode], "c1")))
      .mockResolvedValueOnce(json(connection([{ ...openNode, number: 13 }])));
    const all = await new GitHubProvider(http).fetchOpenPullRequests("t", "acme", "widgets");
    expect(all.pullRequests.map((p) => p.number)).toEqual([12, 13]);
    expect(all.truncated).toBe(false);
    expect(variablesOf(http).map((v) => v.variables)).toEqual([
      { owner: "acme", name: "widgets", cursor: null, first: 50 },
      { owner: "acme", name: "widgets", cursor: "c1", first: 50 },
    ]);
  });

  it("stops after ten pages rather than reading without end, and says it was cut short", async () => {
    const http = vi.fn(async () => json(connection([openNode], "more")));
    const result = await new GitHubProvider(http).fetchOpenPullRequests("t", "acme", "widgets");
    expect(result.pullRequests).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(http).toHaveBeenCalledTimes(10);
  });

  it("does not call a read truncated when the last page is exactly the tenth", async () => {
    const http = vi.fn();
    for (let i = 0; i < 9; i++) http.mockResolvedValueOnce(json(connection([openNode], "more")));
    http.mockResolvedValueOnce(json(connection([openNode])));
    expect((await new GitHubProvider(http).fetchOpenPullRequests("t", "acme", "widgets")).truncated).toBe(false);
  });

  it("reads the latest 100 reviews and whether each reviewer is a bot", async () => {
    const node = {
      ...openNode,
      reviews: {
        nodes: [
          { author: { login: "ci-helper", __typename: "Bot" }, state: "APPROVED", submittedAt: "2026-09-01T10:30:00Z" },
          { author: { login: "bob", __typename: "User" }, state: "COMMENTED", submittedAt: "2026-09-01T10:40:00Z" },
          { author: { login: "sam" }, state: "COMMENTED", submittedAt: "2026-09-01T10:50:00Z" },
        ],
      },
    };
    const http = vi.fn(async () => json(connection([node])));
    const [mapped] = (await new GitHubProvider(http).fetchOpenPullRequests("t", "acme", "widgets")).pullRequests;
    expect(variablesOf(http)[0]!.query).toContain("reviews(last: 100) { nodes { author { login __typename }");
    expect(mapped!.reviews.map((r) => r.authorIsBot)).toEqual([true, false, undefined]);
    expect("authorIsBot" in mapped!.reviews[2]!).toBe(false);
  });

  it("retries a gateway timeout with a smaller page, and gives up on other failures", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow", { status: 504 }))
      .mockResolvedValueOnce(json(connection([openNode])));
    await new GitHubProvider(http).fetchOpenPullRequests("t", "acme", "widgets");
    expect(variablesOf(http).map((v) => (v.variables as { first: number }).first)).toEqual([50, 20]);

    const refused = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(new GitHubProvider(refused).fetchOpenPullRequests("t", "acme", "widgets")).rejects.toMatchObject({
      status: 403,
    });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("raises NotFoundError for a repository it cannot see and UpstreamError for GraphQL errors", async () => {
    const missing = new GitHubProvider(vi.fn(async () => json({ data: { repository: null } })));
    await expect(missing.fetchOpenPullRequests("t", "acme", "nope")).rejects.toBeInstanceOf(NotFoundError);
    const broken = new GitHubProvider(vi.fn(async () => json({ ...connection([]), errors: [{ message: "boom" }] })));
    await expect(broken.fetchOpenPullRequests("t", "acme", "widgets")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("reports a rate limit that arrives with a null pull request page as an upstream error, not as not found", async () => {
    const limited = new GitHubProvider(
      vi.fn(async () => json({ data: { repository: null }, errors: [{ message: "API rate limit exceeded" }] })),
    );

    await expect(limited.fetchPullRequestPage("t", "acme", "widgets", null)).rejects.toMatchObject({
      name: "UpstreamError",
      message: "API rate limit exceeded",
    });
  });

  it("still reports a NOT_FOUND on the repository path as not found when reading a pull request page", async () => {
    const gone = new GitHubProvider(
      vi.fn(async () =>
        json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve" }] }),
      ),
    );

    await expect(gone.fetchPullRequestPage("t", "acme", "widgets", null)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports a rate limit that arrives with a null repository as an upstream error, not as not found", async () => {
    const limited = new GitHubProvider(
      vi.fn(async () => json({ data: { repository: null }, errors: [{ message: "API rate limit exceeded" }] })),
    );
    await expect(limited.fetchOpenPullRequests("t", "acme", "widgets")).rejects.toMatchObject({
      name: "UpstreamError",
      message: "API rate limit exceeded",
    });
  });
});

describe("tracker and upstream errors", () => {
  it("names a tracker authorisation failure for what it is while still being an unauthorised error", async () => {
    const { TrackerUnauthorisedError, UnauthorisedError: Unauthorised } = await import("../src/core/errors.js");
    const error = new TrackerUnauthorisedError("expired");
    expect(error.name).toBe("TrackerUnauthorisedError");
    expect(error).toBeInstanceOf(Unauthorised);
    expect(new Unauthorised("x").name).toBe("UnauthorisedError");
  });

  it("lets an upstream error carry its cause, and works without one", async () => {
    const { UpstreamError: Upstream } = await import("../src/core/errors.js");
    const cause = new Error("socket closed");
    expect(new Upstream("down", 502, { cause }).cause).toBe(cause);
    const plain = new Upstream("down", 503);
    expect(plain.status).toBe(503);
    expect(plain.cause).toBeUndefined();
  });
});
