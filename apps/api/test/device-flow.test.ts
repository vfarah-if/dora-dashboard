import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { MemorySessionStore } from "../src/infrastructure/auth/memory-session-store.js";
import { GitHubDeviceFlow } from "../src/infrastructure/github/github-device-flow.js";
import { DeviceSignInService, MAX_PENDING_SIGN_INS } from "../src/services/device-sign-in-service.js";
import { SqliteRepoStore } from "../src/infrastructure/sqlite/sqlite-repo-store.js";
import { loadConfig, PUBLISHED_DEVICE_CLIENT_ID } from "../src/core/config.js";
import { config, FakeCli, FakeDeviceAuthorisation, FakeProvider } from "./fakes.js";

type Headers = Record<string, unknown>;

function setCookies(res: { headers: Headers }): string[] {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
}

function cookiesOf(res: { headers: Headers }): Record<string, string> {
  return Object.fromEntries(setCookies(res).map((c) => c.split(";")[0]!.split("=") as [string, string]));
}

describe("device flow routes", () => {
  let app: FastifyInstance;
  let time = 1_000_000;
  const device = new FakeDeviceAuthorisation();
  const cli = new FakeCli();
  let provider = new FakeProvider();

  async function build(overrides: Parameters<typeof config>[0] = { deviceClientId: "device-client" }) {
    time = 1_000_000;
    provider = new FakeProvider();
    cli.error = new UnauthorisedError("The GitHub CLI is not signed in; run `gh auth login`");
    device.starts = 0;
    device.startFailWith = null;
    device.polls = [{ status: "pending" }];
    device.polled.length = 0;
    ({ app } = await buildApp({
      config: config(overrides),
      store: new SqliteRepoStore(":memory:"),
      provider,
      sessions: new MemorySessionStore(),
      cli,
      exchangeCode: async () => "unused",
      deviceAuth: device,
      now: () => time,
    }));
  }

  afterEach(() => app.close());

  const startSignIn = async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/device" });
    return { res, cookie: cookiesOf(res).dora_device! };
  };
  const poll = (cookie?: string) =>
    app.inject({ method: "POST", url: "/api/auth/device/poll", cookies: cookie ? { dora_device: cookie } : {} });

  it.each([
    ["the client ID is empty", { deviceClientId: "" }],
    ["the mode is oauth", { authMode: "oauth" as const, deviceClientId: "device-client" }],
  ])("registers no device routes when %s", async (_name, overrides) => {
    await build(overrides);
    expect((await app.inject({ method: "POST", url: "/api/auth/device" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/auth/device/poll" })).statusCode).toBe(404);
    expect((await app.inject("/api/auth/me")).json()).toMatchObject({ deviceFlow: false });
  });

  it("reports the fallback on /api/auth/me alongside the CLI's readable error", async () => {
    await build();
    expect((await app.inject("/api/auth/me")).json()).toEqual({
      mode: "gh-cli",
      user: null,
      error: "The GitHub CLI is not signed in; run `gh auth login`",
      source: null,
      deviceFlow: true,
    });
  });

  it("reports the fallback as on when the CLI works", async () => {
    await build();
    cli.error = null;
    expect((await app.inject("/api/auth/me")).json()).toMatchObject({
      user: { login: "local-dev" },
      error: null,
      deviceFlow: true,
    });
  });

  it("starts a sign-in, returns the user code and keeps the device code on the server", async () => {
    await build();
    const { res } = await startSignIn();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userCode: "ABCD-1234",
      verificationUri: "https://example.test/device",
      interval: 5,
      expiresIn: 900,
    });
    expect(JSON.stringify(res.headers) + res.body).not.toContain("secret-device-code");
    const header = setCookies(res).find((c) => c.startsWith("dora_device="))!;
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Max-Age=900");
  });

  it("surfaces an upstream failure as a 502", async () => {
    await build();
    device.startFailWith = new UpstreamError("device flow is not enabled", 400);
    const res = await app.inject({ method: "POST", url: "/api/auth/device" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "device flow is not enabled" });
  });

  it("answers expired when there is no cookie", async () => {
    await build();
    expect((await poll()).json()).toMatchObject({ status: "expired" });
    expect(device.polled).toEqual([]);
  });

  it("answers expired for a cookie whose pending entry is unknown", async () => {
    await build();
    const { cookie } = await startSignIn();
    await app.close();
    await build();
    expect((await poll(cookie)).json()).toMatchObject({ status: "expired" });
  });

  it("answers pending while GitHub is still waiting", async () => {
    await build();
    const { cookie } = await startSignIn();
    time += 5000;
    const res = await poll(cookie);
    expect(res.json()).toEqual({ status: "pending", interval: 5 });
    expect(device.polled).toEqual(["secret-device-code"]);
  });

  it("does not call GitHub when polled before the interval has passed", async () => {
    await build();
    const { cookie } = await startSignIn();
    time += 4999;
    expect((await poll(cookie)).json()).toEqual({ status: "pending", interval: 5 });
    expect(device.polled).toEqual([]);
    time += 1;
    await poll(cookie);
    expect(device.polled).toHaveLength(1);
    time += 1000;
    await poll(cookie);
    expect(device.polled).toHaveLength(1);
  });

  it("raises the interval on slow_down, using GitHub's figure when given and adding 5 seconds otherwise", async () => {
    await build();
    device.polls = [{ status: "slow_down", interval: 10 }, { status: "slow_down" }];
    const { cookie } = await startSignIn();
    time += 5000;
    expect((await poll(cookie)).json()).toEqual({ status: "pending", interval: 10 });
    time += 9000;
    await poll(cookie);
    expect(device.polled).toHaveLength(1);
    time += 1000;
    expect((await poll(cookie)).json()).toEqual({ status: "pending", interval: 15 });
  });

  it("creates a session on grant so /api/auth/me returns the user while the CLI fails", async () => {
    await build();
    device.polls = [{ status: "granted", token: "gho_secret" }];
    const { cookie } = await startSignIn();
    time += 5000;
    const res = await poll(cookie);
    expect(res.json()).toEqual({
      status: "granted",
      interval: 5,
      user: { login: "user-of-gho_secret", avatarUrl: "https://example.test/avatar.png" },
    });
    // The fake viewer's login embeds the token, so strip the login before looking for it.
    expect((res.body + JSON.stringify(res.headers)).replaceAll("user-of-gho_secret", "")).not.toContain("gho_secret");
    const sid = cookiesOf(res).dora_sid!;
    const sessionHeader = setCookies(res).find((c) => c.startsWith("dora_sid="))!;
    expect(sessionHeader).toContain("Max-Age=28800");
    expect(sessionHeader).toContain("HttpOnly");
    expect(setCookies(res).find((c) => c.startsWith("dora_device="))).toMatch(/Expires=Thu, 01 Jan 1970/);

    const me = await app.inject({ url: "/api/auth/me", cookies: { dora_sid: sid } });
    expect(me.json()).toMatchObject({ user: { login: "user-of-gho_secret" }, error: null, source: "device" });
    expect((await app.inject({ url: "/api/repos", cookies: { dora_sid: sid } })).statusCode).toBe(200);

    // The pending entry is gone, so the same cookie now reads as expired.
    time += 5000;
    expect((await poll(cookie)).json()).toMatchObject({ status: "expired" });
  });

  it.each(["expired", "denied"] as const)("clears the sign-in on %s", async (status) => {
    await build();
    device.polls = [{ status }];
    const { cookie } = await startSignIn();
    time += 5000;
    const res = await poll(cookie);
    expect(res.json()).toEqual({ status, interval: 5 });
    expect(setCookies(res).find((c) => c.startsWith("dora_device="))).toMatch(/Expires=Thu, 01 Jan 1970/);
    time += 5000;
    await poll(cookie);
    expect(device.polled).toHaveLength(1);
  });

  it("answers expired without calling GitHub once the code's lifetime has passed", async () => {
    await build();
    const { cookie } = await startSignIn();
    time += 900_000;
    expect((await poll(cookie)).json()).toMatchObject({ status: "expired" });
    expect(device.polled).toEqual([]);
  });

  it("replaces an earlier pending sign-in from the same browser", async () => {
    await build();
    const first = await startSignIn();
    time += 2000;
    await app.inject({ method: "POST", url: "/api/auth/device", cookies: { dora_device: first.cookie } });
    time += 5000;
    expect((await poll(first.cookie)).json()).toMatchObject({ status: "expired" });
  });

  it("propagates an upstream failure while polling and keeps the sign-in pending", async () => {
    await build();
    const { cookie } = await startSignIn();
    time += 5000;
    const spy = vi.spyOn(device, "poll").mockRejectedValueOnce(new UpstreamError("bad client", 200));
    expect((await poll(cookie)).statusCode).toBe(502);
    spy.mockRestore();
    expect((await poll(cookie)).json()).toEqual({ status: "pending", interval: 5 });
  });

  it.each([
    ["tampered", (c: string) => c.replace(/.$/, (x) => (x === "a" ? "b" : "a"))],
    ["unsigned", () => "just-an-id"],
  ])("reads a %s dora_device cookie as expired without calling GitHub", async (_name, change) => {
    await build();
    const { cookie } = await startSignIn();
    time += 5000;
    expect((await poll(change(cookie))).json()).toMatchObject({ status: "expired" });
    expect(device.polled).toEqual([]);
  });

  it("refuses a second start within 2 seconds without calling GitHub", async () => {
    await build();
    await startSignIn();
    time += 1999;
    const res = await app.inject({ method: "POST", url: "/api/auth/device" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "Too many sign-in attempts. Wait a moment and try again." });
    expect(device.starts).toBe(1);
    time += 1;
    expect((await app.inject({ method: "POST", url: "/api/auth/device" })).statusCode).toBe(200);
  });

  it("refuses a start at the pending cap without calling GitHub", async () => {
    await build();
    for (let i = 0; i < MAX_PENDING_SIGN_INS; i++) {
      time += 2000;
      expect((await app.inject({ method: "POST", url: "/api/auth/device" })).statusCode).toBe(200);
    }
    time += 2000;
    const res = await app.inject({ method: "POST", url: "/api/auth/device" });
    expect(res.statusCode).toBe(429);
    expect(device.starts).toBe(MAX_PENDING_SIGN_INS);
  });

  it.each([
    ["/api/auth/device", { dora_device: "x" }],
    ["/api/auth/device/poll", {}],
    ["/api/auth/logout", {}],
  ])("answers 403 to %s from another origin and allows it with no Origin", async (url, cookies) => {
    await build();
    const refused = await app.inject({ method: "POST", url, headers: { origin: "https://evil.example" }, cookies });
    expect(refused.statusCode).toBe(403);
    expect(device.starts).toBe(0);
    const same = await app.inject({ method: "POST", url, headers: { origin: "http://localhost:5181" } });
    expect(same.statusCode).toBe(200);
    time += 2000;
    expect((await app.inject({ method: "POST", url })).statusCode).toBe(200);
  });

  it("answers 502 and creates no session when the viewer cannot be read, consuming the sign-in", async () => {
    await build();
    device.polls = [{ status: "granted", token: "gho_secret" }];
    vi.spyOn(provider, "fetchViewer").mockRejectedValueOnce(new UpstreamError("GitHub answered 502", 502));
    const { cookie } = await startSignIn();
    time += 5000;
    const res = await poll(cookie);
    expect(res.statusCode).toBe(502);
    expect("dora_sid" in cookiesOf(res)).toBe(false);
    time += 5000;
    expect((await poll(cookie)).json()).toMatchObject({ status: "expired" });
  });

  it("retires the old dora_sid session when a new sign-in is granted", async () => {
    await build();
    device.polls = [{ status: "granted", token: "first" }];
    const one = await startSignIn();
    time += 5000;
    const oldSid = cookiesOf(await poll(one.cookie)).dora_sid!;
    time += 2000;
    device.polls = [{ status: "granted", token: "second" }];
    const two = await startSignIn();
    time += 5000;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/device/poll",
      cookies: { dora_device: two.cookie, dora_sid: oldSid },
    });
    expect(res.json()).toMatchObject({ status: "granted" });
    expect((await app.inject({ url: "/api/repos", cookies: { dora_sid: oldSid } })).statusCode).toBe(401);
    const me = await app.inject({ url: "/api/auth/me", cookies: { dora_sid: cookiesOf(res).dora_sid! } });
    expect(me.json()).toMatchObject({ user: { login: "user-of-second" } });
  });

  it("signs a device session out in gh-cli mode", async () => {
    await build();
    device.polls = [{ status: "granted", token: "gho_secret" }];
    const { cookie } = await startSignIn();
    time += 5000;
    const sid = cookiesOf(await poll(cookie)).dora_sid!;
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: { dora_sid: sid } });
    expect(out.json()).toEqual({ ok: true });
    const me = await app.inject({ url: "/api/auth/me", cookies: { dora_sid: sid } });
    expect(me.json()).toMatchObject({ user: null });
  });
});

describe("DeviceSignInService", () => {
  it("discards expired pending sign-ins when counting and starting", async () => {
    let time = 0;
    const device = new FakeDeviceAuthorisation();
    const service = new DeviceSignInService(device, new MemorySessionStore(), new FakeProvider(), () => time);
    const first = await service.start(null);
    expect(service.pendingCount()).toBe(1);
    time = 900_000;
    await service.start(null);
    expect(service.pendingCount()).toBe(1);
    expect((await service.poll(first.id, null)).status).toBe("expired");
  });
});

describe("source on /api/auth/me", () => {
  it("is oauth in oauth mode with a user, and null without one", async () => {
    const { app } = await buildApp({
      config: config({ authMode: "oauth" }),
      store: new SqliteRepoStore(":memory:"),
      provider: new FakeProvider(),
      sessions: new MemorySessionStore(),
      cli: new FakeCli(),
      exchangeCode: async () => "unused",
    });
    expect((await app.inject("/api/auth/me")).json()).toMatchObject({ user: null, source: null });
    await app.close();
  });
});

describe("GitHubDeviceFlow", () => {
  it.each(["http://github.com/login/device", "javascript:alert(1)", "not a url"])(
    "rejects the verification address %s",
    async (uri) => {
      const http = vi.fn(async () => new Response(JSON.stringify({ device_code: "dc", user_code: "UC", verification_uri: uri })));
      await expect(new GitHubDeviceFlow("cid", http).start()).rejects.toThrow(UpstreamError);
    },
  );

  const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("starts a flow with the client ID and scopes and maps GitHub's fields", async () => {
    const http = reply({
      device_code: "dc",
      user_code: "UC",
      verification_uri: "https://github.com/login/device",
      expires_in: 600,
      interval: 7,
    });
    const code = await new GitHubDeviceFlow("cid", http).start();
    expect(code).toEqual({
      deviceCode: "dc",
      userCode: "UC",
      verificationUri: "https://github.com/login/device",
      expiresIn: 600,
      interval: 7,
    });
    const [url, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://github.com/login/device/code");
    expect(init.headers).toMatchObject({ Accept: "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ client_id: "cid", scope: "repo read:org" });
  });

  it("defaults the lifetime and interval when GitHub omits them", async () => {
    const http = reply({ device_code: "dc", user_code: "UC", verification_uri: "https://github.com/login/device" });
    expect(await new GitHubDeviceFlow("cid", http).start()).toMatchObject({ expiresIn: 900, interval: 5 });
  });

  it("raises GitHub's reason when it will not start a flow", async () => {
    const http = reply({ error: "device_flow_disabled", error_description: "Device flow is disabled" }, 400);
    await expect(new GitHubDeviceFlow("cid", http).start()).rejects.toEqual(new UpstreamError("Device flow is disabled", 400));
    await expect(new GitHubDeviceFlow("cid", reply({})).start()).rejects.toThrow("did not start");
  });

  it("raises an upstream error for an unreadable response", async () => {
    const http = vi.fn(async () => new Response("<html>", { status: 502 }));
    await expect(new GitHubDeviceFlow("cid", http).start()).rejects.toEqual(
      new UpstreamError("GitHub sent an unreadable sign-in response", 502),
    );
  });

  it("polls with the device code and grant type", async () => {
    const http = reply({ access_token: "gho_x" });
    expect(await new GitHubDeviceFlow("cid", http).poll("dc")).toEqual({ status: "granted", token: "gho_x" });
    const [url, init] = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "cid",
      device_code: "dc",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  it.each([
    [{ error: "authorization_pending" }, { status: "pending" }],
    [{ error: "expired_token" }, { status: "expired" }],
    [{ error: "access_denied" }, { status: "denied" }],
    [
      { error: "slow_down", interval: 10 },
      { status: "slow_down", interval: 10 },
    ],
  ])("maps %j to %j", async (body, expected) => {
    expect(await new GitHubDeviceFlow("cid", reply(body)).poll("dc")).toEqual(expected);
  });

  it("reports slow_down without an interval when GitHub gives none", async () => {
    const result = await new GitHubDeviceFlow("cid", reply({ error: "slow_down" })).poll("dc");
    expect(result).toEqual({ status: "slow_down" });
    expect("interval" in result).toBe(false);
  });

  it("raises an upstream error with GitHub's description for any other error", async () => {
    const http = reply({ error: "incorrect_client_credentials", error_description: "The client_id is incorrect" });
    await expect(new GitHubDeviceFlow("cid", http).poll("dc")).rejects.toEqual(
      new UpstreamError("The client_id is incorrect", 200),
    );
    await expect(new GitHubDeviceFlow("cid", reply({ error: "weird" })).poll("dc")).rejects.toThrow("weird");
    await expect(new GitHubDeviceFlow("cid", reply({})).poll("dc")).rejects.toThrow("did not issue a token");
  });
});

describe("device client ID configuration", () => {
  it("reads GITHUB_DEVICE_CLIENT_ID", () => {
    expect(loadConfig({ GITHUB_DEVICE_CLIENT_ID: "abc" }).deviceClientId).toBe("abc");
  });

  it("falls back to the published constant", () => {
    expect(loadConfig({}).deviceClientId).toBe(PUBLISHED_DEVICE_CLIENT_ID);
    expect(loadConfig({ GITHUB_DEVICE_CLIENT_ID: "" }).deviceClientId).toBe(PUBLISHED_DEVICE_CLIENT_ID);
  });
});
