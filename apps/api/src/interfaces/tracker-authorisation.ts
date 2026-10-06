/** What an OAuth consent to a tracker yields. Held in process memory only (ADR 0004, ADR 0020). */
export interface TrackerGrant {
  readonly accessToken: string;
  /** Null when the tracker issued no refresh token, so the person must reconnect once the access token expires. */
  readonly refreshToken: string | null;
  /** Epoch milliseconds after which the access token is refused. */
  readonly expiresAt: number;
}

/**
 * Connects a person to an issue tracker through OAuth 2.0 authorisation code grant.
 *
 * `authoriseUrl` builds the consent page address carrying `state`, which the caller has stored and
 * checks on return. `exchange` trades the returned code for a grant, and `refresh` trades a refresh
 * token for a new grant (the tracker may rotate the refresh token). A refused code or refresh token
 * raises `UnauthorisedError`; any other failure raises `UpstreamError` with the tracker's reason.
 */
export interface TrackerAuthorisation {
  readonly kind: string;
  authoriseUrl(state: string): string;
  exchange(code: string): Promise<TrackerGrant>;
  refresh(refreshToken: string): Promise<TrackerGrant>;
}
