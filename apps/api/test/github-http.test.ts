import { describe, expect, it, vi } from "vitest";
import { UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { RATE_LIMIT_MESSAGE, nextLink, request, requestPage } from "../src/infrastructure/github/github-http.js";

const FROM = "https://api.github.com/repos/acme/widgets/dependabot/alerts?per_page=100";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("nextLink", () => {
  const next = (url: string) => ({ kind: "next", url });

  it("finds the next address among several relations", () => {
    const header = `<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next", <https://api.github.com/x?page=9>; rel="last"`;
    expect(nextLink(header, FROM)).toEqual(next("https://api.github.com/x?page=3"));
  });

  it("reads a next relation that is not quoted or is followed by other parameters", () => {
    expect(nextLink("<https://api.github.com/x?page=2>; rel=next", FROM)).toEqual(next("https://api.github.com/x?page=2"));
    expect(nextLink(`<https://api.github.com/x?page=2>; rel="next"; title="more"`, FROM)).toEqual(
      next("https://api.github.com/x?page=2"),
    );
  });

  it("resolves a relative address against the page it came from", () => {
    expect(nextLink(`</repos/acme/widgets/x?page=2>; rel="next"`, FROM)).toEqual(
      next("https://api.github.com/repos/acme/widgets/x?page=2"),
    );
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["no next relation", `<https://api.github.com/x?page=1>; rel="prev"`],
  ])("says the list ended for %s", (_label, header) => {
    expect(nextLink(header, FROM)).toEqual({ kind: "none" });
  });

  it.each([
    ["another host", `<https://evil.example.test/x?page=2>; rel="next"`],
    ["a host that only starts like ours", `<https://api.github.com.evil.example.test/x>; rel="next"`],
    ["a host with credentials that read like ours", `<https://api.github.com@evil.example.test/x>; rel="next"`],
    ["http", `<http://api.github.com/x?page=2>; rel="next"`],
    ["another port", `<https://api.github.com:444/x?page=2>; rel="next"`],
    ["a scheme that is not http", `<javascript:alert(1)>; rel="next"`],
    ["an address that cannot be read", `<https://>; rel="next"`],
    ["a header over 4 KiB", `<https://api.github.com/x?page=2>; rel="next"${" ".repeat(4100)}`],
  ])("says the next page was refused, not that the list ended, for %s", (_label, header) => {
    expect(nextLink(header, FROM)).toEqual({ kind: "refused" });
  });
});

describe("redirects", () => {
  const redirect = (location: string | null, status = 301) =>
    new Response(null, { status, headers: location === null ? {} : { location } });
  const URL_ = "https://api.github.com/repos/acme/widgets/pulls";
  const calls = (http: ReturnType<typeof vi.fn>) => http.mock.calls as [string, RequestInit][];

  it("follows GitHub's same-origin redirect for a renamed repository, sending the token and refusing to let fetch follow", async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(redirect("https://api.github.com/repositories/42/pulls"))
      .mockResolvedValueOnce(json({ ok: true }));

    expect(await request(http, "tok", URL_)).toEqual({ ok: true });

    expect(calls(http).map(([url]) => url)).toEqual([URL_, "https://api.github.com/repositories/42/pulls"]);
    for (const [, init] of calls(http)) {
      expect(init.redirect).toBe("manual");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    }
  });

  it("resolves a relative location against the address that redirected", async () => {
    const http = vi.fn().mockResolvedValueOnce(redirect("/repositories/42/pulls", 307)).mockResolvedValueOnce(json([]));
    await request(http, "tok", URL_);
    expect(calls(http)[1]![0]).toBe("https://api.github.com/repositories/42/pulls");
  });

  it("repeats a POST on a 307 and turns it into a GET on a 303", async () => {
    const post = { method: "POST", body: "{}" };
    const same = vi.fn().mockResolvedValueOnce(redirect("/x", 307)).mockResolvedValueOnce(json({}));
    await request(same, "tok", URL_, post);
    expect(calls(same)[1]![1]).toMatchObject(post);

    const other = vi.fn().mockResolvedValueOnce(redirect("/x", 303)).mockResolvedValueOnce(json({}));
    await request(other, "tok", URL_, post);
    expect(calls(other)[1]![1]).toMatchObject({ method: "GET", body: null });
  });

  it.each([
    ["another host", "https://evil.example.test/steal"],
    ["a different port", "https://api.github.com:8443/x"],
    ["plain http", "http://api.github.com/x"],
    ["a scheme that is not http", "file:///etc/passwd"],
    ["an address that cannot be parsed", "http://[bad"],
  ])("raises, without a second request, for a redirect to %s", async (_name, location) => {
    const http = vi.fn().mockResolvedValue(redirect(location));
    const error = await request(http, "tok", URL_).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as Error).message).not.toContain("evil");
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("raises for a redirect that names no location", async () => {
    await expect(request(vi.fn().mockResolvedValue(redirect(null)), "tok", URL_)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("follows at most three redirects", async () => {
    const forever = vi.fn().mockImplementation(async () => redirect("/again"));
    await expect(request(forever, "tok", URL_)).rejects.toThrow("too many times");
    expect(forever).toHaveBeenCalledTimes(4);

    const three = vi
      .fn()
      .mockResolvedValueOnce(redirect("/a"))
      .mockResolvedValueOnce(redirect("/b"))
      .mockResolvedValueOnce(redirect("/c"))
      .mockResolvedValueOnce(json({ done: true }));
    expect(await request(three, "tok", URL_)).toEqual({ done: true });
  });

  it("applies to a page read too", async () => {
    const http = vi.fn().mockResolvedValue(redirect("https://evil.example.test/x"));
    await expect(requestPage(http, "tok", FROM, [403])).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("reading a reply", () => {
  it("raises an UpstreamError, not a SyntaxError, for a page that is not JSON", async () => {
    const error = await requestPage(
      vi.fn(async () => new Response("<html>", { status: 200 })),
      "t",
      FROM,
      [],
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ status: 502, message: "GitHub sent a reply that is not valid JSON" });
    await expect(
      request(
        vi.fn(async () => new Response("{", { status: 200 })),
        "t",
        FROM,
      ),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("refuses a page that declares more than 16 MiB, or streams more", async () => {
    const declared = new Response("[]", { status: 200, headers: { "content-length": String(17 * 1024 * 1024) } });
    await expect(
      requestPage(
        vi.fn(async () => declared),
        "t",
        FROM,
        [],
      ),
    ).rejects.toThrow("larger than the limit");
    const streamed = new Response(new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]).stream(), { status: 200 });
    await expect(
      request(
        vi.fn(async () => streamed),
        "t",
        FROM,
      ),
    ).rejects.toThrow("larger than the limit");
  });
});

describe("error replies", () => {
  const failed = (response: Response) =>
    request<never>(
      vi.fn(async () => response),
      "tok",
      FROM,
    ).catch((e: unknown) => e as UpstreamError) as Promise<UpstreamError>;

  it("keeps GitHub's message only when it names a permission, a rate limit or a missing thing, else only the status", async () => {
    expect((await failed(json({ message: "Resource not accessible by integration" }, 403))).message).toBe(
      "GitHub answered 403: Resource not accessible by integration",
    );
    // Free text from upstream is not kept, whatever it says, so nothing a person wrote can reach a stored error.
    expect((await failed(json({ message: "Server Error, ask alice@example.test or see ghp_secret" }, 500))).message).toBe(
      "GitHub answered 500",
    );
    expect((await failed(new Response("<html><body>Bad gateway</body></html>", { status: 502 }))).message).toBe(
      "GitHub answered 502",
    );
    expect((await failed(new Response(null, { status: 503 }))).message).toBe("GitHub answered 503");
  });

  it("reads at most 64 KiB of an error body, so a huge one costs the status only", async () => {
    const huge = new Response(JSON.stringify({ message: "x".repeat(70 * 1024) }), { status: 500 });
    expect((await failed(huge)).message).toBe("GitHub answered 500");
  });

  it("raises the rate limit error for a 403 whose message says rate limit, with no header", async () => {
    const error = await failed(json({ message: "You have exceeded a secondary rate limit." }, 403));
    expect(error.message).toContain(RATE_LIMIT_MESSAGE);
    expect(error.status).toBe(403);
    expect(error.rateLimited).toBe(true);
  });

  it("marks a rate limit from the headers, and leaves another 403 unmarked", async () => {
    expect((await failed(json({ message: "limit" }, 403, { "x-ratelimit-remaining": "0" }))).rateLimited).toBe(true);
    expect((await failed(new Response(null, { status: 429 }))).rateLimited).toBe(true);
    expect((await failed(json({ message: "Resource not accessible by integration" }, 403))).rateLimited).toBe(false);
  });
});

describe("requestPage", () => {
  const read = (response: Response, refusals: readonly number[] = [403, 404]) =>
    requestPage<unknown>(
      vi.fn(async () => response),
      "tok",
      FROM,
      refusals,
    );

  it("returns the body and the next address, and sends the token and the API version", async () => {
    const http = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json([1], 200, { link: `<https://api.github.com/x?page=2>; rel="next"` }),
    );

    expect(await requestPage(http, "tok", FROM, [])).toEqual({
      body: [1],
      next: { kind: "next", url: "https://api.github.com/x?page=2" },
    });

    const headers = http.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("returns a listed refusal with GitHub's message, cut to 300 characters", async () => {
    expect(await read(json({ message: "Dependabot alerts are disabled for this repository." }, 403))).toEqual({
      status: 403,
      message: "Dependabot alerts are disabled for this repository.",
    });
    expect(await read(json({ message: "x".repeat(500) }, 404))).toMatchObject({ status: 404, message: "x".repeat(300) });
  });

  it("returns an empty message for a refusal whose body is not the usual JSON", async () => {
    expect(await read(new Response("<html>", { status: 403 }))).toEqual({ status: 403, message: "" });
    expect(await read(json({ message: 5 }, 403))).toEqual({ status: 403, message: "" });
  });

  it("raises for a 401 before any refusal is looked at, even if 401 were listed", async () => {
    await expect(read(json({ message: "Bad credentials" }, 401), [401, 403])).rejects.toBeInstanceOf(UnauthorisedError);
  });

  it("raises the rate limit error for a rate-limited 403 or 429 even though 403 is listed", async () => {
    await expect(read(json({ message: "limit" }, 403, { "x-ratelimit-remaining": "0" }))).rejects.toThrow(RATE_LIMIT_MESSAGE);
    await expect(read(json({ message: "limit" }, 403, { "retry-after": "30" }))).rejects.toThrow(RATE_LIMIT_MESSAGE);
    await expect(read(json({ message: "limit" }, 429, { "retry-after": "30" }), [429])).rejects.toThrow(RATE_LIMIT_MESSAGE);
  });

  it("raises the rate limit error for a 403 whose message says rate limit, though no header says so", async () => {
    const secondary = "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";
    await expect(read(json({ message: secondary }, 403))).rejects.toThrow(RATE_LIMIT_MESSAGE);
    await expect(read(json({ message: secondary }, 403), [])).rejects.toThrow(RATE_LIMIT_MESSAGE);
    await expect(read(json({ message: "API rate limit exceeded for user ID 1." }, 403), [404])).rejects.toThrow(
      RATE_LIMIT_MESSAGE,
    );
    // Any other 403 is still handed back for the caller to classify.
    expect(await read(json({ message: "Resource not accessible by personal access token" }, 403))).toMatchObject({ status: 403 });
  });

  it("raises the rate limit error for any 429, even with no header and no message", async () => {
    await expect(read(new Response(null, { status: 429 }), [429])).rejects.toThrow(RATE_LIMIT_MESSAGE);
  });

  it("keeps the next page's refusal apart from the end of the list", async () => {
    const refused = json([1], 200, { link: `<https://evil.example.test/x?page=2>; rel="next"` });
    expect(await read(refused, [])).toEqual({ body: [1], next: { kind: "refused" } });
    expect(await read(json([1]), [])).toEqual({ body: [1], next: { kind: "none" } });
  });

  it("raises as `request` does for a status that is not listed", async () => {
    await expect(read(json({ message: "missing" }, 404), [403])).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(read(json({ message: "no" }, 403), [404])).rejects.toBeInstanceOf(UpstreamError);
    await expect(read(new Response("oops", { status: 500 }))).rejects.toMatchObject({ status: 500 });
  });

  it("maps a timeout to a gateway timeout", async () => {
    const timeout = new Error("slow");
    timeout.name = "TimeoutError";
    await expect(
      requestPage(
        vi.fn(async () => Promise.reject(timeout)),
        "t",
        FROM,
        [],
      ),
    ).rejects.toMatchObject({ status: 504 });
    await expect(
      requestPage(
        vi.fn(async () => Promise.reject(new Error("dns"))),
        "t",
        FROM,
        [],
      ),
    ).rejects.toMatchObject({ name: "UpstreamError", status: 502, message: "GitHub could not be reached" });
  });

  it("keeps the cause of a transport failure for the log but puts neither the address nor the cause in the message", async () => {
    const reset = new TypeError("fetch failed: ECONNRESET for https://api.github.com/secret-path");
    const error = (await request(
      vi.fn(async () => Promise.reject(reset)),
      "tok-123",
      FROM,
    ).catch((e: unknown) => e)) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.cause).toBe(reset);
    expect(error.message).not.toMatch(/secret-path|tok-123|ECONNRESET/);
  });
});
