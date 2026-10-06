import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  JiraConnection,
  LinkedSpace,
  SpaceDescription,
  SpaceListing,
  SpaceReport,
  TrackerSpaceSummary,
} from "@dora-dashboard/core";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Config } from "../core/config.js";
import {
  AppError,
  RateLimitedError,
  TrackerConfigurationError,
  TrackerUnauthorisedError,
  UnauthorisedError,
} from "../core/errors.js";
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
  /** Milliseconds since the epoch, for how long a used state is remembered; tests pass a controllable one. */
  now?: () => number;
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

type CallbackFailure =
  | "provider_error"
  | "missing_code"
  | "state_missing"
  | "state_lapsed"
  | "state_mismatch"
  | "state_reused"
  | "exchange_failed"
  | "misconfigured";

/**
 * The state cookie holds the state and when it was issued, signed together. The browser drops the cookie after
 * 10 minutes, but a captured copy would not lapse on its own, so the callback checks the signed issue time too.
 */
function stateCookieValue(state: string, issuedAt: number): string {
  return `${state}.${issuedAt}`;
}

function readStateCookie(value: string | null): { state: string; issuedAt: number } | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  const issuedAt = Number(value.slice(dot + 1));
  if (dot <= 0 || !Number.isSafeInteger(issuedAt)) return null;
  return { state: value.slice(0, dot), issuedAt };
}

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

/**
 * The start and callback routes are full-page navigations, so an error must never reach the browser as JSON. Each
 * failure sends the person back to the dashboard; the `jira` outcome says what the page should tell them.
 */
function navigationErrorHandler(config: Config) {
  return (error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    const back = (outcome: string) => reply.redirect(`${config.webOrigin}${withParam(DEFAULT_RETURN, "jira", outcome)}`);
    // Only why, never the query: the callback's carries a one-time code.
    // Not signed in: the dashboard's own sign-in takes over from its front page.
    if (error instanceof UnauthorisedError) {
      request.log.info({ reason: "not_signed_in", route: request.routeOptions.url }, "jira sign-in route refused");
      return reply.redirect(`${config.webOrigin}/`);
    }
    if (error instanceof RateLimitedError) {
      request.log.info({ reason: "rate_limited", route: request.routeOptions.url }, "jira sign-in route refused");
      return back("rate_limited");
    }
    if ("validation" in error && error.validation) {
      request.log.info({ reason: "invalid_query", route: request.routeOptions.url }, "jira sign-in route refused");
      return back("error");
    }
    request.log.error({ err: error }, "jira sign-in route failed");
    return back("error");
  };
}

export function registerJiraRoutes(app: FastifyInstance, deps: JiraRouteDeps): void {
  const { guard, config, authorisation, auth, tracker, spaceReports } = deps;
  const now = deps.now ?? Date.now;
  const navigationErrors = navigationErrorHandler(config);
  // States already used, with when each stops being worth remembering; the cookie that carried one lives 10 minutes.
  const usedStates = new Map<string, number>();
  const useState = (state: string): boolean => {
    const at = now();
    for (const [seen, expires] of usedStates) if (expires <= at) usedStates.delete(seen);
    if (usedStates.has(state)) return false;
    usedStates.set(state, at + STATE_MAX_AGE_SECONDS * 1000);
    return true;
  };
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
    {
      preHandler: guard,
      schema: { querystring: jiraStartQuery },
      config: { rateLimit: CONSENT_RATE_LIMIT },
      errorHandler: navigationErrors,
    },
    async (request, reply): Promise<FastifyReply> => {
      const state = randomBytes(16).toString("hex");
      reply.setCookie(STATE_COOKIE, stateCookieValue(state, now()), cookie);
      const returnTo = request.query.returnTo;
      if (returnTo) reply.setCookie(RETURN_COOKIE, returnTo, cookie);
      else reply.clearCookie(RETURN_COOKIE, { path: "/" });
      return reply.redirect(authorisation.authoriseUrl(state));
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/auth/jira/callback",
    {
      preHandler: guard,
      schema: { querystring: jiraCallbackQuery },
      config: { rateLimit: CONSENT_RATE_LIMIT },
      errorHandler: navigationErrors,
    },
    async (request, reply): Promise<FastifyReply> => {
      const issued = readStateCookie(signedCookie(request, STATE_COOKIE));
      const returnTo = safeReturnTo(signedCookie(request, RETURN_COOKIE)) ?? DEFAULT_RETURN;
      reply.clearCookie(STATE_COOKIE, { path: "/" });
      reply.clearCookie(RETURN_COOKIE, { path: "/" });
      const { code, state, error } = request.query;
      const failed = (reason: CallbackFailure, outcome = "error", detail?: Record<string, unknown>) => {
        // Never the code, the state or a token; only why it failed. A refused app credential is the operator's to fix.
        // A failure that is no AppError is a bug in this dashboard, not something Atlassian or the person did.
        const bug = reason === "exchange_failed" && !(detail?.["err"] instanceof AppError);
        const log = reason === "misconfigured" || bug ? request.log.error : request.log.warn;
        log.call(request.log, { reason, ...detail }, "jira connection failed");
        return reply.redirect(`${config.webOrigin}${withParam(returnTo, "jira", outcome)}`);
      };
      if (error) return failed("provider_error", error === "access_denied" ? "denied" : "error", { providerError: error });
      if (!code) return failed("missing_code");
      // No cookie means it never arrived or has gone: consent took over 10 minutes, the API restarted, or the browser
      // used a different host from WEB_ORIGIN.
      if (!state || !issued) return failed("state_missing", "expired");
      if (now() - issued.issuedAt > STATE_MAX_AGE_SECONDS * 1000) return failed("state_lapsed", "expired");
      // Two tabs each starting consent leave the later cookie standing, so the earlier tab's return is stale, not wrong.
      if (!sameSecret(issued.state, state)) return failed("state_mismatch", "expired");
      // A captured cookie and state could otherwise be replayed until the cookie's issue time lapses.
      if (!useState(state)) return failed("state_reused");
      try {
        await auth.connect(request.session!.login, code);
      } catch (err) {
        if (err instanceof TrackerConfigurationError) return failed("misconfigured", "misconfigured", { err });
        return failed("exchange_failed", "error", { err });
      }
      // A path that still carries an earlier jira=error would keep showing the failure banner after a success.
      return reply.redirect(`${config.webOrigin}${withParam(returnTo, "jira", null)}`);
    },
  );

  app.get("/api/jira", { preHandler: guard }, async (request): Promise<JiraConnection> => {
    const login = request.session!.login;
    // Says why a connection that once existed is gone, when that is known; nothing for someone who never connected.
    const notConnected = (): JiraConnection => {
      const lapsed = auth.lapsed(login);
      return { enabled: true, connected: false, sites: [], ...(lapsed ? { lapsed } : {}) };
    };
    if (!auth.isConnected(login)) return notConnected();
    try {
      return { enabled: true, connected: true, sites: await tracker.listSites(login) };
    } catch (error) {
      // A grant that can no longer be refreshed is the same as none: the person needs to connect again.
      if (error instanceof TrackerUnauthorisedError) {
        request.log.info({ err: error }, "jira connection check found the grant unusable");
        return notConnected();
      }
      throw error;
    }
  });

  app.delete("/api/jira", { preHandler: [sameOrigin, guard] }, async (request, reply): Promise<FastifyReply> => {
    auth.disconnect(request.session!.login);
    return reply.code(204).send();
  });

  app.get<{ Params: { siteId: string } }>(
    "/api/jira/sites/:siteId/spaces",
    { preHandler: guard, schema: { params: jiraSiteParams } },
    async (request): Promise<TrackerSpaceSummary[]> => tracker.listSpaces(request.session!.login, request.params.siteId),
  );

  app.get<{ Params: { siteId: string; key: string } }>(
    "/api/jira/sites/:siteId/spaces/:key",
    { preHandler: guard, schema: { params: jiraSpaceParams } },
    async (request): Promise<SpaceDescription> =>
      tracker.describeSpace(request.session!.login, request.params.siteId, request.params.key),
  );

  app.get("/api/spaces", { preHandler: guard }, async (): Promise<SpaceListing[]> => tracker.trackedSpaces());

  app.get<{ Params: { id: number }; Querystring: { from?: string; to?: string; people?: "0" | "1" } }>(
    "/api/spaces/:id/report",
    { preHandler: guard, schema: { params: idParams, querystring: spaceReportQuery } },
    async (request): Promise<SpaceReport> => {
      const { from, to, people } = request.query;
      return spaceReports.report(request.params.id, { from, to, people: people === "1" });
    },
  );

  app.get<{ Params: { id: number } }>(
    "/api/repos/:id/spaces",
    { preHandler: guard, schema: { params: idParams } },
    async (request): Promise<LinkedSpace[]> => tracker.linkedSpaces(request.params.id),
  );

  app.put<{ Params: { id: number }; Body: { siteId: string; keys: string[] } }>(
    "/api/repos/:id/spaces",
    { preHandler: [sameOrigin, guard], schema: { params: idParams, body: linkSpacesBody } },
    async (request, reply): Promise<FastifyReply> => {
      const { siteId, keys } = request.body;
      const spaces: LinkedSpace[] = await tracker.linkSpaces(request.session!.login, request.params.id, siteId, keys);
      return reply.code(202).send(spaces);
    },
  );

  app.post<{ Params: { id: number }; Querystring: { full?: "0" | "1" } }>(
    "/api/spaces/:id/crawl",
    { preHandler: [sameOrigin, guard], schema: { params: idParams, querystring: crawlQuery } },
    async (request, reply): Promise<FastifyReply> => {
      tracker.crawlSpace(request.session!.login, request.params.id, request.query.full === "1");
      return reply.code(202).send({ ok: true });
    },
  );
}
