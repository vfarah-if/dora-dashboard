/**
 * Crawl from the terminal with the local GitHub CLI login, without starting the server.
 *   npm run crawl -w @dora-dashboard/api -- owner/name [--workflow deploy.yml] [--branch main] [--full]
 */
import { parseArgs } from "node:util";
import { loadConfig } from "./core/config.js";
import { createCodeAnalyser } from "./infrastructure/analysis/create-code-analyser.js";
import { GhCliTokenSource } from "./infrastructure/auth/gh-cli-token-source.js";
import { GitCheckout } from "./infrastructure/git/git-checkout.js";
import { FsWorkspaceReader } from "./infrastructure/fs/fs-workspace-reader.js";
import { GitHubCoverageSource } from "./infrastructure/github/github-coverage-source.js";
import { GitHubIssueProvider } from "./infrastructure/github/github-issue-provider.js";
import { GitHubProvider } from "./infrastructure/github/github-provider.js";
import { GitHubSecurityAlertSource } from "./infrastructure/github/github-security-alert-source.js";
import { OsvVulnerabilityDatabase } from "./infrastructure/osv/osv-vulnerability-database.js";
import { OpenSsfScorecardSource } from "./infrastructure/scorecard/openssf-scorecard-source.js";
import { SqliteRepoStore } from "./infrastructure/sqlite/sqlite-repo-store.js";
import type { Logger } from "./interfaces/logger.js";
import { CodeHealthService } from "./services/code-health-service.js";
import { CoverageService } from "./services/coverage-service.js";
import { CrawlService } from "./services/crawl-service.js";
import { IssueCrawlService } from "./services/issue-crawl-service.js";
import { isSafeBranch, parseRepoRef } from "./services/repo-ref.js";
import { SecurityCrawlService } from "./services/security-crawl-service.js";
import { SecurityReportService, describeSecurity } from "./services/security-report-service.js";
import { SupplyChainService } from "./services/supply-chain-service.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    workflow: { type: "string", multiple: true },
    branch: { type: "string" },
    full: { type: "boolean", default: false },
  },
});

const ref = parseRepoRef(positionals[0] ?? "");
if (!ref) {
  console.error("Usage: crawl owner/name [--workflow deploy.yml] [--branch main] [--full]");
  process.exit(1);
}

if (values.branch !== undefined && !isSafeBranch(values.branch)) {
  console.error("That is not a usable branch name");
  process.exit(1);
}

const config = loadConfig({ ...process.env, AUTH_MODE: "gh-cli" });
const store = new SqliteRepoStore(config.databasePath);
const provider = new GitHubProvider();
const { token } = await new GhCliTokenSource(provider).session();

const existing = store.findRepo(ref.owner, ref.name);
const repo = existing ?? store.addRepo(ref.owner, ref.name, values.workflow ?? [], values.branch ?? "main");
if (existing && (values.workflow || values.branch)) {
  store.updateRepoConfig(repo.id, values.workflow ?? repo.deployWorkflows, values.branch ?? repo.deployBranch);
}

const timer = setInterval(() => {
  const progress = store.getRepo(repo.id)?.crawlProgress;
  if (progress) console.log(progress);
}, 2000);
// Everything the server would log reaches the terminal, including which files were measured only in part and why.
const log: Logger = {
  info: (context, message) => console.log(message, context),
  warn: (context, message) => console.warn(message, context),
  error: (context, message) => console.error(message, context),
};
const reader = new FsWorkspaceReader(undefined, log);
try {
  const codeHealth = config.codeAnalysis
    ? new CodeHealthService(
        store,
        new GitCheckout(),
        createCodeAnalyser(reader, log),
        undefined,
        log,
        reader,
        // Workflow, dependency and container facts are read from the same clone.
        new SupplyChainService(store),
      )
    : undefined;
  // Coverage is read alongside the analysis, so switching analysis off switches it off too.
  const coverage = config.codeAnalysis ? new CoverageService(store, new GitHubCoverageSource(), undefined, log) : undefined;
  const issues = new IssueCrawlService(store, new GitHubIssueProvider(), log);
  const alertSource = new GitHubSecurityAlertSource();
  const security = new SecurityCrawlService(
    store,
    alertSource,
    config.osvLookup ? new OsvVulnerabilityDatabase() : null,
    config.scorecardLookup ? new OpenSsfScorecardSource() : null,
    () => new Date(),
    log,
    config.osvPrivateNpmScopes,
  );
  await new CrawlService(store, provider, {
    ...(codeHealth ? { codeHealth } : {}),
    log,
    issues,
    security,
    ...(coverage ? { coverage } : {}),
  }).crawl(token, repo.id, values.full);
  console.log(`${ref.owner}/${ref.name}`, store.counts(repo.id));
  const [summary] = new SecurityReportService(store, store, {
    codeAnalysis: config.codeAnalysis,
    scorecardLookup: config.scorecardLookup,
    settingsUrl: (owner, name) => alertSource.settingsUrl(owner, name),
  }).summaries([repo.id]);
  if (summary) console.log(describeSecurity(summary));
} finally {
  clearInterval(timer);
}
