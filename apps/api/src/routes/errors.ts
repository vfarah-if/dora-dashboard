import type { FastifyError, FastifyInstance } from "fastify";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  RateLimitedError,
  TrackerUnauthorisedError,
  NotFoundError,
  UnauthorisedError,
  UpstreamError,
  ValidationError,
} from "../core/errors.js";

/** The one place a service error becomes an HTTP status. Every error body is `{ error: string }`; a lost tracker connection adds `message`. */
export function statusFor(error: unknown): number {
  if (error instanceof ValidationError) return 400;
  if (error instanceof UnauthorisedError) return 401;
  if (error instanceof ForbiddenError) return 403;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ConflictError) return 409;
  if (error instanceof RateLimitedError) return 429;
  if (error instanceof UpstreamError) return 502;
  return 500;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if ("validation" in error && error.validation) {
      return reply.code(400).send({ error: error.message });
    }
    if (error instanceof TrackerUnauthorisedError) {
      return reply.code(401).send({ error: error.code, message: error.message });
    }
    const status = statusFor(error);
    if (status === 500) {
      request.log.error({ err: error }, "unhandled error");
      return reply.code(500).send({ error: "Something went wrong on the server" });
    }
    return reply.code(status).send({ error: error instanceof AppError ? error.message : String(error) });
  });
}
