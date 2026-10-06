import { UnauthorisedError, UpstreamError } from "../../core/errors.js";
import type { TrackerAuthorisation, TrackerGrant } from "../../interfaces/tracker-authorisation.js";

/**
 * Scopes requested at consent.
 * - `read:jira-work` covers project, status, issue search and changelog reads on the platform API.
 * - `read:jira-user` lets the adapter read each assignee's account id and display name from the issue search, and never an email address.
 * - `offline_access` yields the rotating refresh token.
 * - The three granular scopes serve the Jira Software board endpoints: the board list needs
 *   `read:board-scope:jira-software` and `read:project:jira`, and the board configuration needs
 *   `read:board-scope.admin:jira-software` and `read:project:jira`.
 */
export const ATLASSIAN_SCOPES = [
  "read:jira-work",
  "read:jira-user",
  "offline_access",
  "read:board-scope:jira-software",
  "read:board-scope.admin:jira-software",
  "read:project:jira",
] as const;

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Statuses on which Atlassian says a code or refresh token is no longer good. */
const REFUSED = new Set([400, 401, 403]);

/** Atlassian's OAuth 2.0 (3LO) authorisation code grant, with rotating refresh tokens. */
export class AtlassianOAuth implements TrackerAuthorisation {
  readonly kind = "jira-cloud";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
    private readonly http: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly authBase: string = "https://auth.atlassian.com",
  ) {}

  authoriseUrl(state: string): string {
    const url = new URL("/authorize", this.authBase);
    url.searchParams.set("audience", "api.atlassian.com");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("scope", ATLASSIAN_SCOPES.join(" "));
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  exchange(code: string): Promise<TrackerGrant> {
    return this.token("sign-in", { grant_type: "authorization_code", code, redirect_uri: this.redirectUri });
  }

  refresh(refreshToken: string): Promise<TrackerGrant> {
    return this.token("refresh", { grant_type: "refresh_token", refresh_token: refreshToken });
  }

  /** `step` names the exchange in any error, so a log says which one failed. */
  private async token(step: "sign-in" | "refresh", grant: Record<string, string>): Promise<TrackerGrant> {
    let response: Response;
    try {
      response = await this.http(`${this.authBase}/oauth/token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ ...grant, client_id: this.clientId, client_secret: this.clientSecret }),
      });
    } catch (cause) {
      throw new UpstreamError(`Atlassian could not be reached during ${step}`, 502, { cause });
    }
    let body: TokenBody;
    try {
      body = (await response.json()) as TokenBody;
    } catch {
      throw new UpstreamError(`Atlassian sent an unreadable ${step} response`, response.status);
    }
    if (response.ok && body.access_token) {
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? null,
        expiresAt: this.now() + (body.expires_in ?? 3600) * 1000,
      };
    }
    const reason = body.error_description ?? body.error ?? "Atlassian did not issue a token";
    if (REFUSED.has(response.status)) throw new UnauthorisedError(`Atlassian refused the ${step}. ${reason}`);
    throw new UpstreamError(`Atlassian ${step} failed. ${reason}`, response.status);
  }
}
