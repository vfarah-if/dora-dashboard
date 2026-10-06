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
      if (response.ok) throw new ApiError(response.status, copy.common.unreadableResponse);
      body = null;
    }
  }
  if (!response.ok) throw errorFrom(body, response.status);
  return body as T;
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return copy.common.errorTitle;
}
