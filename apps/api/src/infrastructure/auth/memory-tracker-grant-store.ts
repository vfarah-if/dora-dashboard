import type { TrackerGrant } from "../../interfaces/tracker-authorisation.js";
import type { GrantDropReason, TrackerGrantStore } from "../../interfaces/tracker-grant-store.js";
import { EIGHT_HOURS_MS } from "./memory-session-store.js";

/** How long the reason a grant was dropped is remembered. */
export const LAPSE_MEMORY_MS = 24 * 3_600_000;

interface Held {
  grant: TrackerGrant;
  /** When the grant was last read or written, in the store's own clock. */
  touchedAt: number;
}

interface Lapse {
  reason: GrantDropReason;
  at: number;
}

/**
 * Tracker grants live in this process's memory only, keyed by the signed-in code-host login. Nothing
 * token-shaped is written to disk, and a restart means connecting again (ADR 0004, ADR 0020).
 *
 * A grant not read or written for longer than `idleMs` (the session lifetime by default) is dropped, so one outlives
 * neither its session nor a person who has left. Every read and write counts as use, so a background crawl, which
 * reads the grant for each page, keeps it alive for as long as it runs, and so does an open page that checks the
 * connection, because that check lists sites live through the token and is real use.
 *
 * Why a grant was dropped is kept for a day (`LAPSE_MEMORY_MS`), or until the login connects again.
 */
export class MemoryTrackerGrantStore implements TrackerGrantStore {
  private readonly grants = new Map<string, Held>();
  private readonly lapses = new Map<string, Lapse>();
  private listener: (reason: GrantDropReason) => void = () => undefined;

  constructor(
    private readonly idleMs = EIGHT_HOURS_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(login: string): TrackerGrant | null {
    const at = this.now();
    this.sweep(at);
    const held = this.grants.get(login);
    if (!held) return null;
    held.touchedAt = at;
    return held.grant;
  }

  set(login: string, grant: TrackerGrant): void {
    const at = this.now();
    this.sweep(at);
    this.lapses.delete(login);
    this.grants.set(login, { grant: { ...grant }, touchedAt: at });
  }

  delete(login: string): void {
    this.grants.delete(login);
    this.lapses.delete(login);
  }

  drop(login: string, reason: GrantDropReason): void {
    this.grants.delete(login);
    this.lapses.set(login, { reason, at: this.now() });
    this.listener(reason);
  }

  lapsed(login: string): GrantDropReason | null {
    this.sweep(this.now());
    return this.lapses.get(login)?.reason ?? null;
  }

  onDrop(listener: (reason: GrantDropReason) => void): void {
    this.listener = listener;
  }

  /** Swept on every call, so a grant nobody asks for again does not wait for its own login to come back. */
  private sweep(at: number): void {
    for (const [login, held] of this.grants) {
      if (at - held.touchedAt <= this.idleMs) continue;
      this.grants.delete(login);
      this.lapses.set(login, { reason: "idle", at });
      this.listener("idle");
    }
    for (const [login, lapse] of this.lapses) if (at - lapse.at > LAPSE_MEMORY_MS) this.lapses.delete(login);
  }
}
