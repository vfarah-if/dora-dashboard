import { fileURLToPath } from "node:url";

/** `<repo root>/data/dora.sqlite`, the same whether run from `src/` through tsx or from `dist/`. */
const DEFAULT_DATABASE = fileURLToPath(new URL("../../../../data/dora.sqlite", import.meta.url));

/** The public client ID of the project's OAuth App (device flow enabled); safe to publish because device flow uses no secret. */
export const PUBLISHED_DEVICE_CLIENT_ID = "";

export type AuthMode = "gh-cli" | "oauth";

export interface Config {
  authMode: AuthMode;
  githubClientId: string;
  githubClientSecret: string;
  /** Client ID for the GitHub device flow fallback in gh-cli mode. Empty turns the fallback off. */
  deviceClientId: string;
  sessionSecret: string;
  port: number;
  databasePath: string;
  webOrigin: string;
  /** Clone and analyse each repository's code during a crawl. `CODE_ANALYSIS=off` disables it. */
  codeAnalysis: boolean;
  /**
   * Look locked dependencies up in OSV.dev during a crawl (`OSV_LOOKUP=on`, off by default). Only the ecosystem, name and
   * version of packages a lockfile proves are public are sent (ADR 0034). It reads the lockfiles from the clone, so it
   * cannot be on while code analysis is off.
   */
  osvLookup: boolean;
  /**
   * npm scopes, such as `@acme`, never sent to OSV even though their lockfile entries look public.
   * `OSV_PRIVATE_NPM_SCOPES`, comma separated.
   */
  osvPrivateNpmScopes: string[];
  /** Show the OpenSSF Scorecard of repositories GitHub says are public (`SCORECARD_LOOKUP=on`, off by default; ADR 0035). */
  scorecardLookup: boolean;
  /**
   * The Atlassian OAuth 2.0 (3LO) app, or null when Jira is off. Both credentials are set or both are empty; one alone
   * fails at start-up (ADR 0020).
   */
  jira: JiraConfig | null;
}

export interface JiraConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const PLACEHOLDER_SESSION_SECRET = "change-me-to-a-long-random-string";

function readAuthMode(env: NodeJS.ProcessEnv): AuthMode {
  const authMode = env.AUTH_MODE || "gh-cli";
  if (authMode !== "gh-cli" && authMode !== "oauth") {
    throw new Error(`AUTH_MODE must be "gh-cli" or "oauth", not "${authMode}"`);
  }
  return authMode;
}

function requireOAuthCredentials(clientId: string, clientSecret: string): void {
  if (!clientId || !clientSecret) {
    throw new Error("AUTH_MODE=oauth needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; see .env.example");
  }
}

/** Half a pair of Atlassian credentials is a mistake, so it fails at start-up rather than quietly leaving Jira off. */
function requireBothAtlassianCredentials(clientId: string, clientSecret: string): void {
  if ((clientId === "") !== (clientSecret === "")) {
    throw new Error("Jira needs both ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET; set both, or neither to leave it off");
  }
}

/** OAuth needs a real secret. In `gh-cli` mode a missing or placeholder secret is replaced by a random one. */
function sessionSecretFor(authMode: AuthMode, configured: string): string {
  if (configured && configured !== PLACEHOLDER_SESSION_SECRET) return configured;
  if (authMode === "oauth") throw new Error("AUTH_MODE=oauth needs a real SESSION_SECRET");
  return crypto.randomUUID();
}

type ServerSettings = Pick<Config, "port" | "databasePath" | "webOrigin" | "codeAnalysis">;
type LookupSettings = Pick<Config, "osvLookup" | "osvPrivateNpmScopes" | "scorecardLookup">;

const isOn = (value: string | undefined): boolean => (value ?? "").trim().toLowerCase() === "on";

/** The optional lookups to outside services. Each is off unless it is set to `on`, so nothing leaves by accident. */
function readLookupSettings(env: NodeJS.ProcessEnv, codeAnalysis: boolean): LookupSettings {
  const osvLookup = isOn(env.OSV_LOOKUP);
  // The lookup works from the lockfiles the code analysis clone provides, so asking for it with code analysis off is a mistake.
  if (osvLookup && !codeAnalysis)
    throw new Error("OSV_LOOKUP=on needs code analysis; set CODE_ANALYSIS=on, or turn OSV_LOOKUP off");
  return {
    osvLookup,
    osvPrivateNpmScopes: (env.OSV_PRIVATE_NPM_SCOPES ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope !== ""),
    scorecardLookup: isOn(env.SCORECARD_LOOKUP),
  };
}

function readServerSettings(env: NodeJS.ProcessEnv): ServerSettings {
  return {
    port: Number(env.PORT || 8787),
    databasePath: env.DATABASE_PATH || DEFAULT_DATABASE,
    webOrigin: env.WEB_ORIGIN || "http://localhost:5181",
    codeAnalysis: (env.CODE_ANALYSIS || "on").toLowerCase() !== "off",
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = readAuthMode(env);
  const githubClientId = env.GITHUB_CLIENT_ID ?? "";
  const githubClientSecret = env.GITHUB_CLIENT_SECRET ?? "";
  if (authMode === "oauth") requireOAuthCredentials(githubClientId, githubClientSecret);
  const atlassianClientId = env.ATLASSIAN_CLIENT_ID ?? "";
  const atlassianClientSecret = env.ATLASSIAN_CLIENT_SECRET ?? "";
  requireBothAtlassianCredentials(atlassianClientId, atlassianClientSecret);
  const server = readServerSettings(env);
  return {
    authMode,
    githubClientId,
    githubClientSecret,
    deviceClientId: env.GITHUB_DEVICE_CLIENT_ID || PUBLISHED_DEVICE_CLIENT_ID,
    sessionSecret: sessionSecretFor(authMode, env.SESSION_SECRET ?? ""),
    ...server,
    ...readLookupSettings(env, server.codeAnalysis),
    jira:
      atlassianClientId === ""
        ? null
        : {
            clientId: atlassianClientId,
            clientSecret: atlassianClientSecret,
            redirectUri: env.ATLASSIAN_REDIRECT_URI || `${server.webOrigin}/api/auth/jira/callback`,
          },
  };
}
