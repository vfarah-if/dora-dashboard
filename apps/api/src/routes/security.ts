import type { SecurityReport, SecuritySummary } from "@dora-dashboard/core";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { idParams, securityListQuery, securityReportQuery } from "../schemas/requests.js";
import type { SecurityReportService } from "../services/security-report-service.js";

export interface SecurityRouteDeps {
  guard: preHandlerAsyncHookHandler;
  reports: SecurityReportService;
}

/**
 * Security reports read stored data only, so they work whether or not an alert source is wired (ADR 0031). Neither
 * response carries a login or a secret value.
 */
export function registerSecurityRoutes(app: FastifyInstance, deps: SecurityRouteDeps): void {
  const { guard, reports } = deps;

  /** One summary per repository, worst first, or only those in `ids`. */
  app.get<{ Querystring: { ids?: string } }>(
    "/api/security",
    { preHandler: guard, schema: { querystring: securityListQuery } },
    async (request): Promise<SecuritySummary[]> => reports.summaries(request.query.ids?.split(",").map(Number)),
  );

  app.get<{ Params: { id: number }; Querystring: { from?: string; to?: string } }>(
    "/api/repos/:id/security",
    { preHandler: guard, schema: { params: idParams, querystring: securityReportQuery } },
    async (request): Promise<SecurityReport> => {
      const { from, to } = request.query;
      return reports.report(request.params.id, { from, to });
    },
  );
}
