import { isIP } from "node:net";
import { AppError, NotFoundError, UnauthorisedError, UpstreamError } from "../../core/errors.js";

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

const deliveryTimeout = (cause: unknown) =>
  new UpstreamError(`GitHub did not deliver the artefact within ${DOWNLOAD_TIMEOUT_MS / 1000} seconds`, 504, { cause });

const tooLarge = () => new UpstreamError("The artefact is larger than the limit for reading coverage", 502);

/** Whether a response declares, in a `content-length` that is a finite number, a body larger than `maxBytes`. */
function declaresMoreThan(response: Response, maxBytes: number): boolean {
  const declared = Number(response.headers.get("content-length"));
  return Boolean(response.headers.get("content-length")) && Number.isFinite(declared) && declared > maxBytes;
}

/** The error a failed read of a body becomes: an application error such as the cap stands, anything else is mapped. */
function readFailure(error: unknown): Error {
  if (error instanceof AppError) return error;
  if (error instanceof Error && error.name === "TimeoutError") return deliveryTimeout(error);
  return new UpstreamError("The download of the artefact was interrupted", 502, { cause: error });
}

/** The chunks of a body joined into one array of `size` bytes. */
function joined(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Reads a body into memory, refusing at once when it declares more than `maxBytes` and stopping when it streams more. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (declaresMoreThan(response, maxBytes)) {
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
    throw readFailure(error);
  }
  return joined(chunks, size);
}

/** The four bytes of an IPv4 address as a number list, or null when `host` is not one. */
const ipv4Parts = (host: string): number[] | null => {
  if (isIP(host) !== 4) return null;
  return host.split(".").map(Number);
};

/** First octets whose whole /8 is internal: this network (0.0.0.0/8), private (10.0.0.0/8) and loopback (127.0.0.0/8). */
const INTERNAL_IPV4_BLOCKS = new Set([0, 10, 127]);

/**
 * The second octets, inclusive, that are internal under a first octet: shared address space (100.64.0.0/10),
 * link-local (169.254.0.0/16) and private (172.16.0.0/12, 192.168.0.0/16).
 */
const INTERNAL_IPV4_RANGES = new Map<number, readonly [number, number]>([
  [100, [64, 127]],
  [169, [254, 254]],
  [172, [16, 31]],
  [192, [168, 168]],
]);

const isPrivateIpv4 = ([a, b]: number[]): boolean => {
  if (INTERNAL_IPV4_BLOCKS.has(a!)) return true;
  const range = INTERNAL_IPV4_RANGES.get(a!);
  return range !== undefined && b! >= range[0] && b! <= range[1];
};

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

/** Whether the IPv4 address held in two IPv6 groups, `hi` then `lo`, is internal. */
const carriesPrivateIpv4 = (hi: number, lo: number): boolean => isPrivateIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);

/**
 * IPv6 ranges that carry an IPv4 address and are judged by it: the groups an address in the range starts with, and the
 * index of the first of the two groups that hold the IPv4 address.
 */
const IPV4_CARRIERS: readonly { prefix: readonly number[]; at: number }[] = [
  // IPv4-compatible and IPv4-mapped forms.
  { prefix: [0, 0, 0, 0, 0, 0], at: 6 },
  { prefix: [0, 0, 0, 0, 0, 0xffff], at: 6 },
  // NAT64 (64:ff9b::/96) and SIIT (::ffff:0:0:0/96) carry the IPv4 address in the last 32 bits, 6to4 (2002::/16) in
  // bits 16 to 48.
  { prefix: [0x64, 0xff9b, 0, 0, 0, 0], at: 6 },
  { prefix: [0, 0, 0, 0, 0xffff, 0], at: 6 },
  { prefix: [0x2002], at: 1 },
];

const startsWith = (groups: number[], prefix: readonly number[]): boolean => prefix.every((group, i) => groups[i] === group);

/** The unspecified address (::) and loopback (::1). */
const isUnspecifiedOrLoopback = (groups: number[]): boolean => startsWith(groups, [0, 0, 0, 0, 0, 0, 0]) && groups[7]! <= 1;

/** Unique local (fc00::/7), link-local (fe80::/10) and the deprecated site-local range (fec0::/10), by the first group. */
const isInternalIpv6Range = (first: number): boolean =>
  (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0;

/** Whether an IPv6 address, as its groups, is unspecified, loopback or internal, or carries an internal IPv4 address. */
function isForbiddenIpv6(groups: number[]): boolean {
  if (isUnspecifiedOrLoopback(groups)) return true;
  const carrier = IPV4_CARRIERS.find(({ prefix }) => startsWith(groups, prefix));
  if (carrier) return carriesPrivateIpv4(groups[carrier.at]!, groups[carrier.at + 1]!);
  return isInternalIpv6Range(groups[0]!);
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
  const groups = ipv6Groups(host);
  return groups !== null && isForbiddenIpv6(groups);
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

/** Where a redirect from `url` to `location` leads, refused unless it is https and names no address that is not allowed. */
function redirectTarget(location: string | null, url: string): URL {
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
  return target;
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
  const target = redirectTarget(location, url);

  const second = await fetchOnce(http, target.toString(), { "User-Agent": "dora-dashboard" });
  if (second.status === 404 || second.status === 410) throw new NotFoundError("The artefact has expired or been deleted");
  if (!second.ok) throw new UpstreamError(`GitHub's artefact storage answered ${second.status}`, second.status);
  return readCapped(second, maxBytes);
}

/** Gateway statuses worth one retry with a smaller page. */
export const RETRYABLE = new Set([502, 504]);
