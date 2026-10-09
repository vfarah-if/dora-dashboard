import { NotFoundError, UnauthorisedError, UpstreamError } from "../../core/errors.js";

export const API = "https://api.github.com";

export type Fetch = typeof fetch;

/** How long one request may take before it is given up as a gateway timeout, which the page readers retry smaller. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * When GitHub says the limit lifts, as an ISO time. `retry-after` (seconds) comes first, because GitHub sends it for a
 * secondary limit and asks callers to wait that long, whatever the primary window's `x-ratelimit-reset` (epoch seconds)
 * says.
 */
function resetTime(response: Response): string | null {
  const wait = Number(response.headers.get("retry-after"));
  if (response.headers.get("retry-after") && Number.isFinite(wait)) return new Date(Date.now() + wait * 1000).toISOString();
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.get("x-ratelimit-reset") && Number.isFinite(reset)) return new Date(reset * 1000).toISOString();
  return null;
}

const isRateLimited = (response: Response): boolean =>
  (response.status === 403 || response.status === 429) &&
  (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));

export async function request<T>(http: Fetch, token: string, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await http(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dora-dashboard",
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new UpstreamError(`GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`, 504);
    }
    throw error;
  }
  if (response.status === 401) throw new UnauthorisedError("GitHub rejected the credential; sign in again");
  if (response.status === 404) throw new NotFoundError("GitHub could not find that, or the credential cannot see it");
  if (isRateLimited(response)) {
    const when = resetTime(response);
    throw new UpstreamError(
      `GitHub's rate limit for this token was reached; try again ${when === null ? "later" : `after ${when}`}`,
      response.status,
    );
  }
  if (!response.ok) {
    const body = await response.text();
    throw new UpstreamError(`GitHub answered ${response.status}: ${body.slice(0, 300)}`, response.status);
  }
  return (await response.json()) as T;
}

/** Gateway statuses worth one retry with a smaller page. */
export const RETRYABLE = new Set([502, 504]);
