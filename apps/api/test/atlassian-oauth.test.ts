import { describe, expect, it, vi } from "vitest";
import { TrackerConfigurationError, UnauthorisedError, UpstreamError } from "../src/core/errors.js";
import { ATLASSIAN_SCOPES, AtlassianOAuth } from "../src/infrastructure/jira/atlassian-oauth.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function build(reply: () => Response | Promise<Response>) {
  const http = vi.fn(async () => reply());
  const oauth = new AtlassianOAuth(
    "client-1",
    "secret-1",
    "http://localhost:5181/api/auth/jira/callback",
    http as unknown as typeof fetch,
    () => 1_000_000,
  );
  return { http, oauth };
}

const sent = (http: ReturnType<typeof vi.fn>) => {
  const [url, init] = http.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, string> };
};

describe("AtlassianOAuth", () => {
  it("builds the consent address with every parameter Atlassian requires", () => {
    const { oauth } = build(() => json({}));
    const url = new URL(oauth.authoriseUrl("state-1"));
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.atlassian.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      audience: "api.atlassian.com",
      client_id: "client-1",
      scope: ATLASSIAN_SCOPES.join(" "),
      redirect_uri: "http://localhost:5181/api/auth/jira/callback",
      state: "state-1",
      response_type: "code",
      prompt: "consent",
    });
    expect(oauth.kind).toBe("jira-cloud");
  });

  it("asks for offline access and the Jira work scope", () => {
    expect(ATLASSIAN_SCOPES).toContain("offline_access");
    expect(ATLASSIAN_SCOPES).toContain("read:jira-work");
  });

  it("exchanges a code over JSON and computes the expiry from expires_in", async () => {
    const { http, oauth } = build(() => json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }));
    expect(await oauth.exchange("code-1")).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1_000_000 + 3_600_000,
    });
    const { url, init, body } = sent(http);
    expect(url).toBe("https://auth.atlassian.com/oauth/token");
    expect(init.method).toBe("POST");
    expect(body).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://localhost:5181/api/auth/jira/callback",
      client_id: "client-1",
      client_secret: "secret-1",
    });
  });

  it("returns a null refresh token when none is issued", async () => {
    const { oauth } = build(() => json({ access_token: "access-1", expires_in: 60 }));
    expect(await oauth.exchange("code-1")).toMatchObject({ refreshToken: null, expiresAt: 1_060_000 });
  });

  it("refreshes and passes on the rotated refresh token", async () => {
    const { http, oauth } = build(() => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }));
    expect(await oauth.refresh("refresh-1")).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(sent(http).body).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "client-1",
      client_secret: "secret-1",
    });
  });

  it.each([400, 401, 403])("maps a %s refusal to UnauthorisedError without leaking secrets", async (status) => {
    const { oauth } = build(() =>
      json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, status),
    );
    const failure = await oauth.refresh("refresh-secret").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UnauthorisedError);
    expect((failure as Error).message).toContain("Unknown or invalid refresh token.");
    expect((failure as Error).message).not.toContain("secret-1");
    expect((failure as Error).message).not.toContain("refresh-secret");
  });

  describe("a sign-in refused because of this dashboard's own app credentials", () => {
    it.each([
      ["a 401 with no body detail", {}, 401],
      ["a 401 whatever the code", { error: "invalid_grant" }, 401],
      ["access_denied (a wrong client secret)", { error: "access_denied", error_description: "Unauthorized" }, 403],
      ["invalid_client", { error: "invalid_client" }, 400],
      ["unauthorized_client", { error: "unauthorized_client" }, 400],
      ["a redirect_uri mismatch", { error: "invalid_request", error_description: "Invalid redirect_uri" }, 400],
    ])("raises TrackerConfigurationError for %s", async (_name, body, status) => {
      const { oauth } = build(() => json(body, status));
      const failure = await oauth.exchange("code-secret").catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(TrackerConfigurationError);
      const message = (failure as Error).message;
      expect(message).toContain("ATLASSIAN_CLIENT_ID");
      expect(message).toContain("ATLASSIAN_CLIENT_SECRET");
      expect(message).toContain("callback URL");
      expect(message).not.toContain("secret-1");
      expect(message).not.toContain("code-secret");
    });

    it("keeps the Atlassian error code in the cause, for the log", async () => {
      const { oauth } = build(() => json({ error: "invalid_client" }, 400));
      const failure = (await oauth.exchange("c").catch((e: unknown) => e)) as Error;
      expect(String(failure.cause)).toContain("invalid_client");
    });

    it.each([
      ["an expired or reused code", { error: "invalid_grant", error_description: "Invalid authorization code" }, 403],
      ["a bad request", { error: "invalid_request" }, 400],
    ])("still raises UnauthorisedError for %s", async (_name, body, status) => {
      const { oauth } = build(() => json(body, status));
      const failure = await oauth.exchange("c").catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(UnauthorisedError);
      expect(failure).not.toBeInstanceOf(TrackerConfigurationError);
    });
  });

  it.each([
    ["a revoked grant", { error: "unauthorized_client", error_description: "Token was globally revoked" }, 401],
    ["a client refusal", { error: "invalid_client" }, 401],
    ["access_denied", { error: "access_denied", error_description: "Unauthorized" }, 403],
    ["a redirect_uri mention", { error: "invalid_grant", error_description: "bad redirect_uri" }, 400],
  ])("a refresh refused as %s stays an UnauthorisedError so the grant is dropped", async (_name, body, status) => {
    const { oauth } = build(() => json(body, status));
    const failure = await oauth.refresh("r").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UnauthorisedError);
    expect(failure).not.toBeInstanceOf(TrackerConfigurationError);
  });

  it.each([
    ["invalid_request", { error: "invalid_request", error_description: "Missing grant_type" }],
    ["unsupported_grant_type", { error: "unsupported_grant_type" }],
    ["no error code", {}],
  ])(
    "a refresh answered 400 %s is a fault in this dashboard's own request, so it is an UpstreamError and the grant is kept",
    async (_name, body) => {
      const { oauth } = build(() => json(body, 400));
      const failure = await oauth.refresh("r").catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(UpstreamError);
      expect(failure).not.toBeInstanceOf(UnauthorisedError);
      expect(failure).toMatchObject({ status: 400 });
    },
  );

  it("still refuses a sign-in answered 400 whatever the code, since no grant exists to keep", async () => {
    const { oauth } = build(() => json({ error: "invalid_request" }, 400));
    await expect(oauth.exchange("c")).rejects.toBeInstanceOf(UnauthorisedError);
  });

  it("puts Atlassian's description, cut to 200 characters, in the configuration error's cause", async () => {
    const description = `The client secret is wrong ${"x".repeat(300)}`;
    const { oauth } = build(() => json({ error: "invalid_client", error_description: description }, 401));
    const failure = (await oauth.exchange("c").catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(TrackerConfigurationError);
    const cause = String(failure.cause);
    expect(cause).toContain("401 invalid_client: The client secret is wrong");
    expect(cause).toContain(description.slice(0, 200));
    expect(cause).not.toContain(description.slice(0, 201));
    expect(cause).not.toContain("secret-1");
  });

  it("falls back to the error code, then a generic reason", async () => {
    const withCode = build(() => json({ error: "invalid_request" }, 400));
    await expect(withCode.oauth.exchange("c")).rejects.toThrow("invalid_request");
    const bare = build(() => json({}, 403));
    await expect(bare.oauth.exchange("c")).rejects.toThrow("did not issue a token");
  });

  it("raises UpstreamError with the status for other failures", async () => {
    const { oauth } = build(() => json({ error_description: "Try later" }, 503));
    const failure = await oauth.exchange("c").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UpstreamError);
    expect(failure).toMatchObject({ status: 503, message: "Atlassian sign-in failed. Try later" });
  });

  it("raises UpstreamError for an unreadable body and for a network failure", async () => {
    const unreadable = build(() => new Response("<html>", { status: 502 }));
    await expect(unreadable.oauth.exchange("c")).rejects.toMatchObject({ status: 502 });
    const down = build(() => {
      throw new Error("socket hang up");
    });
    await expect(down.oauth.exchange("c")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("keeps the network error as the cause and says which exchange could not reach Atlassian", async () => {
    const socket = new Error("socket hang up");
    const down = build(() => {
      throw socket;
    });
    const signIn = await down.oauth.exchange("c").catch((e: unknown) => e);
    const refresh = await down.oauth.refresh("r").catch((e: unknown) => e);
    expect(signIn).toMatchObject({ status: 502, message: "Atlassian could not be reached during sign-in", cause: socket });
    expect(refresh).toMatchObject({ message: "Atlassian could not be reached during refresh", cause: socket });
  });

  it("raises UpstreamError when a success carries no access token", async () => {
    const { oauth } = build(() => json({ expires_in: 5 }));
    await expect(oauth.exchange("c")).rejects.toBeInstanceOf(UpstreamError);
  });

  it("defaults the lifetime to one hour when expires_in is missing", async () => {
    const { oauth } = build(() => json({ access_token: "a" }));
    expect((await oauth.exchange("c")).expiresAt).toBe(1_000_000 + 3_600_000);
  });

  it("uses the real clock and fetch defaults without calling out", () => {
    const oauth = new AtlassianOAuth("c", "s", "http://localhost/cb");
    expect(oauth.authoriseUrl("x")).toContain("state=x");
  });
});
