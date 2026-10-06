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
 * raises `UnauthorisedError`, and a refresh token so refused is gone for good. At `refresh`, a 400 counts as a refusal only when it says `invalid_grant`; any other 400 is a fault in the dashboard's own request and raises `UpstreamError`, so the grant is kept. At `exchange` only, a refusal of the
 * dashboard's own app credentials raises `TrackerConfigurationError` instead, because there is no grant yet to keep or
 * drop and a refused refresh must never be read as a configuration fault (ADR 0020). Any other failure raises
 * `UpstreamError` with the tracker's reason.
 */
export interface TrackerAuthorisation {
  readonly kind: string;
  authoriseUrl(state: string): string;
  exchange(code: string): Promise<TrackerGrant>;
  refresh(refreshToken: string): Promise<TrackerGrant>;
}
