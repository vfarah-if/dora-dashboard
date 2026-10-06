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
  /** The Atlassian OAuth 2.0 (3LO) app's credentials. Jira is switched on only when both are set (ADR 0020). */
  atlassianClientId: string;
  atlassianClientSecret: string;
  atlassianRedirectUri: string;
  /** True when both Atlassian credentials are set. */
  jiraEnabled: boolean;
}

const DEFAULT_ATLASSIAN_REDIRECT_URI = "http://localhost:5181/api/auth/jira/callback";
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

/** OAuth needs a real secret. In `gh-cli` mode a missing or placeholder secret is replaced by a random one. */
function sessionSecretFor(authMode: AuthMode, configured: string): string {
  if (configured && configured !== PLACEHOLDER_SESSION_SECRET) return configured;
  if (authMode === "oauth") throw new Error("AUTH_MODE=oauth needs a real SESSION_SECRET");
  return crypto.randomUUID();
}

type ServerSettings = Pick<Config, "port" | "databasePath" | "webOrigin" | "codeAnalysis">;

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
  return {
    authMode,
    githubClientId,
    githubClientSecret,
    deviceClientId: env.GITHUB_DEVICE_CLIENT_ID || PUBLISHED_DEVICE_CLIENT_ID,
    sessionSecret: sessionSecretFor(authMode, env.SESSION_SECRET ?? ""),
    ...readServerSettings(env),
    atlassianClientId,
    atlassianClientSecret,
    atlassianRedirectUri: env.ATLASSIAN_REDIRECT_URI || DEFAULT_ATLASSIAN_REDIRECT_URI,
    jiraEnabled: atlassianClientId !== "" && atlassianClientSecret !== "",
  };
}
