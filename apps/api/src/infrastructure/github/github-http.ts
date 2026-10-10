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

/** The start of the message for a rate limit, so a caller can tell it from another 403. */
export const RATE_LIMIT_MESSAGE = "GitHub's rate limit for this token was reached";

/** Raises the error for a response that is not a success, and returns for one that is. */
export async function throwForStatus(response: Response): Promise<void> {
  if (response.status === 401) throw new UnauthorisedError("GitHub rejected the credential; sign in again");
  if (response.status === 404) throw new NotFoundError("GitHub could not find that, or the credential cannot see it");
  if (isRateLimited(response)) {
    const when = resetTime(response);
    throw new UpstreamError(`${RATE_LIMIT_MESSAGE}; try again ${when === null ? "later" : `after ${when}`}`, response.status);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new UpstreamError(`GitHub answered ${response.status}: ${body.slice(0, 300)}`, response.status);
  }
}

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
  await throwForStatus(response);
  return (await response.json()) as T;
}

/** A download may take longer than an API call, as an artefact can be tens of megabytes. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

const tooLarge = () => new UpstreamError("The artefact is larger than the limit for reading coverage", 502);

/** Reads a body into memory, refusing at once when it declares more than `maxBytes` and stopping when it streams more. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (response.headers.get("content-length") && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Sends a download request, mapping a failure to reach the host to a message that carries no address. */
async function fetchOnce(http: Fetch, url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await http(url, { redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new UpstreamError(
      timedOut
        ? `GitHub did not deliver the artefact within ${DOWNLOAD_TIMEOUT_MS / 1000} seconds`
        : "GitHub could not be reached to download the artefact",
      timedOut ? 504 : 502,
    );
  }
}

/**
 * Downloads a GitHub artefact archive. GitHub answers the API address with a redirect to a signed address on its
 * storage host, so the redirect is followed by hand: the token goes only to the API host, the second request carries
 * no `Authorization` header, and the signed address must be https. Nothing larger than `maxBytes` is read, whether
 * the size is declared or only discovered while streaming. No message carries the token or either address.
 */
export async function download(http: Fetch, token: string, url: string, maxBytes: number): Promise<Uint8Array> {
  const first = await fetchOnce(http, url, {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "dora-dashboard",
  });
  if (first.status === 410) throw new NotFoundError("The artefact has expired or been deleted");
  if (![301, 302, 303, 307, 308].includes(first.status)) {
    await throwForStatus(first);
    return readCapped(first, maxBytes);
  }

  const location = first.headers.get("location");
  await first.body?.cancel();
  let target: URL | null;
  try {
    target = location ? new URL(location, url) : null;
  } catch {
    target = null;
  }
  if (!target || target.protocol !== "https:") {
    throw new UpstreamError("GitHub redirected the artefact download somewhere that is not https", 502);
  }

  const second = await fetchOnce(http, target.toString(), { "User-Agent": "dora-dashboard" });
  if (second.status === 404 || second.status === 410) throw new NotFoundError("The artefact has expired or been deleted");
  if (!second.ok) throw new UpstreamError(`GitHub's artefact storage answered ${second.status}`, second.status);
  return readCapped(second, maxBytes);
}

/** Gateway statuses worth one retry with a smaller page. */
export const RETRYABLE = new Set([502, 504]);
