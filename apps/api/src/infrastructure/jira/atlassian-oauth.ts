import { TrackerConfigurationError, UnauthorisedError, UpstreamError } from "../../core/errors.js";
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

/**
 * Statuses on which Atlassian says a code or refresh token is no longer good. A refresh answered with 401 or 403 loses
 * the grant, by status and not by error code, because Atlassian documents only a 403 `invalid_grant` for refresh and
 * reports a revoked grant as a 401 `unauthorized_client` (ADR 0020). A 400 counts only when it says `invalid_grant`
 * at refresh: any other 400 there (`invalid_request`, `unsupported_grant_type`) is a fault in this dashboard's own
 * request, and dropping the grant for it would disconnect everyone while hiding the bug.
 */
const REFUSED = new Set([401, 403]);

/** How much of Atlassian's `error_description` a log keeps. It carries no secret. */
const MAX_DESCRIPTION = 200;

type Step = "sign-in" | "refresh";

function refusesToken(step: Step, status: number, body: TokenBody): boolean {
  if (REFUSED.has(status)) return true;
  return status === 400 && (step === "sign-in" || body.error === "invalid_grant");
}

/**
 * Error codes that, at the sign-in exchange, point at this dashboard's own app credentials. Atlassian reports a wrong
 * client secret as `access_denied` "Unauthorized" or a 401, and a client it does not accept as `invalid_client` or
 * `unauthorized_client`. A reused or expired code is `invalid_grant`, which is not here.
 */
const CREDENTIAL_ERRORS = new Set(["invalid_client", "access_denied", "unauthorized_client"]);

const MISCONFIGURED =
  "Atlassian refused this dashboard's app credentials. Check ATLASSIAN_CLIENT_ID, ATLASSIAN_CLIENT_SECRET and the callback URL (ATLASSIAN_REDIRECT_URI) against the app in the Atlassian developer console";

/** Only at sign-in: a revoked refresh token also arrives as a 401 `unauthorized_client`, and must drop the grant. */
function refusesAppCredentials(status: number, body: TokenBody): boolean {
  return status === 401 || CREDENTIAL_ERRORS.has(body.error ?? "") || /redirect_uri/i.test(body.error_description ?? "");
}

/** Atlassian's answer for a log: the status, the error code and the start of its description, which carries no secret. */
function answerOf(status: number, body: TokenBody): string {
  const code = body.error ? ` ${body.error}` : "";
  const description =
    typeof body.error_description === "string" && body.error_description !== ""
      ? `: ${body.error_description.slice(0, MAX_DESCRIPTION)}`
      : "";
  return `Atlassian answered ${status}${code}${description}`;
}

/** Why no token was issued, as the error the caller acts on. */
function tokenFailure(step: Step, status: number, body: TokenBody): Error {
  if (step === "sign-in" && refusesAppCredentials(status, body)) {
    // The status, the code and Atlassian's description, which says whether the secret or the redirect URI is wrong.
    return new TrackerConfigurationError(MISCONFIGURED, { cause: new Error(answerOf(status, body)) });
  }
  const reason = body.error_description ?? body.error ?? "Atlassian did not issue a token";
  if (refusesToken(step, status, body)) return new UnauthorisedError(`Atlassian refused the ${step}. ${reason}`);
  return new UpstreamError(`Atlassian ${step} failed. ${reason}`, status);
}

async function bodyOf(response: Response, step: Step): Promise<TokenBody> {
  try {
    return (await response.json()) as TokenBody;
  } catch {
    throw new UpstreamError(`Atlassian sent an unreadable ${step} response`, response.status);
  }
}

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

  private async post(step: Step, grant: Record<string, string>): Promise<Response> {
    try {
      return await this.http(`${this.authBase}/oauth/token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ ...grant, client_id: this.clientId, client_secret: this.clientSecret }),
      });
    } catch (cause) {
      throw new UpstreamError(`Atlassian could not be reached during ${step}`, 502, { cause });
    }
  }

  /** `step` names the exchange in any error, so a log says which one failed. */
  private async token(step: Step, grant: Record<string, string>): Promise<TrackerGrant> {
    const response = await this.post(step, grant);
    const body = await bodyOf(response, step);
    if (!response.ok || !body.access_token) throw tokenFailure(step, response.status, body);
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: this.now() + (body.expires_in ?? 3600) * 1000,
    };
  }
}
