import { describe, expect, it, vi } from "vitest";
import { UnauthorisedError, UpstreamError } from "../src/core/errors.js";
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
    expect(failure).toMatchObject({ status: 503, message: "Try later" });
  });

  it("raises UpstreamError for an unreadable body and for a network failure", async () => {
    const unreadable = build(() => new Response("<html>", { status: 502 }));
    await expect(unreadable.oauth.exchange("c")).rejects.toMatchObject({ status: 502 });
    const down = build(() => {
      throw new Error("socket hang up");
    });
    await expect(down.oauth.exchange("c")).rejects.toBeInstanceOf(UpstreamError);
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
