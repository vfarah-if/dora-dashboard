import { isIP } from "node:net";
import { AppError, NotFoundError, UnauthorisedError, UpstreamError } from "../../core/errors.js";
import { parseJsonValue, readCappedText } from "../http/capped-text.js";
import type { Fetch } from "../http/fetch.js";

export const API = "https://api.github.com";

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

/** The most redirects followed for one request. GitHub's answer for a renamed repository is a single one. */
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * The address `target` names relative to `from`, when it is https on the same origin as `origin` (by default `from`), else null. This is the
 * one rule for any address GitHub hands back, so the token can never be sent to another host or over http.
 */
function sameOriginHttps(target: string, from: string, origin = from): string | null {
  try {
    const url = new URL(target, from);
    return url.protocol === "https:" && url.origin === new URL(origin).origin ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Maps a failure to reach GitHub or a timeout to an error that carries no address. */
function fromTransport(error: unknown): unknown {
  if (error instanceof Error && error.name === "TimeoutError") {
    return new UpstreamError(`GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`, 504);
  }
  return error;
}

/**
 * Sends one API request with the token. Redirects are followed here, by hand, at most three and only to https on the
 * origin of the original request, so the token never leaves GitHub's API host whatever the runtime does with
 * `Authorization` on a redirect. A timeout is mapped to a gateway timeout that carries no address.
 */
async function send(http: Fetch, token: string, url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let target = url;
  let current: RequestInit = init;
  for (let hops = 0; ; hops++) {
    let response: Response;
    try {
      response = await http(target, {
        ...current,
        redirect: "manual",
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "dora-dashboard",
          ...init.headers,
        },
      });
    } catch (error) {
      throw fromTransport(error);
    }
    if (!REDIRECTS.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    const next = location === null ? null : sameOriginHttps(location, target, url);
    if (next === null) {
      throw new UpstreamError("GitHub redirected the request somewhere that is not allowed", 502);
    }
    if (hops === MAX_REDIRECTS) throw new UpstreamError("GitHub redirected the request too many times", 502);
    target = next;
    // A 303 asks for the result with a plain GET; the others repeat the request as it was.
    if (response.status === 303) current = { ...current, method: "GET", body: null };
  }
}

/** The most one reply is read up to. A page of 100 alerts or pull requests is far below it. */
const MAX_REPLY_BYTES = 16 * 1024 * 1024;

/** The reply's JSON, read up to the cap; a body that is not JSON or is too large is an `UpstreamError`. */
async function readJson(response: Response): Promise<unknown> {
  return parseJsonValue(await readCappedText(response, MAX_REPLY_BYTES, "GitHub"), "GitHub");
}

export async function request<T>(http: Fetch, token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await send(http, token, url, init);
  await throwForStatus(response);
  return (await readJson(response)) as T;
}

/** The longest `Link` header read; a longer one is treated as having no next page. */
const MAX_LINK_HEADER = 4096;

/**
 * The address of the next page in a `Link` header, or null when there is none. Only an https address on the same
 * origin as `from` is accepted, so a header that points elsewhere can never receive the token.
 */
export function nextLink(header: string | null, from: string): string | null {
  if (!header || header.length > MAX_LINK_HEADER) return null;
  for (const [, target = "", params = ""] of header.matchAll(/<([^>]*)>([^<]*)/g)) {
    if (!/;\s*rel\s*=\s*"?next"?\s*(?:[;,]|$)/i.test(params)) continue;
    return sameOriginHttps(target, from);
  }
  return null;
}

/** One page of a list, with where the next is, or a refusal the caller expected and can classify. */
export type PageResult<T> = { body: T; next: string | null } | { status: number; message: string };

/** The text GitHub gives as the reason for a refusal, cut short; empty when the body is not the usual JSON. */
async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await readJson(response)) as { message?: unknown } | null;
    return typeof body?.message === "string" ? body.message.slice(0, 300) : "";
  } catch {
    return "";
  }
}

/**
 * Reads one page of a list. A 401 raises `UnauthorisedError` and a rate limit raises the rate limit error, both before
 * any refusal is looked at, so a rate-limited 403 is never read as "switched off". A 403 or 404 named in `refusals`
 * returns its status and GitHub's message for the caller to classify; any other failure is raised as `request` does.
 */
export async function requestPage<T>(
  http: Fetch,
  token: string,
  url: string,
  refusals: readonly number[],
): Promise<PageResult<T>> {
  const response = await send(http, token, url, {});
  if (response.status === 401 || isRateLimited(response)) await throwForStatus(response);
  if (refusals.includes(response.status)) return { status: response.status, message: await messageOf(response) };
  await throwForStatus(response);
  return { body: (await readJson(response)) as T, next: nextLink(response.headers.get("link"), url) };
}

/** A download may take longer than an API call, as an artefact can be tens of megabytes. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

const deliveryTimeout = (cause: unknown) =>
  new UpstreamError(`GitHub did not deliver the artefact within ${DOWNLOAD_TIMEOUT_MS / 1000} seconds`, 504, { cause });

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
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "TimeoutError") throw deliveryTimeout(error);
    throw new UpstreamError("The download of the artefact was interrupted", 502, { cause: error });
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** The four bytes of an IPv4 address as a number list, or null when `host` is not one. */
const ipv4Parts = (host: string): number[] | null => {
  if (isIP(host) !== 4) return null;
  return host.split(".").map(Number);
};

const isPrivateIpv4 = ([a, b]: number[]): boolean =>
  a === 0 ||
  a === 127 ||
  a === 10 ||
  (a === 100 && b! >= 64 && b! <= 127) ||
  (a === 172 && b! >= 16 && b! <= 31) ||
  (a === 192 && b === 168) ||
  (a === 169 && b === 254);

/** The eight 16-bit groups of an IPv6 address, or null when `host` is not one. */
function ipv6Groups(host: string): number[] | null {
  if (isIP(host) !== 6) return null;
  const [head = "", tail] = host.split("::") as [string, string | undefined];
  const groupsOf = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").flatMap((group) => {
          if (!group.includes(".")) return [parseInt(group, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
          return [a * 256 + b, c * 256 + d];
        });
  const before = groupsOf(head);
  const after = tail === undefined ? [] : groupsOf(tail);
  const gap = tail === undefined ? 0 : 8 - before.length - after.length;
  return [...before, ...new Array<number>(gap).fill(0), ...after];
}

/**
 * Whether a redirect may not be followed to `hostname`: `localhost`, and any IP literal that is loopback, private,
 * link-local or unspecified, including an IPv4 address written as IPv6. A name that merely resolves to such an address
 * is not caught, since resolving it here would not bind the connection that is made later.
 */
export function isForbiddenHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = ipv4Parts(host);
  if (v4) return isPrivateIpv4(v4);
  const g = ipv6Groups(host);
  if (!g) return false;
  const embedded = (hi: number, lo: number) => isPrivateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    // Unspecified, loopback and IPv4-mapped or compatible forms, which are judged by the IPv4 address they carry.
    if (g5 === 0 && g6 === 0 && g7 <= 1) return true;
    return embedded(g6, g7);
  }
  // NAT64 (64:ff9b::/96) and SIIT (::ffff:0:0/96) carry the IPv4 address in the last 32 bits, 6to4 (2002::/16) in bits 16 to 48.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return embedded(g6, g7);
  if (g0 === 0x2002) return embedded(g1, g2);
  // Unique local (fc00::/7), link-local (fe80::/10) and the deprecated site-local range (fec0::/10).
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0;
}

/** Sends a download request, mapping a failure to reach the host to a message that carries no address. */
async function fetchOnce(http: Fetch, url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await http(url, { redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw deliveryTimeout(error);
    throw new UpstreamError("GitHub could not be reached to download the artefact", 502, { cause: error });
  }
}

/**
 * Downloads a GitHub artefact archive. GitHub answers the API address with a redirect to a signed address on its
 * storage host, so the redirect is followed by hand: the token goes only to the API host, the second request carries
 * no `Authorization` header, and the signed address must be https and not name this machine or a private network. Nothing larger than `maxBytes` is read, whether
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
  if (isForbiddenHost(target.hostname)) {
    throw new UpstreamError("GitHub redirected the artefact download to an address that is not allowed", 502);
  }

  const second = await fetchOnce(http, target.toString(), { "User-Agent": "dora-dashboard" });
  if (second.status === 404 || second.status === 410) throw new NotFoundError("The artefact has expired or been deleted");
  if (!second.ok) throw new UpstreamError(`GitHub's artefact storage answered ${second.status}`, second.status);
  return readCapped(second, maxBytes);
}

/** Gateway statuses worth one retry with a smaller page. */
export const RETRYABLE = new Set([502, 504]);
