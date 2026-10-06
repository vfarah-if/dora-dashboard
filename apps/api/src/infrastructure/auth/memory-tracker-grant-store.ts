import type { TrackerGrant } from "../../interfaces/tracker-authorisation.js";
import type { TrackerGrantStore } from "../../interfaces/tracker-grant-store.js";

/**
 * Tracker grants live in this process's memory only, keyed by the signed-in code-host login. Nothing
 * token-shaped is written to disk, and a restart means connecting again (ADR 0004, ADR 0020).
 */
export class MemoryTrackerGrantStore implements TrackerGrantStore {
  private readonly grants = new Map<string, TrackerGrant>();

  get(login: string): TrackerGrant | null {
    return this.grants.get(login) ?? null;
  }

  set(login: string, grant: TrackerGrant): void {
    this.grants.set(login, { ...grant });
  }

  delete(login: string): void {
    this.grants.delete(login);
  }
}
