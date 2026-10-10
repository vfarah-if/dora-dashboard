import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { CoverageArtefact } from "@dora-dashboard/core";
import { NotFoundError, UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { download, throwForStatus } from "../src/infrastructure/github/github-http.js";
import { GitHubCoverageSource, MAX_ARTEFACT_BYTES } from "../src/infrastructure/github/github-coverage-source.js";

const TOKEN = "ghp_secret_token_value";
const SIGNED = "https://artefacts.example.test/acme-widgets/zip?sig=signed-value";
const json = (body: unknown, status = 200, headers: { [key: string]: string } = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const redirect = (location: string | null, status = 302) =>
  new Response(null, { status, headers: location === null ? {} : { location } });

const run = (over: object = {}) => ({
  id: 900,
  repository_id: 1,
  head_repository_id: 1,
  head_branch: "main",
  head_sha: "a".repeat(40),
  ...over,
});
const artefact = (over: { [key: string]: unknown } = {}) => ({
  id: 1,
  name: "coverage-web",
  size_in_bytes: 2048,
  expired: false,
  created_at: "2026-10-01T10:00:00Z",
  workflow_run: run(),
  ...over,
});
const listing = (artifacts: unknown[]) => json({ total_count: artifacts.length, artifacts });

const LCOV = "SF:/home/runner/work/widgets/widgets/src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n";
const archive = () => zipSync({ "coverage/lcov.info": strToU8(LCOV) });

const headersOf = (http: ReturnType<typeof vi.fn>, call: number) =>
  Object.fromEntries(
    Object.entries((http.mock.calls[call]![1] as RequestInit).headers as Record<string, string>).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
const urlOf = (http: ReturnType<typeof vi.fn>, call: number) => String(http.mock.calls[call]![0]);

const find = (http: typeof fetch, branch = "main") =>
  new GitHubCoverageSource(http).findArtefacts(TOKEN, "acme", "widgets", branch);
const stored: CoverageArtefact = {
  id: 7,
  name: "coverage-web",
  sizeBytes: 2048,
  createdAt: "2026-10-01T10:00:00Z",
  runId: 900,
  commitSha: "a".repeat(40),
};
const read = (http: typeof fetch, of: CoverageArtefact = stored) =>
  new GitHubCoverageSource(http).readArtefact(TOKEN, "acme", "widgets", of);

/** Runs a call that must fail and returns what it raised, so the message can be checked. */
const failure = async (call: Promise<unknown>): Promise<Error> => {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

describe("GitHubCoverageSource.findArtefacts", () => {
  it("maps an artefact onto core's shape and asks for 100 a page", async () => {
    const http = vi.fn(async () => listing([artefact()]));

    expect(await find(http)).toEqual([
      { id: 1, name: "coverage-web", sizeBytes: 2048, createdAt: "2026-10-01T10:00:00Z", runId: 900, commitSha: "a".repeat(40) },
    ]);
    expect(urlOf(http, 0)).toBe("https://api.github.com/repos/acme/widgets/actions/artifacts?per_page=100&page=1");
    expect(headersOf(http, 0).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("lists newest first", async () => {
    const http = vi.fn(async () =>
      listing([
        artefact({ id: 1, created_at: "2026-09-01T10:00:00Z" }),
        artefact({ id: 2, created_at: "2026-10-03T10:00:00Z" }),
        artefact({ id: 3, created_at: "2026-09-20T10:00:00Z" }),
      ]),
    );

    expect((await find(http)).map((a) => a.id)).toEqual([2, 3, 1]);
  });

  it("matches the name in any letter case and leaves out other artefacts", async () => {
    const http = vi.fn(async () =>
      listing([
        artefact({ id: 1, name: "Test-COVERAGE" }),
        artefact({ id: 2, name: "dist" }),
        artefact({ id: 3, name: "build-logs" }),
      ]),
    );

    expect((await find(http)).map((a) => a.id)).toEqual([1]);
  });

  it("leaves out expired artefacts, other branches and runs from forks", async () => {
    const http = vi.fn(async () =>
      listing([
        artefact({ id: 1 }),
        artefact({ id: 2, expired: true }),
        artefact({ id: 3, workflow_run: run({ head_branch: "feature/x" }) }),
        artefact({ id: 4, workflow_run: run({ head_repository_id: 99 }) }),
      ]),
    );

    expect((await find(http)).map((a) => a.id)).toEqual([1]);
  });

  it.each([
    ["no run", { workflow_run: null }],
    ["a run with no branch", { workflow_run: run({ head_branch: null }) }],
    ["a run with no commit", { workflow_run: run({ head_sha: undefined }) }],
    ["a run with no id", { workflow_run: run({ id: undefined }) }],
    ["no repository id", { workflow_run: run({ repository_id: undefined, head_repository_id: undefined }) }],
    ["no head repository id", { workflow_run: run({ head_repository_id: undefined }) }],
    ["no creation time", { created_at: null }],
    ["no id", { id: undefined }],
    ["no name", { name: undefined }],
  ])("leaves out an artefact with %s", async (_label, over) => {
    const http = vi.fn(async () => listing([artefact(over)]));

    expect(await find(http)).toEqual([]);
  });

  it("reads a missing size as zero", async () => {
    const http = vi.fn(async () => listing([artefact({ size_in_bytes: undefined })]));

    expect((await find(http))[0]!.sizeBytes).toBe(0);
  });

  it("answers an empty list, not an error, when nothing matches or the body has no list", async () => {
    expect(await find(vi.fn(async () => listing([])))).toEqual([]);
    expect(await find(vi.fn(async () => json({})))).toEqual([]);
  });

  it("reads at most three pages and returns what it has", async () => {
    const full = (offset: number) => listing(Array.from({ length: 100 }, (_, i) => artefact({ id: offset + i })));
    const http = vi.fn(async (url: string | URL | Request) =>
      full(String(url).includes("page=2") ? 100 : String(url).includes("page=3") ? 200 : 0),
    );

    const found = await find(http);

    expect(http).toHaveBeenCalledTimes(3);
    expect(found).toHaveLength(300);
    expect(urlOf(http, 2)).toContain("page=3");
  });

  it("stops at a page with fewer than 100", async () => {
    const http = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("&page=1")
        ? listing(Array.from({ length: 100 }, (_, i) => artefact({ id: i })))
        : listing([artefact({ id: 500 })]),
    );

    expect(await find(http)).toHaveLength(101);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("encodes the owner and name in the address", async () => {
    const http = vi.fn(async () => listing([]));

    await new GitHubCoverageSource(http).findArtefacts(TOKEN, "a/b", "c d", "main");

    expect(urlOf(http, 0)).toContain("/repos/a%2Fb/c%20d/actions/artifacts");
  });

  it("uses the base URL it was given", async () => {
    const http = vi.fn(async () => listing([]));

    await new GitHubCoverageSource(http, "https://github.example.test/api/v3").findArtefacts(TOKEN, "acme", "widgets", "main");

    expect(urlOf(http, 0)).toMatch(/^https:\/\/github\.example\.test\/api\/v3\/repos\/acme\/widgets\//);
  });

  describe("errors", () => {
    it("maps 401 to UnauthorisedError", async () => {
      expect(await failure(find(vi.fn(async () => json({}, 401))))).toBeInstanceOf(UnauthorisedError);
    });

    it("maps 404 to NotFoundError", async () => {
      expect(await failure(find(vi.fn(async () => json({}, 404))))).toBeInstanceOf(NotFoundError);
    });

    it("says a fine-grained token needs read access to Actions on a 403 that is not a rate limit", async () => {
      const error = await failure(
        find(vi.fn(async () => json({ message: "Resource not accessible by personal access token" }, 403))),
      );

      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).status).toBe(403);
      expect(error.message).toMatch(/fine-grained token needs read access to Actions/);
    });

    it("keeps the rate limit message for a 403 that is a rate limit", async () => {
      const error = await failure(
        find(vi.fn(async () => json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" }))),
      );

      expect(error).toBeInstanceOf(UpstreamError);
      expect(error.message).toMatch(/rate limit/);
      expect(error.message).not.toMatch(/fine-grained/);
    });

    it("raises UpstreamError for any other status", async () => {
      const error = await failure(find(vi.fn(async () => json({ message: "boom" }, 500))));

      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).status).toBe(500);
    });

    it("never puts the token in a message", async () => {
      for (const status of [401, 403, 404, 500]) {
        const error = await failure(find(vi.fn(async () => json({}, status))));
        expect(error.message).not.toContain(TOKEN);
      }
    });
  });
});

describe("GitHubCoverageSource.readArtefact", () => {
  const happy = () =>
    vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).startsWith("https://api.github.com") ? redirect(SIGNED) : new Response(archive()),
    );

  it("downloads through the redirect and returns the reports with the artefact's name", async () => {
    const http = happy();

    const reports = await read(http);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ format: "lcov", artefact: "coverage-web", dir: "coverage" });
    expect(reports[0]!.files[0]).toMatchObject({ lines: { covered: 1, total: 2 } });
    expect(urlOf(http, 0)).toBe("https://api.github.com/repos/acme/widgets/actions/artifacts/7/zip");
  });

  it("sends the token to the API host only, never to the address it is redirected to", async () => {
    const http = happy();

    await read(http);

    expect(http).toHaveBeenCalledTimes(2);
    expect(headersOf(http, 0).authorization).toBe(`Bearer ${TOKEN}`);
    expect(urlOf(http, 1)).toBe(SIGNED);
    expect(headersOf(http, 1)).not.toHaveProperty("authorization");
    expect(JSON.stringify(http.mock.calls[1])).not.toContain(TOKEN);
  });

  it("follows no redirect by itself", async () => {
    const http = happy();

    await read(http);

    for (const call of http.mock.calls) expect((call[1] as RequestInit).redirect).toBe("manual");
  });

  it("refuses an artefact over the size limit before downloading anything", async () => {
    const http = happy();

    const error = await failure(read(http, { ...stored, sizeBytes: MAX_ARTEFACT_BYTES + 1 }));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(http).not.toHaveBeenCalled();
  });

  it("maps 410 on the API host and on the storage host to NotFoundError", async () => {
    expect(await failure(read(vi.fn(async () => new Response(null, { status: 410 }))))).toBeInstanceOf(NotFoundError);
    const gone = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith("https://api.github.com") ? redirect(SIGNED) : new Response(null, { status: 410 }),
    );
    expect(await failure(read(gone))).toBeInstanceOf(NotFoundError);
  });

  it("maps 401 and 404 from the API host", async () => {
    expect(await failure(read(vi.fn(async () => json({}, 401))))).toBeInstanceOf(UnauthorisedError);
    expect(await failure(read(vi.fn(async () => json({}, 404))))).toBeInstanceOf(NotFoundError);
  });

  it("explains a 403 that is not a rate limit, and keeps the token out of every message", async () => {
    const error = await failure(read(vi.fn(async () => json({ message: "denied" }, 403))));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toMatch(/fine-grained token needs read access to Actions/);
    for (const status of [401, 403, 404, 410, 500]) {
      const other = await failure(read(vi.fn(async () => new Response("body", { status }))));
      expect(other.message).not.toContain(TOKEN);
    }
  });

  it("raises UpstreamError for an archive that is not a zip", async () => {
    const http = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith("https://api.github.com") ? redirect(SIGNED) : new Response("not a zip at all"),
    );

    expect(await failure(read(http))).toBeInstanceOf(UpstreamError);
  });
});

describe("download", () => {
  const get = (http: typeof fetch, max = 1000) => download(http, TOKEN, "https://api.github.com/x/zip", max);
  const viaRedirect = (second: () => Response) =>
    vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith("https://api.github.com") ? redirect(SIGNED) : second(),
    );

  it("returns the bytes of a direct answer, with no second request", async () => {
    const http = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));

    expect([...(await get(http))]).toEqual([1, 2, 3]);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array for an empty body", async () => {
    expect((await get(vi.fn(async () => new Response(null, { status: 200 })))).length).toBe(0);
  });

  it.each([301, 303, 307, 308])("follows a %s redirect", async (status) => {
    const http = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith("https://api.github.com") ? redirect(SIGNED, status) : new Response(new Uint8Array([9])),
    );

    expect([...(await get(http))]).toEqual([9]);
  });

  it("cancels the body of the redirect response before it makes the second request", async () => {
    const events: string[] = [];
    const body = new ReadableStream<Uint8Array>({ cancel: () => void events.push("cancelled") });
    const http = vi.fn(async (url: string | URL | Request) => {
      events.push(String(url).startsWith("https://api.github.com") ? "first" : "second");
      return String(url).startsWith("https://api.github.com")
        ? new Response(body, { status: 302, headers: { location: SIGNED } })
        : new Response(new Uint8Array([9]));
    });

    await get(http);

    expect(events).toEqual(["first", "cancelled", "second"]);
  });

  it("refuses a Location that is not https, and sends nothing to it", async () => {
    const http = vi.fn(async () => redirect("http://artefacts.example.test/zip"));

    const error = await failure(get(http));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).not.toContain("artefacts.example.test");
    expect(http).toHaveBeenCalledTimes(1);
  });

  it.each([[null], ["https://"]])("refuses a redirect whose Location is %s", async (location) => {
    const http = vi.fn(async () => redirect(location));

    expect(await failure(get(http))).toBeInstanceOf(UpstreamError);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("refuses a declared length over the limit without reading the body", async () => {
    const http = viaRedirect(() => new Response(new Uint8Array(10), { headers: { "content-length": "5000" } }));

    expect(await failure(get(http, 1000))).toBeInstanceOf(UpstreamError);
  });

  it("stops streaming past the limit when no length is declared", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(400));
        if (pulled > 50) controller.close();
      },
    });
    const http = viaRedirect(() => new Response(body));

    const error = await failure(get(http, 1000));

    expect(error).toBeInstanceOf(UpstreamError);
    // 400 bytes a chunk: the third chunk passes 1,000, and the stream is cancelled rather than drained.
    expect(pulled).toBeLessThan(10);
  });

  it("accepts a body of exactly the limit, assembled from several chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(500).fill(1));
        controller.enqueue(new Uint8Array(500).fill(2));
        controller.close();
      },
    });

    const bytes = await get(
      viaRedirect(() => new Response(body)),
      1000,
    );

    expect(bytes).toHaveLength(1000);
    expect([bytes[0], bytes[999]]).toEqual([1, 2]);
  });

  it("maps a storage 404 to NotFoundError and another failure to UpstreamError without the address", async () => {
    expect(await failure(get(viaRedirect(() => new Response(null, { status: 404 }))))).toBeInstanceOf(NotFoundError);
    const error = await failure(get(viaRedirect(() => new Response("<Error>sig=signed-value</Error>", { status: 403 }))));
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toBe("GitHub's artefact storage answered 403");
  });

  it("does not follow a second redirect", async () => {
    const http = viaRedirect(() => redirect("https://elsewhere.example.test/zip"));

    const error = await failure(get(http));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(http).toHaveBeenCalledTimes(2);
  });

  it("reports a network failure without the address or the token", async () => {
    const http = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${SIGNED} with ${TOKEN}`);
    });

    const error = await failure(get(http));

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).not.toContain("signed-value");
    expect(error.message).not.toContain(TOKEN);
  });

  it("reports a timeout as a gateway timeout", async () => {
    const http = vi.fn(async () => {
      throw Object.assign(new Error("took too long"), { name: "TimeoutError" });
    });

    const error = await failure(get(http));

    expect((error as UpstreamError).status).toBe(504);
  });
});

describe("throwForStatus", () => {
  it("returns for a success", async () => {
    await expect(throwForStatus(new Response("{}"))).resolves.toBeUndefined();
  });

  it("keeps the mapping that request has always had", async () => {
    expect(await failure(throwForStatus(new Response(null, { status: 401 })))).toBeInstanceOf(UnauthorisedError);
    expect(await failure(throwForStatus(new Response(null, { status: 404 })))).toBeInstanceOf(NotFoundError);
    const limited = await failure(throwForStatus(new Response(null, { status: 429, headers: { "retry-after": "30" } })));
    expect(limited.message).toMatch(/^GitHub's rate limit for this token was reached; try again after /);
    const other = await failure(throwForStatus(new Response("x".repeat(500), { status: 500 })));
    expect(other.message).toBe(`GitHub answered 500: ${"x".repeat(300)}`);
  });
});
