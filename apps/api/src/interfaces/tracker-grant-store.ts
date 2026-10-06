import type { TrackerGrant } from "./tracker-authorisation.js";

/** Tracker grants keyed by the signed-in code-host login. Implementations keep them in memory only (ADR 0020). */
export interface TrackerGrantStore {
  get(login: string): TrackerGrant | null;
  set(login: string, grant: TrackerGrant): void;
  delete(login: string): void;
}
