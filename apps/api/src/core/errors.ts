import type { ApiErrorCode } from "@dora-dashboard/core";

/**
 * Errors services raise; routes map each class to one HTTP status in `routes/errors.ts`. The message is sent to the
 * person as it is, so it must be fit to show; `code`, when set, is sent beside it for the web to act on.
 */
export class AppError extends Error {
  override readonly name: string = "AppError";
  readonly code: ApiErrorCode | null = null;
}

export class NotFoundError extends AppError {
  override readonly name = "NotFoundError";
}

export class ConflictError extends AppError {
  override readonly name = "ConflictError";
}

export class ValidationError extends AppError {
  override readonly name = "ValidationError";
}

export class UnauthorisedError extends AppError {
  override readonly name: string = "UnauthorisedError";
}

/** The code host answered, but not with what we asked for. */
export class UpstreamError extends AppError {
  override readonly name = "UpstreamError";
  constructor(
    message: string,
    readonly status: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The caller is asking too often; routes answer 429. */
export class RateLimitedError extends AppError {
  override readonly name = "RateLimitedError";
}

/** The request came from somewhere we do not serve; routes answer 403. */
export class ForbiddenError extends AppError {
  override readonly name = "ForbiddenError";
}

/**
 * The person's issue tracker connection is missing, expired or refused. It is still a 401, but routes send
 * `code: "jira_unauthorised"` beside the message so the web can offer to connect again rather than treat it as a
 * GitHub sign-out.
 */
export class TrackerUnauthorisedError extends UnauthorisedError {
  override readonly name = "TrackerUnauthorisedError";
  override readonly code: ApiErrorCode = "jira_unauthorised";
}

/**
 * The tracker refused this dashboard's own app credentials (client ID, client secret or callback URL) during sign-in.
 * It is the operator who can fix that, not the person signing in, so the callback redirects with
 * `jira=misconfigured` and logs at error level, and any other route would answer 502.
 */
export class TrackerConfigurationError extends AppError {
  override readonly name = "TrackerConfigurationError";
}

/**
 * An external system understood the request and refused it for this credential, for example Jira answering 403
 * because the connected account lacks permission on a space or the app lacks a scope. It is not `ForbiddenError`
 * (the request came from somewhere we do not serve) and not `NotFoundError` (the resource may well exist). Routes
 * answer 403; the message says what was refused and never carries a token.
 */
export class AccessRefusedError extends AppError {
  override readonly name = "AccessRefusedError";
}
