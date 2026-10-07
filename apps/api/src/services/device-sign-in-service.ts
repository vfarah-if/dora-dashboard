import { randomBytes } from "node:crypto";
import { RateLimitedError } from "../core/errors.js";
import type { DeviceAuthorisation } from "../interfaces/device-authorisation.js";
import type { SourceProvider } from "../interfaces/source-provider.js";
import type { SessionStore } from "../interfaces/token-source.js";

export const MAX_PENDING_SIGN_INS = 20;
export const MIN_START_GAP_MS = 2000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** A sign-in the browser has started but GitHub has not yet confirmed. Lives in memory only. */
interface Pending {
  deviceCode: string;
  /** Seconds between GitHub polls. */
  interval: number;
  lastPolledAt: number;
  expiresAt: number;
}

export interface StartedSignIn {
  /** Opaque handle the route keeps in a cookie; the device code never leaves the service. */
  id: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface PollOutcome {
  status: "pending" | "granted" | "expired" | "denied";
  interval: number;
  /** True when the pending entry is gone, so the browser should drop its handle. */
  settled: boolean;
  /** Present on a grant: the new session's id and the signed-in user. */
  granted?: { sessionId: string; user: { login: string; avatarUrl: string } };
}

/**
 * Walks a browser through GitHub's device flow. It owns the pending sign-ins, enforces GitHub's poll
 * interval, caps how many can be open and how fast they start, and turns a grant into a session.
 */
export class DeviceSignInService {
  private readonly pending = new Map<string, Pending>();
  private lastStartAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly device: DeviceAuthorisation,
    private readonly sessions: SessionStore,
    private readonly provider: SourceProvider,
    private readonly now: () => number = Date.now,
  ) {}

  /** Sign-ins currently waiting on GitHub, after discarding expired ones. */
  pendingCount(): number {
    this.prune();
    return this.pending.size;
  }

  /** `previousId` is the handle this browser already held, which is replaced. */
  async start(previousId: string | null): Promise<StartedSignIn> {
    this.prune();
    if (previousId) this.pending.delete(previousId);
    const started = this.now();
    if (this.pending.size >= MAX_PENDING_SIGN_INS || started - this.lastStartAt < MIN_START_GAP_MS) {
      throw new RateLimitedError("Too many sign-in attempts. Wait a moment and try again.");
    }
    this.lastStartAt = started;
    const code = await this.device.start();
    const id = randomBytes(24).toString("hex");
    this.pending.set(id, {
      deviceCode: code.deviceCode,
      interval: code.interval,
      lastPolledAt: started,
      expiresAt: started + code.expiresIn * 1000,
    });
    return {
      id,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      interval: code.interval,
      expiresIn: code.expiresIn,
    };
  }

  /** `retiredSessionId` is a session this browser already held, deleted if the sign-in is granted. */
  async poll(id: string | null, retiredSessionId: string | null): Promise<PollOutcome> {
    const entry = id ? this.pending.get(id) : undefined;
    if (!id || !entry || entry.expiresAt <= this.now()) return this.expire(id, entry);
    if (this.now() - entry.lastPolledAt < entry.interval * 1000) return this.waiting(entry);

    entry.lastPolledAt = this.now();
    const result = await this.device.poll(entry.deviceCode);
    if (result.status === "pending" || result.status === "slow_down") {
      return this.keepWaiting(entry, result.status, result.interval);
    }
    // GitHub has consumed the device code whatever happens next, so the entry goes either way.
    this.pending.delete(id);
    if (result.status !== "granted") return { status: result.status, interval: entry.interval, settled: true };
    return this.grant(entry, result.token, retiredSessionId);
  }

  /** Drops a sign-in that is unknown or has run out of time. */
  private expire(id: string | null, entry: Pending | undefined): PollOutcome {
    if (id) this.pending.delete(id);
    return { status: "expired", interval: entry?.interval ?? DEFAULT_POLL_INTERVAL_SECONDS, settled: true };
  }

  /** Keeps a sign-in waiting. On `slow_down` the interval becomes the one GitHub names, or grows by the default. */
  private keepWaiting(entry: Pending, status: "pending" | "slow_down", interval: number | undefined): PollOutcome {
    if (status === "slow_down") entry.interval = interval ?? entry.interval + DEFAULT_POLL_INTERVAL_SECONDS;
    return this.waiting(entry);
  }

  private async grant(entry: Pending, token: string, retiredSessionId: string | null): Promise<PollOutcome> {
    const viewer = await this.provider.fetchViewer(token);
    if (retiredSessionId) this.sessions.delete(retiredSessionId);
    const sessionId = this.sessions.create({ token, ...viewer });
    return {
      status: "granted",
      interval: entry.interval,
      settled: true,
      granted: { sessionId, user: { login: viewer.login, avatarUrl: viewer.avatarUrl } },
    };
  }

  private waiting(entry: Pending): PollOutcome {
    return { status: "pending", interval: entry.interval, settled: false };
  }

  private prune(): void {
    for (const [key, entry] of this.pending) if (entry.expiresAt <= this.now()) this.pending.delete(key);
  }
}
