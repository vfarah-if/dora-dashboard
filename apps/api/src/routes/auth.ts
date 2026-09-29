import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../core/config.js";
import { UnauthorisedError, UpstreamError } from "../core/errors.js";
import type { SourceProvider } from "../interfaces/source-provider.js";
import type { CliTokenSource, Session, SessionStore } from "../interfaces/token-source.js";

const SESSION_COOKIE = "dora_sid";
const STATE_COOKIE = "dora_oauth_state";

export interface AuthDeps {
  config: Config;
  provider: SourceProvider;
  sessions: SessionStore;
  cli: CliTokenSource;
  /** Exchanges an OAuth code for an access token; injected so tests never call GitHub. */
  exchangeCode: (code: string) => Promise<string>;
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

async function resolveSession(deps: AuthDeps, request: FastifyRequest): Promise<Session | null> {
  if (deps.config.authMode === "gh-cli") return deps.cli.session();
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? deps.sessions.get(unsigned.value) : null;
}

/** preHandler that attaches the caller's session or answers 401. */
export function requireSession(deps: AuthDeps) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const session = await resolveSession(deps, request);
    if (!session) throw new UnauthorisedError("Sign in with GitHub first");
    request.session = session;
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { config } = deps;
  const cookie = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    signed: true,
    secure: config.webOrigin.startsWith("https"),
  };

  app.get("/api/auth/me", async (request) => {
    try {
      const session = await resolveSession(deps, request);
      return {
        mode: config.authMode,
        user: session ? { login: session.login, avatarUrl: session.avatarUrl } : null,
        error: null,
      };
    } catch (error) {
      return { mode: config.authMode, user: null, error: error instanceof Error ? error.message : String(error) };
    }
  });

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
    reply.setCookie(SESSION_COOKIE, id, { ...cookie, maxAge: 8 * 3600 });
    return reply.redirect(config.webOrigin);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (unsigned?.valid && unsigned.value) deps.sessions.delete(unsigned.value);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
