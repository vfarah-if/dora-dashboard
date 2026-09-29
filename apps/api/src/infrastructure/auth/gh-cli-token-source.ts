import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UnauthorisedError } from "../../core/errors.js";
import type { SourceProvider } from "../../interfaces/source-provider.js";
import type { CliTokenSource, Session } from "../../interfaces/token-source.js";

const run = promisify(execFile);
const ONE_HOUR_MS = 3_600_000;

export type ReadToken = () => Promise<string>;

const readGhToken: ReadToken = async () => (await run("gh", ["auth", "token"])).stdout.trim();

/**
 * Borrows the local GitHub CLI login, so a developer running the dashboard on their own machine
 * never types a credential. Cached for an hour so a token refreshed by `gh` is picked up.
 */
export class GhCliTokenSource implements CliTokenSource {
  private cached: Session | null = null;

  constructor(
    private readonly provider: SourceProvider,
    private readonly readToken: ReadToken = readGhToken,
    private readonly now: () => number = Date.now,
  ) {}

  async session(): Promise<Session> {
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached;
    let token: string;
    try {
      token = await this.readToken();
    } catch {
      throw new UnauthorisedError("The GitHub CLI is not signed in; run `gh auth login`");
    }
    if (!token) throw new UnauthorisedError("The GitHub CLI is not signed in; run `gh auth login`");
    const viewer = await this.provider.fetchViewer(token);
    this.cached = { token, ...viewer, expiresAt: this.now() + ONE_HOUR_MS };
    return this.cached;
  }
}
