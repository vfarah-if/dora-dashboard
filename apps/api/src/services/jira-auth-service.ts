import { TrackerUnauthorisedError, UnauthorisedError } from "../core/errors.js";
import type { Logger } from "../interfaces/logger.js";
import { noopLogger } from "../interfaces/logger.js";
import type { TrackerAuthorisation, TrackerGrant } from "../interfaces/tracker-authorisation.js";
import type { GrantDropReason, TrackerGrantStore } from "../interfaces/tracker-grant-store.js";

/** An access token this close to expiry is refreshed first, so a long request does not outlive it. */
export const REFRESH_MARGIN_MS = 60_000;

/** Said to the person when Jira turns down a grant we still held, however the call that found out came about. */
export const JIRA_REFUSED = "Jira refused the connection. Connect Jira again";

/**
 * Stored on a space when Jira refuses the connection a crawl used. A crawl's failure belongs to the space and is read
 * by everyone who views it, so it must not tell them to connect again; only the person whose grant it was is told that.
 */
export const CRAWL_REFUSED = "Jira refused the connection used for this crawl. Crawl again with a working connection.";

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
    private readonly log: Logger = noopLogger,
  ) {
    // Every way a grant goes, the idle sweep included, leaves a line saying why; never the login or a token.
    this.grants.onDrop((reason) => this.log.info({ reason }, "jira connection dropped"));
  }

  /** Trades the consent code for a grant and keeps it for the login. */
  async connect(login: string, code: string): Promise<void> {
    this.bump(login);
    this.grants.set(login, await this.auth.exchange(code));
  }

  /** Reading the grant counts as use (see `TrackerGrantStore`), as it should: a page that checks the connection lists sites through the token. */
  isConnected(login: string): boolean {
    return this.grants.get(login) !== null;
  }

  /** Why the login's connection went, while that is remembered; null for a login that never connected or whose lapse is forgotten. */
  lapsed(login: string): GrantDropReason | null {
    return this.grants.lapsed(login);
  }

  disconnect(login: string): void {
    this.bump(login);
    this.grants.delete(login);
  }

  /**
   * Drops the grant because Jira refused `accessToken`, but only while the grant still holds that token. A request
   * begun before the person connected again carries the old token, and must not drop the new grant. Returns whether
   * it dropped.
   */
  dropIfCurrent(login: string, accessToken: string): boolean {
    if (this.grants.get(login)?.accessToken !== accessToken) return false;
    this.bump(login);
    this.grants.drop(login, "refused");
    return true;
  }

  private generation(login: string): number {
    return this.generations.get(login) ?? 0;
  }

  private bump(login: string): void {
    this.generations.set(login, this.generation(login) + 1);
  }

  /**
   * Raises the connect-again error at once when the login holds no grant, or one that has expired with no refresh token
   * to renew it. It makes no call, so a refresh token Atlassian has since revoked is found only when it is used.
   */
  requireUsableGrant(login: string): void {
    const grant = this.grants.get(login);
    if (!grant) throw new TrackerUnauthorisedError(NOT_CONNECTED);
    if (!grant.refreshToken && grant.expiresAt <= this.now()) this.expire(login);
  }

  /** An access token, refreshed first (and the rotated grant stored) when under a minute is left. A grant with no refresh token is used until it expires. */
  async accessToken(login: string): Promise<string> {
    const grant = this.grants.get(login);
    if (!grant) throw new TrackerUnauthorisedError(NOT_CONNECTED);
    if (grant.expiresAt - this.now() > REFRESH_MARGIN_MS) return grant.accessToken;
    if (!grant.refreshToken) {
      // Without a refresh token the current one is all there is, and it is good until it expires.
      if (grant.expiresAt > this.now()) return grant.accessToken;
      this.expire(login);
    }
    return (await this.refresh(login, grant.refreshToken)).accessToken;
  }

  /** A grant whose token has run out with nothing to renew it is gone, and is recorded as such so the page can say why. */
  private expire(login: string): never {
    this.grants.drop(login, "expired");
    throw new TrackerUnauthorisedError(CONNECT_AGAIN);
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
      if (error instanceof UnauthorisedError) {
        // A refused refresh token will never work again, so the grant goes (unless the person has replaced it since).
        this.log.warn({ err: error }, "jira refused the refresh token; dropped the connection");
        if (this.generation(login) === started) this.grants.drop(login, "refused");
        throw new TrackerUnauthorisedError(CONNECT_AGAIN, { cause: error });
      }
      // Atlassian being down, rate limiting or unreachable says nothing about the grant, so it is kept and the caller sees the real failure.
      this.log.warn({ err: error }, "jira token refresh failed");
      throw error;
    }
  }

  /** The person disconnected or connected again while a refresh was out: what they hold now wins, or nothing. */
  private supersededBy(login: string): TrackerGrant {
    const current = this.grants.get(login);
    if (!current) throw new TrackerUnauthorisedError(NOT_CONNECTED);
    return current;
  }
}
