import type { RepoListing, ReviewExemptionDefaults, ReviewExemptionRules } from "@dora-dashboard/core";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Config } from "../core/config.js";
import { idParams, reviewExemptionsBody } from "../schemas/requests.js";
import type { RepoService } from "../services/repo-service.js";
import { requireSameOrigin } from "./auth.js";

export interface ReviewExemptionRouteDeps {
  guard: preHandlerAsyncHookHandler;
  config: Config;
  repos: RepoService;
}

/** The rules for leaving a merged pull request out of "merged with no review" (ADR 0036). */
export function registerReviewExemptionRoutes(app: FastifyInstance, deps: ReviewExemptionRouteDeps): void {
  const { guard, config, repos } = deps;

  /** The title words and labels every repository starts with and the limits an override must keep to. */
  app.get("/api/review-exemptions/defaults", { preHandler: guard }, async (): Promise<ReviewExemptionDefaults> =>
    repos.reviewExemptionDefaults(),
  );

  /**
   * Saves the repository's title words and labels, or puts the defaults back with `{ "exemptions": null }`. Answers 200
   * with the repository's updated listing row. Reports read the rules when they are built, so this starts no crawl.
   */
  app.put<{ Params: { id: number }; Body: { exemptions: ReviewExemptionRules | null } }>(
    "/api/repos/:id/review-exemptions",
    { preHandler: [requireSameOrigin(config), guard], schema: { params: idParams, body: reviewExemptionsBody } },
    async (request): Promise<RepoListing> => repos.setReviewExemptions(request.params.id, request.body.exemptions),
  );
}
