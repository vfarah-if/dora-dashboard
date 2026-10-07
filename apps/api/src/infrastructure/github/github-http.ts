import { NotFoundError, UnauthorisedError, UpstreamError } from "../../core/errors.js";

export const API = "https://api.github.com";

export type Fetch = typeof fetch;

export async function request<T>(http: Fetch, token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await http(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dora-dashboard",
      ...init.headers,
    },
  });
  if (response.status === 401) throw new UnauthorisedError("GitHub rejected the credential; sign in again");
  if (response.status === 404) throw new NotFoundError("GitHub could not find that, or the credential cannot see it");
  if (!response.ok) {
    const body = await response.text();
    throw new UpstreamError(`GitHub answered ${response.status}: ${body.slice(0, 300)}`, response.status);
  }
  return (await response.json()) as T;
}

/** Gateway statuses worth one retry with a smaller page. */
export const RETRYABLE = new Set([502, 504]);
