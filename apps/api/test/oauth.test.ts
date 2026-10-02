import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { UpstreamError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { githubCodeExchange } from "../src/routes/auth.js";
import { config, FakeCli, FakeProvider } from "./fakes.js";

function cookiesOf(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return Object.fromEntries(list.map((c: string) => c.split(";")[0]!.split("=") as [string, string]));
}

describe("OAuth sign-in", () => {
  let app: FastifyInstance;
  const exchangeCode = vi.fn(async (code: string) => `token-for-${code}`);

  beforeEach(async () => {
    exchangeCode.mockClear();
    ({ app } = await buildApp({
      config: config({ authMode: "oauth" }),
      store: new SqliteRepoStore(":memory:"),
      provider: new FakeProvider(),
      sessions: new MemorySessionStore(),
      cli: new FakeCli(),
      exchangeCode,
    }));
  });

  afterEach(() => app.close());

  async function signIn() {
    const login = await app.inject("/api/auth/github/login");
    const state = new URL(login.headers.location as string).searchParams.get("state")!;
    const callback = await app.inject({
      url: `/api/auth/github/callback?code=abc&state=${state}`,
      cookies: { dora_oauth_state: cookiesOf(login).dora_oauth_state! },
    });
    return { login, callback, sid: cookiesOf(callback).dora_sid! };
  }

  it("refuses the API until signed in", async () => {
    expect((await app.inject("/api/repos")).statusCode).toBe(401);
    expect((await app.inject("/api/auth/me")).json()).toMatchObject({ mode: "oauth", user: null });
  });

  it("redirects to GitHub with the callback and a state value", async () => {
    const { login } = await signIn();
    const target = new URL(login.headers.location as string);
    expect(target.origin + target.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(target.searchParams.get("redirect_uri")).toBe("http://localhost:5181/api/auth/github/callback");
  });

  it("exchanges the code, stores the session and never sends the token to the browser", async () => {
    const { callback, sid } = await signIn();
    expect(exchangeCode).toHaveBeenCalledWith("abc");
    expect(callback.statusCode).toBe(302);
    expect(JSON.stringify(callback.headers)).not.toContain("token-for-abc");

    const me = await app.inject({ url: "/api/auth/me", cookies: { dora_sid: sid } });
    expect(me.json()).toMatchObject({ user: { login: "user-of-token-for-abc" }, source: "oauth" });
    expect((await app.inject({ url: "/api/repos", cookies: { dora_sid: sid } })).statusCode).toBe(200);
  });

  it("rejects a callback whose state does not match", async () => {
    const login = await app.inject("/api/auth/github/login");
    const res = await app.inject({
      url: "/api/auth/github/callback?code=abc&state=forged",
      cookies: { dora_oauth_state: cookiesOf(login).dora_oauth_state! },
    });
    expect(res.statusCode).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects a tampered session cookie", async () => {
    const { sid } = await signIn();
    const tampered = sid.replace(/^./, (c) => (c === "a" ? "b" : "a"));
    expect((await app.inject({ url: "/api/repos", cookies: { dora_sid: tampered } })).statusCode).toBe(401);
  });

  it("signs out", async () => {
    const { sid } = await signIn();
    await app.inject({ method: "POST", url: "/api/auth/logout", cookies: { dora_sid: sid } });
    expect((await app.inject({ url: "/api/repos", cookies: { dora_sid: sid } })).statusCode).toBe(401);
  });
});

describe("githubCodeExchange", () => {
  it("returns the access token GitHub issues", async () => {
    const http = vi.fn(async () => new Response(JSON.stringify({ access_token: "gho_x" })));
    expect(await githubCodeExchange(config(), http)("code")).toBe("gho_x");
    expect(http).toHaveBeenCalledWith("https://github.com/login/oauth/access_token", expect.objectContaining({ method: "POST" }));
  });

  it("raises GitHub's own reason when no token is issued", async () => {
    const http = vi.fn(async () => new Response(JSON.stringify({ error_description: "bad code" }), { status: 200 }));
    await expect(githubCodeExchange(config(), http)("code")).rejects.toEqual(new UpstreamError("bad code", 200));
  });
});
