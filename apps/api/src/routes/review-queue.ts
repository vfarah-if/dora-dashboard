import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { reviewQueueQuery } from "../schemas/requests.js";
import type { RefreshScope, ReviewQueueService } from "../services/review-queue-service.js";

export interface ReviewQueueRouteDeps {
  guard: preHandlerAsyncHookHandler;
  queue: ReviewQueueService;
}

/** `refresh=1` reads every repository and wins over `refreshIds`; neither means an ordinary request. */
function refreshScope(refresh: string | undefined, refreshIds: string | undefined): RefreshScope | undefined {
  if (refresh === "1") return "all";
  return refreshIds ? { only: refreshIds.split(",").map(Number) } : undefined;
}

export function registerReviewQueueRoutes(app: FastifyInstance, deps: ReviewQueueRouteDeps): void {
  app.get<{ Querystring: { ids?: string; refresh?: "0" | "1"; refreshIds?: string; names?: "0" | "1" } }>(
    "/api/review-queue",
    { preHandler: deps.guard, schema: { querystring: reviewQueueQuery } },
    async (request) => {
      const { query } = request;
      const ids = query.ids?.split(",").map(Number);
      return deps.queue.queue(request.session!.token, ids, {
        refresh: refreshScope(query.refresh, query.refreshIds),
        names: query.names === "1",
      });
    },
  );
}
