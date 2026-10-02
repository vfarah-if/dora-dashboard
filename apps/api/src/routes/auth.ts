import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../core/config.js";
import { ForbiddenError, UnauthorisedError, UpstreamError } from "../core/errors.js";
import type { SourceProvider } from "../interfaces/source-provider.js";
import type { CliTokenSource, Session, SessionStore } from "../interfaces/token-source.js";
import type { DeviceSignInService } from "../services/device-sign-in-service.js";

const SESSION_COOKIE = "dora_sid";
const STATE_COOKIE = "dora_oauth_state";
const DEVICE_COOKIE = "dora_device";
const SESSION_MAX_AGE_SECONDS = 8 * 3600;

export interface AuthDeps {
  config: Config;
  provider: SourceProvider;
  sessions: SessionStore;
  cli: CliTokenSource;
  /** Exchanges an OAuth code for an access token; injected so tests never call GitHub. */
  exchangeCode: (code: string) => Promise<string>;
  /** The device flow fallback for gh-cli mode. Left out, or with no client ID configured, the routes are not registered. */
  deviceSignIn?: DeviceSignInService;
}

/** Where a request's session came from, reported on `/api/auth/me`. */
export type SessionSource = "cli" | "device" | "oauth";

function deviceFlowEnabled(deps: AuthDeps): boolean {
  return deps.config.authMode === "gh-cli" && deps.config.deviceClientId !== "" && deps.deviceSignIn !== undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

export function githubCodeExchange(config: Config, http: typeof fetch = fetch) {
  return async (code: string): Promise<string> => {
    const response = await http("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code }),
    });
    const body = (await response.json()) as { access_token?: string; error_description?: string };
    if (!body.access_token) throw new UpstreamError(body.error_description ?? "GitHub did not issue a token", response.status);
    return body.access_token;
  };
}

function signedCookie(request: FastifyRequest, name: string): string | null {
  const raw = request.cookies[name];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

function storedSession(deps: AuthDeps, request: FastifyRequest): Session | null {
  const id = signedCookie(request, SESSION_COOKIE);
  return id ? deps.sessions.get(id) : null;
}

/** In gh-cli mode a browser sign-in wins, then the local CLI login, whose readable error is what a caller sees. */
async function resolveSession(
  deps: AuthDeps,
  request: FastifyRequest,
): Promise<{ session: Session; source: SessionSource } | null> {
  const stored = storedSession(deps, request);
  const browserSource: SessionSource = deps.config.authMode === "gh-cli" ? "device" : "oauth";
  if (stored) return { session: stored, source: browserSource };
  if (deps.config.authMode !== "gh-cli") return null;
  return { session: await deps.cli.session(), source: "cli" };
}

/** Rejects a browser request from another origin. A missing Origin (non-browser clients) is allowed. */
function requireSameOrigin(config: Config) {
  return async (request: FastifyRequest) => {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== config.webOrigin)
      throw new ForbiddenError("This request did not come from the dashboard");
  };
}

/** preHandler that attaches the caller's session or answers 401. */
export function requireSession(deps: AuthDeps) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const resolved = await resolveSession(deps, request);
    if (!resolved) throw new UnauthorisedError("Sign in with GitHub first");
    request.session = resolved.session;
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { config } = deps;
  const cookie = {
    path: "/",
    httpOnly: true as const,
    sameSite: "lax" as const,
    signed: true as const,
    secure: config.webOrigin.startsWith("https"),
  };

  app.get("/api/auth/me", async (request) => {
    try {
      const resolved = await resolveSession(deps, request);
      return {
        mode: config.authMode,
        user: resolved ? { login: resolved.session.login, avatarUrl: resolved.session.avatarUrl } : null,
        source: resolved?.source ?? null,
        error: null,
        deviceFlow: deviceFlowEnabled(deps),
      };
    } catch (error) {
      return {
        mode: config.authMode,
        user: null,
        source: null,
        error: error instanceof Error ? error.message : String(error),
        deviceFlow: deviceFlowEnabled(deps),
      };
    }
  });

  app.post("/api/auth/logout", { preHandler: requireSameOrigin(config) }, async (request, reply) => {
    const id = signedCookie(request, SESSION_COOKIE);
    if (id) deps.sessions.delete(id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  if (deviceFlowEnabled(deps)) registerDeviceRoutes(app, deps, cookie);
  if (config.authMode !== "oauth") return;

  app.get("/api/auth/github/login", async (_request, reply) => {
    const state = randomBytes(16).toString("hex");
    reply.setCookie(STATE_COOKIE, state, { ...cookie, maxAge: 600 });
    const params = new URLSearchParams({
      client_id: config.githubClientId,
      redirect_uri: `${config.webOrigin}/api/auth/github/callback`,
      scope: "repo read:org",
      state,
    });
    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>("/api/auth/github/callback", async (request, reply) => {
    const raw = request.cookies[STATE_COOKIE];
    const expected = raw ? request.unsignCookie(raw) : null;
    reply.clearCookie(STATE_COOKIE, { path: "/" });
    if (!request.query.code || !expected?.valid || !request.query.state || expected.value !== request.query.state) {
      return reply.code(400).send({ error: "The sign-in could not be verified. Please try again." });
    }
    const token = await deps.exchangeCode(request.query.code);
    const viewer = await deps.provider.fetchViewer(token);
    const id = deps.sessions.create({ token, ...viewer });
    reply.setCookie(SESSION_COOKIE, id, { ...cookie, maxAge: SESSION_MAX_AGE_SECONDS });
    return reply.redirect(config.webOrigin);
  });
}

type CookieOptions = { path: string; httpOnly: true; sameSite: "lax"; signed: true; secure: boolean };

function registerDeviceRoutes(app: FastifyInstance, deps: AuthDeps, cookie: CookieOptions): void {
  const signIn = deps.deviceSignIn!;
  const preHandler = requireSameOrigin(deps.config);

  app.post("/api/auth/device", { preHandler }, async (request, reply) => {
    const started = await signIn.start(signedCookie(request, DEVICE_COOKIE));
    reply.setCookie(DEVICE_COOKIE, started.id, { ...cookie, maxAge: started.expiresIn });
    return {
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      interval: started.interval,
      expiresIn: started.expiresIn,
    };
  });

  app.post("/api/auth/device/poll", { preHandler }, async (request, reply) => {
    const outcome = await signIn.poll(signedCookie(request, DEVICE_COOKIE), signedCookie(request, SESSION_COOKIE));
    if (outcome.settled) reply.clearCookie(DEVICE_COOKIE, { path: "/" });
    if (!outcome.granted) return { status: outcome.status, interval: outcome.interval };
    reply.setCookie(SESSION_COOKIE, outcome.granted.sessionId, { ...cookie, maxAge: SESSION_MAX_AGE_SECONDS });
    return { status: "granted", interval: outcome.interval, user: outcome.granted.user };
  });
}
