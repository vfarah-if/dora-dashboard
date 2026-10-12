import type { ScorecardResult } from "@dora-dashboard/core";

/**
 * A published security scorecard for a public repository, such as the OpenSSF Scorecard (ADR 0035). It is used only by
 * choice and only for repositories the host says are public, so no private name ever leaves. It is shown and never
 * graded.
 *
 * Contract every implementation must honour:
 * - `scorecard` answers null for a project the service does not scan, which is not a failure.
 * - No token or other credential is sent. No redirect is followed.
 * - Only the score, its date and each check's name, score and reason are mapped; the long detail text is not.
 * - An outage or a malformed reply raises `UpstreamError`.
 */
export interface ScorecardSource {
  readonly kind: string;
  scorecard(owner: string, name: string): Promise<ScorecardResult | null>;
}
