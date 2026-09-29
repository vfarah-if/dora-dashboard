/**
 * Crawl from the terminal with the local GitHub CLI login, without starting the server.
 *   npm run crawl -w @dora-dashboard/api -- owner/name [--workflow deploy.yml] [--branch main] [--full]
 */
import { parseArgs } from "node:util";
import { loadConfig } from "./core/config.js";
import { GhCliTokenSource } from "./infrastructure/auth/gh-cli-token-source.js";
import { GitHubProvider } from "./infrastructure/github/github-provider.js";
import { SqliteRepoStore } from "./infrastructure/sqlite/sqlite-repo-store.js";
import { CrawlService } from "./services/crawl-service.js";
import { parseRepoRef } from "./services/repo-ref.js";

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
try {
  await new CrawlService(store, provider).crawl(token, repo.id, values.full);
  console.log(`${ref.owner}/${ref.name}`, store.counts(repo.id));
} finally {
  clearInterval(timer);
}
