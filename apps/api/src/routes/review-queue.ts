import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { reviewQueueQuery } from "../schemas/requests.js";
import type { ReviewQueueService } from "../services/review-queue-service.js";

export interface ReviewQueueRouteDeps {
  guard: preHandlerAsyncHookHandler;
  queue: ReviewQueueService;
}

export function registerReviewQueueRoutes(app: FastifyInstance, deps: ReviewQueueRouteDeps): void {
  app.get<{ Querystring: { ids?: string; refresh?: "0" | "1"; refreshIds?: string; names?: "0" | "1" } }>(
    "/api/review-queue",
    { preHandler: deps.guard, schema: { querystring: reviewQueueQuery } },
    async (request) => {
      const { query } = request;
      const ids = query.ids?.split(",").map(Number);
      return deps.queue.queue(request.session!.token, ids, {
        refresh: query.refresh === "1" || (query.refreshIds?.split(",").map(Number) ?? false),
        names: query.names === "1",
      });
    },
  );
}
