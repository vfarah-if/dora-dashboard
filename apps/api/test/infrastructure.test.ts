import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { NotFoundError, UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { GhCliTokenSource } from "../src/infrastructure/auth/gh-cli-token-source.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { GitHubProvider } from "../src/infrastructure/github/github-provider.js";
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
  author: { login: "renovate", __typename: "Bot" },
  mergedBy: null,
  commits: { nodes: [{ commit: { authoredDate: "2026-09-01T08:00:00Z", committedDate: "2026-09-01T09:30:00Z" } }] },
  reviews: { nodes: [{ author: null, state: "APPROVED", submittedAt: "2026-09-01T10:30:00Z" }] },
};

describe("GitHubProvider", () => {
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
      reviews: [{ author: null, state: "APPROVED" }],
    });
    const [, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
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
    const fetchOne = async (files: object) =>
      (await new GitHubProvider(page({ ...gqlNode, files })).fetchPullRequestPage("t", "acme", "widgets", null)).pullRequests[0]!;
    const paths = Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.ts` }));

    const over = await fetchOne({ totalCount: 101, nodes: paths });
    const exactly = await fetchOne({ totalCount: 100, nodes: paths });

    expect(over.filesTruncated).toBe(true);
    expect(over.files).toHaveLength(100);
    expect("filesTruncated" in exactly).toBe(false);
  });

  it("retries once with a page of 25 after a 502 or 504, and only then", async () => {
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
        { owner: "acme", name: "widgets", cursor: "c1", first: 50 },
        { owner: "acme", name: "widgets", cursor: "c1", first: 25 },
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

  it("asks GitHub for the first 100 changed files of each pull request", async () => {
    const http = vi.fn(async () =>
      json({
        data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0, nodes: [] } } },
      }),
    );
    await new GitHubProvider(http).fetchPullRequestPage("t", "acme", "widgets", null);

    const [, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).query).toContain("files(first: 100) { totalCount nodes { path } }");
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
    expect(store.counts(repo.id)).toEqual({ pullRequests: 2, deployRuns: 2 });

    store.deleteRepo(repo.id);
    expect(store.getRepo(repo.id)).toBeNull();
    expect(store.counts(repo.id)).toEqual({ pullRequests: 0, deployRuns: 0 });
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
