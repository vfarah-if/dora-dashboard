import type { AcceptanceRequest, FindingAcceptance } from "@dora-dashboard/core";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Config } from "../core/config.js";
import { acceptanceBody, acceptanceParams, idParams } from "../schemas/requests.js";
import type { SecurityAcceptanceService } from "../services/security-acceptance-service.js";
import { requireSameOrigin } from "./auth.js";

export interface SecurityAcceptanceRouteDeps {
  guard: preHandlerAsyncHookHandler;
  config: Config;
  acceptances: SecurityAcceptanceService;
}

/**
 * Each of the two routes allows a client 30 requests a minute, counted on its own, which a person at a page never
 * reaches. `@fastify/rate-limit` gives every route its own store, and its `groupId` only changes the key within that
 * store, so the two routes cannot share one bucket of 30 without a store of our own.
 */
const ACCEPTANCE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

/**
 * Accepting a finding of the clone, with a reason and a note (ADR 0040). The routes copy the review exemption routes: a
 * same-origin check, then the session guard. Neither answer carries a login, and no session value is stored.
 */
export function registerSecurityAcceptanceRoutes(app: FastifyInstance, deps: SecurityAcceptanceRouteDeps): void {
  const { guard, config, acceptances } = deps;
  const preHandler = [requireSameOrigin(config), guard];

  app.post<{ Params: { id: number }; Body: AcceptanceRequest }>(
    "/api/repos/:id/security/acceptances",
    { preHandler, schema: { params: idParams, body: acceptanceBody }, config: { rateLimit: ACCEPTANCE_RATE_LIMIT } },
    async (request, reply): Promise<FindingAcceptance> => {
      const { check, path, fingerprint, reason, note } = request.body;
      // Only these five fields are read, so nothing else a client sends can reach the service.
      return reply.code(201).send(acceptances.accept(request.params.id, { check, path, fingerprint, reason, note }));
    },
  );

  app.delete<{ Params: { id: number; acceptanceId: number } }>(
    "/api/repos/:id/security/acceptances/:acceptanceId",
    { preHandler, schema: { params: acceptanceParams }, config: { rateLimit: ACCEPTANCE_RATE_LIMIT } },
    async (request, reply): Promise<void> => {
      acceptances.remove(request.params.id, request.params.acceptanceId);
      return reply.code(204).send();
    },
  );
}
