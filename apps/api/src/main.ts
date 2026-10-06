/** Composition root: the only file that chooses concrete adapters. */
import { buildApp } from "./app.js";
import { loadConfig } from "./core/config.js";
import { GhCliTokenSource } from "./infrastructure/auth/gh-cli-token-source.js";
import { MemorySessionStore } from "./infrastructure/auth/memory-session-store.js";
import { GitCheckout } from "./infrastructure/git/git-checkout.js";
import { FsWorkspaceReader } from "./infrastructure/fs/fs-workspace-reader.js";
import { GitHubDeviceFlow } from "./infrastructure/github/github-device-flow.js";
import { GitHubProvider } from "./infrastructure/github/github-provider.js";
import { MemoryTrackerGrantStore } from "./infrastructure/auth/memory-tracker-grant-store.js";
import { AtlassianOAuth } from "./infrastructure/jira/atlassian-oauth.js";
import { JiraCloudProvider } from "./infrastructure/jira/jira-cloud-provider.js";
import { LizardAnalyser } from "./infrastructure/lizard/lizard-analyser.js";
import { SqliteRepoStore } from "./infrastructure/sqlite/sqlite-repo-store.js";
import { githubCodeExchange } from "./routes/auth.js";

const config = loadConfig();
const checkout = new GitCheckout("https://github.com");
// A crash mid-clone leaves its temporary directory behind.
await checkout.sweepStale();
const provider = new GitHubProvider();
const reader = new FsWorkspaceReader();
const { app } = await buildApp({
  config,
  store: new SqliteRepoStore(config.databasePath),
  provider,
  sessions: new MemorySessionStore(),
  cli: new GhCliTokenSource(provider),
  exchangeCode: githubCodeExchange(config),
  deviceAuth: new GitHubDeviceFlow(config.deviceClientId),
  checkout,
  analyser: new LizardAnalyser(reader),
  reader,
  jira: config.jiraEnabled
    ? {
        provider: new JiraCloudProvider(),
        auth: new AtlassianOAuth(config.atlassianClientId, config.atlassianClientSecret, config.atlassianRedirectUri),
        grants: new MemoryTrackerGrantStore(),
      }
    : undefined,
  logger: true,
});

await app.listen({ port: config.port, host: "127.0.0.1" });
app.log.info(
  `API listening on http://127.0.0.1:${config.port} (auth ${config.authMode}, jira ${config.jiraEnabled ? "on" : "off"})`,
);
