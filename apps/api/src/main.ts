/** Composition root: the only file that chooses concrete adapters. */
import { buildApp } from "./app.js";
import { loadConfig } from "./core/config.js";
import { createCodeAnalyser } from "./infrastructure/analysis/create-code-analyser.js";
import { GhCliTokenSource } from "./infrastructure/auth/gh-cli-token-source.js";
import { MemorySessionStore } from "./infrastructure/auth/memory-session-store.js";
import { GitCheckout } from "./infrastructure/git/git-checkout.js";
import { FsWorkspaceReader } from "./infrastructure/fs/fs-workspace-reader.js";
import { GitHubCoverageSource } from "./infrastructure/github/github-coverage-source.js";
import { GitHubDeviceFlow } from "./infrastructure/github/github-device-flow.js";
import { GitHubIssueProvider } from "./infrastructure/github/github-issue-provider.js";
import { GitHubProvider } from "./infrastructure/github/github-provider.js";
import { GitHubSecurityAlertSource } from "./infrastructure/github/github-security-alert-source.js";
import { MemoryTrackerGrantStore } from "./infrastructure/auth/memory-tracker-grant-store.js";
import { AtlassianOAuth } from "./infrastructure/jira/atlassian-oauth.js";
import { JiraCloudProvider } from "./infrastructure/jira/jira-cloud-provider.js";
import { OsvVulnerabilityDatabase } from "./infrastructure/osv/osv-vulnerability-database.js";
import { OpenSsfScorecardSource } from "./infrastructure/scorecard/openssf-scorecard-source.js";
import { SqliteRepoStore } from "./infrastructure/sqlite/sqlite-repo-store.js";
import { noopLogger, type Logger } from "./interfaces/logger.js";
import { githubCodeExchange } from "./routes/auth.js";

const config = loadConfig();
const checkout = new GitCheckout("https://github.com");
// A crash mid-clone leaves its temporary directory behind.
await checkout.sweepStale();
const provider = new GitHubProvider();
// The store and the analysers are built before the app, whose logger they should use; they write through this until
// the app exists.
let appLog: Logger = noopLogger;
const lateLog: Logger = {
  info: (context, message) => appLog.info(context, message),
  warn: (context, message) => appLog.warn(context, message),
  error: (context, message) => appLog.error(context, message),
};
const reader = new FsWorkspaceReader(undefined, lateLog);
const { app } = await buildApp({
  config,
  store: new SqliteRepoStore(config.databasePath, undefined, lateLog),
  provider,
  issues: new GitHubIssueProvider(),
  coverage: new GitHubCoverageSource(),
  securityAlerts: new GitHubSecurityAlertSource(),
  // The outside lookups are built only when switched on, so a default install never has an adapter that could call out.
  ...(config.osvLookup ? { vulnerabilities: new OsvVulnerabilityDatabase() } : {}),
  ...(config.scorecardLookup ? { scorecard: new OpenSsfScorecardSource() } : {}),
  sessions: new MemorySessionStore(),
  cli: new GhCliTokenSource(provider),
  exchangeCode: githubCodeExchange(config),
  deviceAuth: new GitHubDeviceFlow(config.deviceClientId),
  checkout,
  analyser: createCodeAnalyser(reader, lateLog),
  reader,
  jira: config.jira
    ? {
        provider: new JiraCloudProvider(),
        auth: new AtlassianOAuth(config.jira.clientId, config.jira.clientSecret, config.jira.redirectUri),
        grants: new MemoryTrackerGrantStore(),
      }
    : undefined,
  logger: true,
});

appLog = app.log;
await app.listen({ port: config.port, host: "127.0.0.1" });
app.log.info(
  `API listening on http://127.0.0.1:${config.port} (auth ${config.authMode}, jira ${config.jira ? "on" : "off"}, osv ${config.osvLookup ? "on" : "off"}, scorecard ${config.scorecardLookup ? "on" : "off"})`,
);
