import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Config } from "../core/config.js";
import { TrackerUnauthorisedError } from "../core/errors.js";
import type { TrackerAuthorisation } from "../interfaces/tracker-authorisation.js";
import {
  crawlQuery,
  idParams,
  jiraCallbackQuery,
  jiraSiteParams,
  jiraSpaceParams,
  jiraStartQuery,
  linkSpacesBody,
  spaceReportQuery,
} from "../schemas/requests.js";
import type { JiraAuthService } from "../services/jira-auth-service.js";
import type { SpaceReportService } from "../services/space-report-service.js";
import type { TrackerService } from "../services/tracker-service.js";
import { requireSameOrigin, signedCookie } from "./auth.js";

const STATE_COOKIE = "dora_jira_state";
const RETURN_COOKIE = "dora_jira_return";
const STATE_MAX_AGE_SECONDS = 600;
const DEFAULT_RETURN = "/repos";

export interface JiraRouteDeps {
  guard: preHandlerAsyncHookHandler;
  config: Config;
  authorisation: TrackerAuthorisation;
  auth: JiraAuthService;
  tracker: TrackerService;
  spaceReports: SpaceReportService;
}

/**
 * Sets a query parameter on a path that may already carry a query string and a fragment, replacing any earlier value
 * of it; `null` removes it. The fragment stays last, so the parameter never lands inside it.
 */
function withParam(path: string, name: string, value: string | null): string {
  const hash = path.indexOf("#");
  const fragment = hash === -1 ? "" : path.slice(hash);
  const beforeFragment = hash === -1 ? path : path.slice(0, hash);
  const at = beforeFragment.indexOf("?");
  const base = at === -1 ? beforeFragment : beforeFragment.slice(0, at);
  const kept =
    at === -1
      ? []
      : beforeFragment
          .slice(at + 1)
          .split("&")
          .filter((pair) => pair !== "" && pair.split("=")[0] !== name);
  const pairs = value === null ? kept : [...kept, `${name}=${value}`];
  return `${pairs.length === 0 ? base : `${base}?${pairs.join("&")}`}${fragment}`;
}

/** At most 20 requests a minute from one client to a route that starts or finishes a consent. */
const CONSENT_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

type CallbackFailure = "provider_error" | "missing_code" | "state_missing" | "state_mismatch" | "exchange_failed";

/** Compares two secrets without leaking, through timing, how much of them matched. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Only a path on the dashboard itself; anything else would let a crafted link send a person elsewhere after consent. */
function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || value[0] !== "/" || value[1] === "/") return null;
  const plain = [...value].every((char) => {
    const code = char.charCodeAt(0);
    return code > 0x20 && code !== 0x7f && char !== "\\";
  });
  return plain ? value : null;
}

export function registerJiraRoutes(app: FastifyInstance, deps: JiraRouteDeps): void {
  const { guard, config, authorisation, auth, tracker, spaceReports } = deps;
  const sameOrigin = requireSameOrigin(config);
  const cookie = {
    path: "/",
    httpOnly: true as const,
    sameSite: "lax" as const,
    signed: true as const,
    secure: config.webOrigin.startsWith("https"),
    maxAge: STATE_MAX_AGE_SECONDS,
  };

  app.get<{ Querystring: { returnTo?: string } }>(
    "/api/auth/jira/start",
    { preHandler: guard, schema: { querystring: jiraStartQuery }, config: { rateLimit: CONSENT_RATE_LIMIT } },
    async (request, reply) => {
      const state = randomBytes(16).toString("hex");
      reply.setCookie(STATE_COOKIE, state, cookie);
      const returnTo = request.query.returnTo;
      if (returnTo) reply.setCookie(RETURN_COOKIE, returnTo, cookie);
      else reply.clearCookie(RETURN_COOKIE, { path: "/" });
      return reply.redirect(authorisation.authoriseUrl(state));
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/auth/jira/callback",
    { preHandler: guard, schema: { querystring: jiraCallbackQuery }, config: { rateLimit: CONSENT_RATE_LIMIT } },
    async (request, reply) => {
      const expected = signedCookie(request, STATE_COOKIE);
      const returnTo = safeReturnTo(signedCookie(request, RETURN_COOKIE)) ?? DEFAULT_RETURN;
      reply.clearCookie(STATE_COOKIE, { path: "/" });
      reply.clearCookie(RETURN_COOKIE, { path: "/" });
      const { code, state, error } = request.query;
      const failed = (reason: CallbackFailure, outcome = "error", detail?: Record<string, unknown>) => {
        // Never the code, the state or a token; only why it failed.
        request.log.warn({ reason, ...detail }, "jira connection failed");
        return reply.redirect(`${config.webOrigin}${withParam(returnTo, "jira", outcome)}`);
      };
      if (error) return failed("provider_error", error === "access_denied" ? "denied" : "error", { providerError: error });
      if (!code) return failed("missing_code");
      if (!state || !expected) return failed("state_missing");
      if (!sameSecret(expected, state)) return failed("state_mismatch");
      try {
        await auth.connect(request.session!.login, code);
      } catch (err) {
        return failed("exchange_failed", "error", { err });
      }
      // A path that still carries an earlier jira=error would keep showing the failure banner after a success.
      return reply.redirect(`${config.webOrigin}${withParam(returnTo, "jira", null)}`);
    },
  );

  app.get("/api/jira", { preHandler: guard }, async (request) => {
    const login = request.session!.login;
    if (!auth.isConnected(login)) return { enabled: true, connected: false, sites: [] };
    try {
      return { enabled: true, connected: true, sites: await tracker.listSites(login) };
    } catch (error) {
      // A grant that can no longer be refreshed is the same as none: the person needs to connect again.
      if (error instanceof TrackerUnauthorisedError) return { enabled: true, connected: false, sites: [] };
      throw error;
    }
  });

  app.delete("/api/jira", { preHandler: [sameOrigin, guard] }, async (request, reply) => {
    auth.disconnect(request.session!.login);
    return reply.code(204).send();
  });

  app.get<{ Params: { siteId: string } }>(
    "/api/jira/sites/:siteId/spaces",
    { preHandler: guard, schema: { params: jiraSiteParams } },
    async (request) => tracker.listSpaces(request.session!.login, request.params.siteId),
  );

  app.get<{ Params: { siteId: string; key: string } }>(
    "/api/jira/sites/:siteId/spaces/:key",
    { preHandler: guard, schema: { params: jiraSpaceParams } },
    async (request) => tracker.describeSpace(request.session!.login, request.params.siteId, request.params.key),
  );

  app.get("/api/spaces", { preHandler: guard }, async () => tracker.trackedSpaces());

  app.get<{ Params: { id: number }; Querystring: { from?: string; to?: string; people?: "0" | "1" } }>(
    "/api/spaces/:id/report",
    { preHandler: guard, schema: { params: idParams, querystring: spaceReportQuery } },
    async (request) => {
      const { from, to, people } = request.query;
      return spaceReports.report(request.params.id, { from, to, people: people === "1" });
    },
  );

  app.get<{ Params: { id: number } }>(
    "/api/repos/:id/spaces",
    { preHandler: guard, schema: { params: idParams } },
    async (request) => tracker.linkedSpaces(request.params.id),
  );

  app.put<{ Params: { id: number }; Body: { siteId: string; keys: string[] } }>(
    "/api/repos/:id/spaces",
    { preHandler: [sameOrigin, guard], schema: { params: idParams, body: linkSpacesBody } },
    async (request, reply) => {
      const { siteId, keys } = request.body;
      const spaces = await tracker.linkSpaces(request.session!.login, request.params.id, siteId, keys);
      return reply.code(202).send(spaces);
    },
  );

  app.post<{ Params: { id: number }; Querystring: { full?: "0" | "1" } }>(
    "/api/spaces/:id/crawl",
    { preHandler: [sameOrigin, guard], schema: { params: idParams, querystring: crawlQuery } },
    async (request, reply) => {
      tracker.crawlSpace(request.session!.login, request.params.id, request.query.full === "1");
      return reply.code(202).send({ ok: true });
    },
  );
}
