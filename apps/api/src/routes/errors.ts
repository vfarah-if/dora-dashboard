import type { ApiErrorBody } from "@dora-dashboard/core";
import type { FastifyError, FastifyInstance } from "fastify";
import {
  AccessRefusedError,
  AppError,
  ConflictError,
  ForbiddenError,
  RateLimitedError,
  NotFoundError,
  TrackerConfigurationError,
  UnauthorisedError,
  UpstreamError,
  ValidationError,
} from "../core/errors.js";

/**
 * The one place a service error becomes an HTTP status. Every error body is an `ApiErrorBody`: `error` is a message
 * fit to show, and `code` is added for an error the web acts on, such as a lost tracker connection.
 */
export function statusFor(error: unknown): number {
  if (error instanceof ValidationError) return 400;
  if (error instanceof UnauthorisedError) return 401;
  if (error instanceof ForbiddenError || error instanceof AccessRefusedError) return 403;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ConflictError) return 409;
  if (error instanceof RateLimitedError) return 429;
  if (error instanceof UpstreamError || error instanceof TrackerConfigurationError) return 502;
  return clientStatusOf(error) ?? 500;
}

/** The status Fastify itself chose for a request it refused, such as a body that is not valid JSON; only a client error counts. */
function clientStatusOf(error: unknown): number | null {
  const status = typeof error === "object" && error !== null ? (error as { statusCode?: unknown }).statusCode : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500 ? status : null;
}

export function registerErrorHandler(app: FastifyInstance): void {
  // Fastify's own handler logs and echoes the full URL, and an OAuth callback's query holds a one-time code.
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "Not found" } satisfies ApiErrorBody));
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if ("validation" in error && error.validation) {
      return reply.code(400).send({ error: error.message } satisfies ApiErrorBody);
    }
    const status = statusFor(error);
    if (status === 500) {
      request.log.error({ err: error }, "unhandled error");
      return reply.code(500).send({ error: "Something went wrong on the server" } satisfies ApiErrorBody);
    }
    // A refusal or an upstream failure is not the caller's fault to fix, so the server records why.
    if (status === 403 || status === 502) request.log.warn({ err: error }, "request refused or upstream failed");
    const body: ApiErrorBody = { error: error.message };
    if (error instanceof AppError && error.code !== null) body.code = error.code;
    return reply.code(status).send(body);
  });
}
