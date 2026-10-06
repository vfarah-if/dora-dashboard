import { TrackerUnauthorisedError, UnauthorisedError } from "../core/errors.js";
import type { TrackerAuthorisation, TrackerGrant } from "../interfaces/tracker-authorisation.js";
import type { TrackerGrantStore } from "../interfaces/tracker-grant-store.js";

/** An access token this close to expiry is refreshed first, so a long request does not outlive it. */
export const REFRESH_MARGIN_MS = 60_000;

const CONNECT_AGAIN = "Your Jira connection has expired. Connect Jira again";
const NOT_CONNECTED = "Jira is not connected. Connect Jira first";

/**
 * Keeps each signed-in person's Jira grant fresh. Grants live in memory only (ADR 0020), keyed by the
 * code-host login, so a restart means connecting again.
 */
export class JiraAuthService {
  private readonly refreshing = new Map<string, Promise<TrackerGrant>>();
  /** Bumped when a login connects or disconnects, so a refresh that began earlier cannot restore what was replaced. */
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly auth: TrackerAuthorisation,
    private readonly grants: TrackerGrantStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Trades the consent code for a grant and keeps it for the login. */
  async connect(login: string, code: string): Promise<void> {
    this.bump(login);
    this.grants.set(login, await this.auth.exchange(code));
  }

  isConnected(login: string): boolean {
    return this.grants.get(login) !== null;
  }

  disconnect(login: string): void {
    this.bump(login);
    this.grants.delete(login);
  }

  private generation(login: string): number {
    return this.generations.get(login) ?? 0;
  }

  private bump(login: string): void {
    this.generations.set(login, this.generation(login) + 1);
  }

  /** An access token with at least a minute left, refreshing (and storing the rotated grant) when needed. */
  async accessToken(login: string): Promise<string> {
    const grant = this.grants.get(login);
    if (!grant) throw new TrackerUnauthorisedError(NOT_CONNECTED);
    if (grant.expiresAt - this.now() > REFRESH_MARGIN_MS) return grant.accessToken;
    if (!grant.refreshToken) {
      // Without a refresh token the current one is all there is, and it is good until it expires.
      if (grant.expiresAt > this.now()) return grant.accessToken;
      throw new TrackerUnauthorisedError(CONNECT_AGAIN);
    }
    return (await this.refresh(login, grant.refreshToken)).accessToken;
  }

  /** Concurrent callers for one login share a single refresh, because a rotating refresh token works only once. */
  private refresh(login: string, refreshToken: string): Promise<TrackerGrant> {
    const pending = this.refreshing.get(login);
    if (pending) return pending;
    const started = this.exchangeRefresh(login, refreshToken).finally(() => this.refreshing.delete(login));
    this.refreshing.set(login, started);
    return started;
  }

  private async exchangeRefresh(login: string, refreshToken: string): Promise<TrackerGrant> {
    const started = this.generation(login);
    try {
      const fresh = await this.auth.refresh(refreshToken);
      const grant = { ...fresh, refreshToken: fresh.refreshToken ?? refreshToken };
      if (this.generation(login) !== started) return this.supersededBy(login);
      this.grants.set(login, grant);
      return grant;
    } catch (error) {
      if (error instanceof TrackerUnauthorisedError) throw error;
      // A refused refresh token will never work again; a transient failure leaves the grant for another try.
      if (error instanceof UnauthorisedError && this.generation(login) === started) this.grants.delete(login);
      throw new TrackerUnauthorisedError(CONNECT_AGAIN);
    }
  }

  /** The person disconnected or connected again while a refresh was out: what they hold now wins, or nothing. */
  private supersededBy(login: string): TrackerGrant {
    const current = this.grants.get(login);
    if (!current) throw new TrackerUnauthorisedError(NOT_CONNECTED);
    return current;
  }
}
