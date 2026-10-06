import type { TrackerGrant } from "./tracker-authorisation.js";

/**
 * Why a grant went without the person asking: `idle` when it went unused for a session's length, `refused` when the
 * tracker turned it down, `expired` when its access token ran out with no refresh token to renew it.
 */
export type GrantDropReason = "idle" | "refused" | "expired";

/**
 * Tracker grants keyed by the signed-in code-host login. Implementations keep them in memory only and drop a grant
 * left unused for as long as a dashboard session lasts, 8 hours (ADR 0020). Every read of a grant counts as use.
 *
 * A grant that goes without the person asking leaves its reason behind for a day, so the dashboard can say why it
 * shows them as not connected rather than as someone who never connected.
 */
export interface TrackerGrantStore {
  get(login: string): TrackerGrant | null;
  /** Keeps the grant, and forgets any earlier lapse. */
  set(login: string, grant: TrackerGrant): void;
  /** The person disconnected, or signed out: the grant goes and no lapse is remembered. */
  delete(login: string): void;
  /** The grant is lost for `reason`, which is remembered (see `lapsed`) and announced to the `onDrop` listener. */
  drop(login: string, reason: GrantDropReason): void;
  /** Why the login's last grant was dropped, while that is still remembered; null when it never was, or has been forgotten. */
  lapsed(login: string): GrantDropReason | null;
  /** Called with the reason each time a grant is dropped, however it came about; a later call replaces the listener. Never given a login or a token. */
  onDrop(listener: (reason: GrantDropReason) => void): void;
}
