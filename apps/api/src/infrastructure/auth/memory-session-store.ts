import { randomBytes } from "node:crypto";
import type { Session, SessionStore } from "../../interfaces/token-source.js";

const EIGHT_HOURS_MS = 8 * 3_600_000;

/**
 * Tokens live in this process's memory only, keyed by a random id the browser holds in a signed,
 * HTTP-only cookie. Nothing token-shaped is written to disk or sent to the browser, and a restart
 * signs everyone out, which is the intended trade for a self-hosted tool.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly ttlMs = EIGHT_HOURS_MS,
    private readonly now: () => number = Date.now,
  ) {}

  create(session: Omit<Session, "expiresAt">): string {
    const id = randomBytes(24).toString("hex");
    this.sessions.set(id, { ...session, expiresAt: this.now() + this.ttlMs });
    return id;
  }

  get(id: string): Session | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }
}
