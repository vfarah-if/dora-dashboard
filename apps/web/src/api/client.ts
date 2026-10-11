import type { ApiErrorBody, ApiErrorCode } from "@dora-dashboard/core";
import { copy } from "../copy";

/**
 * An API failure carrying the HTTP status, a message fit to show (the API's own `error` where it gave one) and the
 * API's stable `code` for an error the page acts on, or null.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | null;

  constructor(status: number, message: string, code: ApiErrorCode | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Every code the API can send. A record rather than a list, so a code added in core must be added here too. */
const API_ERROR_CODES: Record<ApiErrorCode, true> = { jira_unauthorised: true };

const isApiErrorCode = (value: unknown): value is ApiErrorCode =>
  typeof value === "string" && Object.hasOwn(API_ERROR_CODES, value);

/** The error a failed response stands for. A body that is not an `ApiErrorBody` still gives a readable message. */
function errorFrom(body: unknown, status: number): ApiError {
  const { error, code } = (body && typeof body === "object" ? body : {}) as Partial<Record<keyof ApiErrorBody, unknown>>;
  const message = typeof error === "string" && error.trim() ? error : copy.common.requestFailed(status);
  // A code this build does not know, from a newer API, is treated as none, so the plain message is shown.
  return new ApiError(status, message, isApiErrorCode(code) ? code : null);
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/** What a failure to reach the API, or to finish reading its answer, throws: an abort untouched, else a network `ApiError`. */
const networkFailure = (error: unknown): Error =>
  error instanceof DOMException && error.name === "AbortError" ? error : new ApiError(0, copy.common.networkFailed);

/** Sends the request. An abort passes through untouched; any other failure to reach the API is a network `ApiError`. */
async function send(path: string, options: RequestOptions): Promise<Response> {
  try {
    return await fetch(path, {
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
    throw networkFailure(error);
  }
}

/** Reads the body as text. A connection that drops part way through fails as one that never connected does. */
async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw networkFailure(error);
  }
}

/** Parses a response body. An empty or (on a failed response) unreadable body is null; an unreadable 2xx throws. */
function parseBody(text: string, response: Response): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (response.ok) throw new ApiError(response.status, copy.common.unreadableResponse);
    return null;
  }
}

/** Fetches JSON from the API. Resolves undefined for a 204 and throws `ApiError` for any non-2xx status. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);

  if (response.status === 204) return undefined as T;

  const body = parseBody(await readText(response), response);
  if (!response.ok) throw errorFrom(body, response.status);
  return body as T;
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return copy.common.errorTitle;
}
