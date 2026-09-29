import { copy } from "../copy";

/** An API failure carrying the HTTP status and the API's own `{ error }` message where it gave one. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const { error } = body as { error: unknown };
    if (typeof error === "string" && error.trim()) return error;
  }
  return copy.common.requestFailed(status);
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/** Fetches JSON from the API. Resolves undefined for a 204 and throws `ApiError` for any non-2xx status. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers:
        options.body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, copy.common.networkFailed);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) throw new ApiError(response.status, errorMessage(body, response.status));
  return body as T;
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return copy.common.errorTitle;
}
