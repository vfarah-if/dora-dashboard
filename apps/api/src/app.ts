import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Config } from "./core/config.js";
import type { DeviceAuthorisation } from "./interfaces/device-authorisation.js";
import type { CodeAnalyser } from "./interfaces/code-analyser.js";
import type { RepoStore } from "./interfaces/repo-store.js";
import type { WorkspaceReader } from "./interfaces/workspace-reader.js";
import type { SourceCheckout } from "./interfaces/source-checkout.js";
import type { SourceProvider } from "./interfaces/source-provider.js";
import type { TrackerAuthorisation } from "./interfaces/tracker-authorisation.js";
import type { TrackerGrantStore } from "./interfaces/tracker-grant-store.js";
import type { WorkItemProvider } from "./interfaces/work-item-provider.js";
import type { CliTokenSource, SessionStore } from "./interfaces/token-source.js";
import { registerAuthRoutes, requireSession } from "./routes/auth.js";
import { registerErrorHandler } from "./routes/errors.js";
import { registerJiraRoutes } from "./routes/jira.js";
import { registerRepoRoutes } from "./routes/repos.js";
import { registerReviewQueueRoutes } from "./routes/review-queue.js";
import { DeviceSignInService } from "./services/device-sign-in-service.js";
import { CodeHealthService } from "./services/code-health-service.js";
import { CrawlService } from "./services/crawl-service.js";
import { JiraAuthService } from "./services/jira-auth-service.js";
import { RepoService } from "./services/repo-service.js";
import { ReportService } from "./services/report-service.js";
import { ReviewQueueService } from "./services/review-queue-service.js";
import { SpaceReportService } from "./services/space-report-service.js";
import { TrackerService } from "./services/tracker-service.js";
import { WorkItemCrawlService } from "./services/work-item-crawl-service.js";

export interface AppDeps {
  config: Config;
  store: RepoStore;
  provider: SourceProvider;
  sessions: SessionStore;
  cli: CliTokenSource;
  exchangeCode: (code: string) => Promise<string>;
  /** Browser sign-in for gh-cli mode when the CLI is not logged in; used only if `config.deviceClientId` is set. */
  deviceAuth?: DeviceAuthorisation;
  /** Milliseconds since the epoch for device sign-in intervals; tests pass a controllable one. */
  now?: () => number;
  /** Both are needed for code analysis; leave either out, or set `config.codeAnalysis` false, to skip it. */
  checkout?: SourceCheckout;
  analyser?: CodeAnalyser;
  /** Reads tooling files from the clone so the report can grade testing and hygiene. Optional. */
  reader?: WorkspaceReader;
  /** The time source for review waits and the review queue cache; tests pass a fixed one. */
  clock?: () => Date;
  /** Jira, through OAuth 2.0 (3LO). Left out, the Jira routes are not registered and answer 404 (ADR 0020). */
  jira?: { provider: WorkItemProvider; auth: TrackerAuthorisation; grants: TrackerGrantStore };
  /** `true` logs to stdout; a stream lets a test read the log lines. */
  logger?: boolean | { stream: NodeJS.WritableStream };
}

/** The OAuth callback's query carries a one-time code and the state, so request logs keep only its path. */
export function loggedUrl(url: string): string {
  return url.startsWith(JIRA_CALLBACK_PATH) ? JIRA_CALLBACK_PATH : url;
}

const JIRA_CALLBACK_PATH = "/api/auth/jira/callback";

function loggerOptions(logger: AppDeps["logger"]) {
  if (!logger) return false;
  const serializers = {
    req: (request: FastifyRequest) => ({
      method: request.method,
      url: loggedUrl(request.url),
      host: request.host,
      remoteAddress: request.ip,
    }),
  };
  return logger === true ? { serializers } : { serializers, stream: logger.stream };
}

function createApp(deps: AppDeps): FastifyInstance {
  // Fastify's validator strips unknown body fields by default; refusing them surfaces a client bug instead.
  return Fastify({ logger: loggerOptions(deps.logger), ajv: { customOptions: { removeAdditional: false } } });
}

function createCodeHealth(deps: AppDeps, app: FastifyInstance): CodeHealthService {
  return new CodeHealthService(deps.store, deps.checkout ?? null, deps.analyser ?? null, undefined, app.log, deps.reader ?? null);
}

function createCrawler(deps: AppDeps, app: FastifyInstance, codeHealth: CodeHealthService): CrawlService {
  // With analysis off the crawl never clones, but earlier snapshots can still be read back.
  const analyseDuringCrawl = deps.config.codeAnalysis && deps.checkout && deps.analyser;
  return new CrawlService(deps.store, deps.provider, analyseDuringCrawl ? codeHealth : undefined, app.log);
}

function registerJira(
  app: FastifyInstance,
  deps: AppDeps,
  guard: ReturnType<typeof requireSession>,
  jira: NonNullable<AppDeps["jira"]>,
  auth: JiraAuthService,
) {
  const crawler = new WorkItemCrawlService(deps.store, jira.provider, auth, app.log);
  const tracker = new TrackerService(deps.store, jira.provider, auth, crawler, deps.clock, app.log);
  registerJiraRoutes(app, {
    guard,
    config: deps.config,
    authorisation: jira.auth,
    auth,
    tracker,
    spaceReports: new SpaceReportService(deps.store, deps.clock),
  });
  return crawler;
}

function registerRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  crawler: CrawlService,
  codeHealth: CodeHealthService,
): WorkItemCrawlService | undefined {
  const jiraAuth = deps.jira && new JiraAuthService(deps.jira.auth, deps.jira.grants, deps.now);
  const auth = {
    config: deps.config,
    provider: deps.provider,
    sessions: deps.sessions,
    cli: deps.cli,
    exchangeCode: deps.exchangeCode,
    deviceSignIn: deps.deviceAuth && new DeviceSignInService(deps.deviceAuth, deps.sessions, deps.provider, deps.now),
    ...(jiraAuth ? { onSignOut: (login: string) => jiraAuth.disconnect(login) } : {}),
  };
  registerAuthRoutes(app, auth);
  registerRepoRoutes(app, {
    guard: requireSession(auth),
    repos: new RepoService(deps.store, deps.provider),
    crawler,
    reports: new ReportService(deps.store),
    codeHealth,
  });
  registerReviewQueueRoutes(app, {
    guard: requireSession(auth),
    queue: new ReviewQueueService(deps.store, deps.provider, deps.clock),
  });
  const workItemCrawler = deps.jira && jiraAuth && registerJira(app, deps, requireSession(auth), deps.jira, jiraAuth);
  app.get("/api/health", async () => ({
    ok: true,
    authMode: deps.config.authMode,
    provider: deps.provider.kind,
    jira: deps.jira !== undefined,
  }));
  return workItemCrawler;
}

/** Builds the HTTP app from its adapters. `main.ts` passes real ones; tests pass fakes. */
export async function buildApp(deps: AppDeps): Promise<{
  app: FastifyInstance;
  crawler: CrawlService;
  /** Present only when Jira is wired; tests wait on it for background space crawls. */
  workItemCrawler?: WorkItemCrawlService;
}> {
  const app = createApp(deps);
  await app.register(cookie, { secret: deps.config.sessionSecret });
  registerErrorHandler(app);

  const codeHealth = createCodeHealth(deps, app);
  const crawler = createCrawler(deps, app, codeHealth);
  const workItemCrawler = registerRoutes(app, deps, crawler, codeHealth);
  return { app, crawler, ...(workItemCrawler ? { workItemCrawler } : {}) };
}
