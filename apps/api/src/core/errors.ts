/** Errors services raise; routes map each class to one HTTP status in `routes/errors.ts`. */
export class AppError extends Error {
  override readonly name: string = "AppError";
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
 * `error: "jira_unauthorised"` so the web can offer to connect again rather than treat it as a GitHub sign-out.
 */
export class TrackerUnauthorisedError extends UnauthorisedError {
  override readonly name = "TrackerUnauthorisedError";
  readonly code = "jira_unauthorised";
}
