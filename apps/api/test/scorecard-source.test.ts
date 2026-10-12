import { describe, expect, it, vi } from "vitest";
import { UpstreamError } from "../src/core/errors.js";
import { OpenSsfScorecardSource } from "../src/infrastructure/scorecard/openssf-scorecard-source.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const reply = {
  date: "2026-09-28",
  repo: { name: "github.com/acme/widgets", commit: "abc" },
  scorecard: { version: "v5.0.0", commit: "def" },
  score: 8.9,
  checks: [
    {
      name: "Pinned-Dependencies",
      score: 5,
      reason: "3 out of 6 dependencies pinned",
      details: ["Warn: GitHub-owned GitHubAction not pinned by hash: .github/workflows/ci.yml:12"],
      documentation: {
        short: "short docs",
        url: "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies",
      },
    },
    { name: "Fuzzing", score: -1, reason: "no fuzzer integrations found", details: null },
    { name: "Broken", reason: "has no score" },
    { score: 3 },
  ],
};

describe("OpenSsfScorecardSource", () => {
  it("maps the score, its date and each check's name, score and reason, and never the details", async () => {
    const http = vi.fn(async () => json(reply));

    const result = await new OpenSsfScorecardSource(http).scorecard("acme", "widgets");

    expect(result).toEqual({
      score: 8.9,
      date: "2026-09-28",
      checks: [
        { name: "Pinned-Dependencies", score: 5, reason: "3 out of 6 dependencies pinned" },
        { name: "Fuzzing", score: -1, reason: "no fuzzer integrations found" },
      ],
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("not pinned by hash");
    expect(text).not.toContain("details");
    expect(text).not.toContain("short docs");
  });

  it("asks the fixed origin for the project, sends no credential and refuses a redirect", async () => {
    const http = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(reply));

    await new OpenSsfScorecardSource(http).scorecard("acme", "wid gets");

    const [url, init] = http.mock.calls[0]!;
    expect(String(url)).toBe("https://api.securityscorecards.dev/projects/github.com/acme/wid%20gets");
    expect(init?.redirect).toBe("error");
    const headers = Object.fromEntries(
      Object.entries(init?.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(Object.keys(headers)).not.toContain("authorization");
    expect(Object.keys(headers)).not.toContain("cookie");
    expect(init).not.toHaveProperty("credentials", "include");
  });

  it("answers null for a project the service does not scan", async () => {
    const http = vi.fn(async () => json({ code: 404, message: "not found" }, 404));
    expect(await new OpenSsfScorecardSource(http).scorecard("acme", "widgets")).toBeNull();
  });

  it("truncates a long reason", async () => {
    const http = vi.fn(async () => json({ ...reply, checks: [{ name: "X", score: 1, reason: "r".repeat(1000) }] }));
    const result = await new OpenSsfScorecardSource(http).scorecard("acme", "widgets");
    expect(result!.checks[0]!.reason).toHaveLength(300);
  });

  it("raises for a server error, a reply with no score, one that is not JSON, and one over 1 MiB", async () => {
    const source = (response: () => Response) => new OpenSsfScorecardSource(vi.fn(async () => response()));
    await expect(source(() => new Response("down", { status: 503 })).scorecard("a", "b")).rejects.toMatchObject({ status: 503 });
    await expect(source(() => json({ date: "2026-09-28" })).scorecard("a", "b")).rejects.toThrow("no score");
    await expect(source(() => json({ score: 5 })).scorecard("a", "b")).rejects.toThrow("no score");
    await expect(source(() => new Response("<html>", { status: 200 })).scorecard("a", "b")).rejects.toBeInstanceOf(UpstreamError);
    await expect(
      source(() => new Response(new Blob([new Uint8Array(1024 * 1024 + 1)]).stream(), { status: 200 })).scorecard("a", "b"),
    ).rejects.toThrow("larger than the limit");
    await expect(
      source(() => new Response("{}", { status: 200, headers: { "content-length": "2097152" } })).scorecard("a", "b"),
    ).rejects.toThrow("larger than the limit");
  });

  it.each(["yesterday", "2026-13-45", "28/09/2026", "", 20260928, "2026-09-28T25:00:00Z"])(
    "drops a result whose date is %j",
    async (date) => {
      const http = vi.fn(async () => json({ score: 5, date }));
      await expect(new OpenSsfScorecardSource(http).scorecard("a", "b")).rejects.toThrow("no score or with a date");
    },
  );

  it.each(["2026-09-28", "2026-09-28T10:15:00Z", "2026-09-28T10:15:00.123+01:00"])("accepts the date %s", async (date) => {
    const http = vi.fn(async () => json({ score: 5, date }));
    expect((await new OpenSsfScorecardSource(http).scorecard("a", "b"))!.date).toBe(date);
  });

  it("reads a reply with no checks list", async () => {
    const http = vi.fn(async () => json({ score: 4, date: "2026-09-28" }));
    expect(await new OpenSsfScorecardSource(http).scorecard("acme", "widgets")).toEqual({
      score: 4,
      date: "2026-09-28",
      checks: [],
    });
  });

  it("maps a timeout to a gateway timeout and a refused redirect to a plain error with no address", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const slow = new OpenSsfScorecardSource(vi.fn(async () => Promise.reject(timeout)));
    await expect(slow.scorecard("a", "b")).rejects.toMatchObject({ status: 504 });

    const redirected = new OpenSsfScorecardSource(
      vi.fn(async () => Promise.reject(new TypeError("redirect to https://attacker.example.test"))),
    );
    const error = await redirected.scorecard("a", "b").catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("attacker");
    expect(error).toBeInstanceOf(UpstreamError);
  });

  it("raises when the body stream breaks part way", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new Error("connection reset"));
      },
    });
    const http = vi.fn(async () => new Response(stream, { status: 200 }));
    await expect(new OpenSsfScorecardSource(http).scorecard("a", "b")).rejects.toThrow("interrupted");
  });

  it("labels a timeout that fires while the body streams as a gateway timeout, not an interruption", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      },
    });
    const http = vi.fn(async () => new Response(stream, { status: 200 }));
    await expect(new OpenSsfScorecardSource(http).scorecard("a", "b")).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining("did not finish sending"),
    });
  });

  it("reads a reply with no body as an error", async () => {
    const http = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(new OpenSsfScorecardSource(http).scorecard("a", "b")).rejects.toBeInstanceOf(UpstreamError);
  });
});
