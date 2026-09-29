import { fileURLToPath } from "node:url";

/** `<repo root>/data/dora.sqlite`, the same whether run from `src/` through tsx or from `dist/`. */
const DEFAULT_DATABASE = fileURLToPath(new URL("../../../../data/dora.sqlite", import.meta.url));

export type AuthMode = "gh-cli" | "oauth";

export interface Config {
  authMode: AuthMode;
  githubClientId: string;
  githubClientSecret: string;
  sessionSecret: string;
  port: number;
  databasePath: string;
  webOrigin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = (env.AUTH_MODE || "gh-cli") as AuthMode;
  if (authMode !== "gh-cli" && authMode !== "oauth") {
    throw new Error(`AUTH_MODE must be "gh-cli" or "oauth", not "${authMode}"`);
  }
  const config: Config = {
    authMode,
    githubClientId: env.GITHUB_CLIENT_ID ?? "",
    githubClientSecret: env.GITHUB_CLIENT_SECRET ?? "",
    sessionSecret: env.SESSION_SECRET ?? "",
    port: Number(env.PORT || 8787),
    databasePath: env.DATABASE_PATH || DEFAULT_DATABASE,
    webOrigin: env.WEB_ORIGIN || "http://localhost:5181",
  };
  if (authMode === "oauth" && (!config.githubClientId || !config.githubClientSecret)) {
    throw new Error("AUTH_MODE=oauth needs GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; see .env.example");
  }
  if (!config.sessionSecret || config.sessionSecret === "change-me-to-a-long-random-string") {
    if (authMode === "oauth") throw new Error("AUTH_MODE=oauth needs a real SESSION_SECRET");
    config.sessionSecret = crypto.randomUUID();
  }
  return config;
}
