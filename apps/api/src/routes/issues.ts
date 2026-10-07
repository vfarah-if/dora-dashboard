import type { IssueLabelRules, IssueReport, RepoListing } from "@dora-dashboard/core";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Config } from "../core/config.js";
import { idParams, issueLabelsBody, spaceReportQuery } from "../schemas/requests.js";
import type { IssueReportService } from "../services/issue-report-service.js";
import type { RepoService } from "../services/repo-service.js";
import { requireSameOrigin } from "./auth.js";

export interface IssueRouteDeps {
  guard: preHandlerAsyncHookHandler;
  config: Config;
  repos: RepoService;
  reports: IssueReportService;
}

export function registerIssueRoutes(app: FastifyInstance, deps: IssueRouteDeps): void {
  const { guard, config, repos, reports } = deps;

  /** The repository's issue report over `from` to `to`; names appear only with `people=1` (ADR 0008). Reads stored data, so it works whether or not a provider is wired. */
  app.get<{ Params: { id: number }; Querystring: { from?: string; to?: string; people?: "0" | "1" } }>(
    "/api/repos/:id/issues/report",
    { preHandler: guard, schema: { params: idParams, querystring: spaceReportQuery } },
    async (request): Promise<IssueReport> => {
      const { from, to, people } = request.query;
      return reports.report(request.params.id, { from, to, people: people === "1" });
    },
  );

  /**
   * Saves which label names mean which kind and priority for one repository, or puts the defaults back with
   * `{ "labels": null }`. Answers 200 with the repository's updated listing row, so the page can refresh in place.
   * Reports read the rules when they are built, so this starts no crawl.
   */
  app.put<{ Params: { id: number }; Body: { labels: IssueLabelRules | null } }>(
    "/api/repos/:id/issue-labels",
    { preHandler: [requireSameOrigin(config), guard], schema: { params: idParams, body: issueLabelsBody } },
    async (request): Promise<RepoListing> => repos.setIssueLabels(request.params.id, request.body.labels),
  );
}
