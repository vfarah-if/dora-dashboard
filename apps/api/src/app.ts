import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./core/config.js";
import type { CodeAnalyser } from "./interfaces/code-analyser.js";
import type { RepoStore } from "./interfaces/repo-store.js";
import type { SourceCheckout } from "./interfaces/source-checkout.js";
import type { SourceProvider } from "./interfaces/source-provider.js";
import type { CliTokenSource, SessionStore } from "./interfaces/token-source.js";
import { registerAuthRoutes, requireSession } from "./routes/auth.js";
import { registerErrorHandler } from "./routes/errors.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { CodeHealthService } from "./services/code-health-service.js";
import { CrawlService } from "./services/crawl-service.js";
import { RepoService } from "./services/repo-service.js";
import { ReportService } from "./services/report-service.js";

export interface AppDeps {
  config: Config;
  store: RepoStore;
  provider: SourceProvider;
  sessions: SessionStore;
  cli: CliTokenSource;
  exchangeCode: (code: string) => Promise<string>;
  /** Both are needed for code analysis; leave either out, or set `config.codeAnalysis` false, to skip it. */
  checkout?: SourceCheckout;
  analyser?: CodeAnalyser;
  logger?: boolean;
}

/** Builds the HTTP app from its adapters. `main.ts` passes real ones; tests pass fakes. */
export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; crawler: CrawlService }> {
  // Fastify's validator strips unknown body fields by default; refusing them surfaces a client bug instead.
  const app = Fastify({ logger: deps.logger ?? false, ajv: { customOptions: { removeAdditional: false } } });
  await app.register(cookie, { secret: deps.config.sessionSecret });
  registerErrorHandler(app);

  const auth = {
    config: deps.config,
    provider: deps.provider,
    sessions: deps.sessions,
    cli: deps.cli,
    exchangeCode: deps.exchangeCode,
  };
  const codeHealth = new CodeHealthService(deps.store, deps.checkout ?? null, deps.analyser ?? null, undefined, app.log);
  // With analysis off the crawl never clones, but earlier snapshots can still be read back.
  const crawler = new CrawlService(
    deps.store,
    deps.provider,
    deps.config.codeAnalysis && deps.checkout && deps.analyser ? codeHealth : undefined,
    app.log,
  );
  registerAuthRoutes(app, auth);
  registerRepoRoutes(app, {
    guard: requireSession(auth),
    repos: new RepoService(deps.store, deps.provider),
    crawler,
    reports: new ReportService(deps.store),
    codeHealth,
  });
  app.get("/api/health", async () => ({ ok: true, authMode: deps.config.authMode, provider: deps.provider.kind }));
  return { app, crawler };
}
