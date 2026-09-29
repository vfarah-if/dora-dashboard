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
  override readonly name = "UnauthorisedError";
}

/** The code host answered, but not with what we asked for. */
export class UpstreamError extends AppError {
  override readonly name = "UpstreamError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
