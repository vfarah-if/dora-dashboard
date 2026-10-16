import { createHash } from "node:crypto";
import {
  buildReviewQueue,
  type OpenPullRequest,
  type QueueEntry,
  type Repo,
  type ReviewQueue,
  type ReviewQueueError,
  type ReviewQueueInput,
} from "@dora-dashboard/core";
import {
  AccessRefusedError,
  AppError,
  ForbiddenError,
  NotFoundError,
  UnauthorisedError,
  UpstreamError,
  ValidationError,
} from "../core/errors.js";
import { noopLogger, type Logger } from "../interfaces/logger.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SourceProvider } from "../interfaces/source-provider.js";

// ADR 0017: a read younger than this is served as it is. Reads are held, per token and in memory only, until
// REVIEW_QUEUE_STALE_MS, and one older than this is served while it is read again.
export const REVIEW_QUEUE_TTL_MS = 60_000;
/** A refresh of something read more recently than this is ignored, so a held-down button cannot hammer the host. */
export const REFRESH_FLOOR_MS = 5_000;
/**
 * A read older than the time to live but younger than this is still served at once while a read runs in the
 * background, so a poll every minute is never kept waiting for every repository to be read again.
 */
export const REVIEW_QUEUE_STALE_MS = 10 * 60_000;
const CONCURRENCY = 4;
/** What a person is told when a read failed for a reason that is not one of the app's own errors. */
const UNREADABLE = "The repository could not be read";

/** The text that may be shown: an `AppError`'s message is fit to show, anything else is not and is replaced. */
const shown = (error: unknown): string => (error instanceof AppError ? error.message : UNREADABLE);

/** A token's limiter state: reads running, and those waiting for a slot, awaited ones ahead of background ones. */
interface Limit {
  active: number;
  awaited: (() => void)[];
  background: (() => void)[];
}

interface Cached {
  at: number;
  pullRequests: OpenPullRequest[];
  truncated: boolean;
  /** Why the latest background read failed, while this read is still being served stale. Cleared by the next success. */
  failure?: string;
}

/**
 * Which repositories a request reads again: `"all"`, or `{ only: ids }`, the rest being served as an ordinary request
 * would serve them. `{ only: [] }` reads none, the same as leaving `refresh` out. A listed id that is not being read is
 * ignored.
 */
export type RefreshScope = "all" | { only: readonly number[] };

export interface ReviewQueueOptions {
  /**
   * Read again past a fresh or stale cache, so a refreshed repository is never served stale. A read under
   * REFRESH_FLOOR_MS old is left alone. Absent means no repository is read again.
   */
  refresh?: RefreshScope;
  /** Include author logins and reviewer names. Off by default (ADR 0008). */
  names?: boolean;
}

type Read = { input: ReviewQueueInput; warning?: ReviewQueueError } | { error: ReviewQueueError };

/**
 * Open pull requests across repositories, read live from the host. A read younger than REVIEW_QUEUE_TTL_MS is served as
 * it is, so a page left open, or several people opening it, does not hammer the host; `refresh` reads again. Past that
 * a read is still served, and read again in the background, until it is REVIEW_QUEUE_STALE_MS old. Nothing is stored.
 * The cache is keyed on a hash of the token and the repository, so a person who cannot see a repository never receives
 * what someone else's token read from it, and no token is kept as a key.
 */
export class ReviewQueueService {
  private readonly cache = new Map<string, Cached>();
  private readonly inFlight = new Map<string, Promise<Cached>>();
  /** Per hashed token; an entry exists only while that token has a read running or waiting. */
  private readonly limits = new Map<string, Limit>();
  /** Per key whose read is queued behind the limiter as background work: moves it ahead of the background reads. */
  private readonly promotions = new Map<string, () => void>();

  constructor(
    private readonly store: RepoStore,
    private readonly provider: SourceProvider,
    private readonly clock: () => Date = () => new Date(),
    private readonly log: Logger = noopLogger,
    private readonly ttlMs = REVIEW_QUEUE_TTL_MS,
    private readonly staleMs = REVIEW_QUEUE_STALE_MS,
  ) {}

  /** The queue for the given repositories, or every repository when `ids` is undefined. */
  async queue(token: string, ids: number[] | undefined, options: ReviewQueueOptions = {}): Promise<ReviewQueue> {
    const repos = this.repos(ids);
    const reads = await this.readAll(token, repos, options.refresh);
    const inputs = reads.flatMap((r) => ("input" in r ? [r.input] : []));
    const errors = reads.flatMap((r) => ("error" in r ? [r.error] : []));
    const warnings = reads.flatMap((r) => ("warning" in r && r.warning ? [r.warning] : []));
    const queue = buildReviewQueue(inputs, { now: this.clock().toISOString() });
    return {
      ...queue,
      entries: options.names ? queue.entries : queue.entries.map(withoutNames),
      errors,
      warnings,
    };
  }

  private repos(ids: number[] | undefined): Repo[] {
    if (!ids) return this.store.listRepos();
    if (ids.length < 1) throw new ValidationError("Choose at least one repository");
    return [...new Set(ids)].map((id) => {
      const repo = this.store.getRepo(id);
      if (!repo) throw new NotFoundError(`Unknown repository ${id}`);
      return repo;
    });
  }

  /** Every repository is started at once; the limiter holds each token's host reads, awaited or background, to CONCURRENCY. */
  private readAll(token: string, repos: Repo[], refresh: RefreshScope | undefined): Promise<Read[]> {
    const again = (repo: Repo) => refresh === "all" || (refresh !== undefined && refresh.only.includes(repo.id));
    return Promise.all(repos.map((repo) => this.read(token, repo, again(repo))));
  }

  private key(token: string, repo: Repo): string {
    return createHash("sha256").update(`${token}\u0000${repo.id}`).digest("hex");
  }

  private async read(token: string, repo: Repo, refresh: boolean): Promise<Read> {
    try {
      return this.present(repo, await this.load(token, repo, refresh));
    } catch (error) {
      // A rejected credential fails every repository the same way, so say so rather than list each one.
      if (error instanceof UnauthorisedError) throw error;
      // `start` has already dropped the earlier read when access has gone, and noted the failure on it otherwise, so
      // one that is still held is served with that warning, as a failed background read would be.
      const earlier = this.cache.get(this.key(token, repo));
      if (earlier) return this.present(repo, earlier);
      return { error: { repoId: repo.id, repo: `${repo.owner}/${repo.name}`, message: shown(error) } };
    }
  }

  /** The repository's read as the queue's input, with a warning when it was cut short or the latest read failed. */
  private present(repo: Repo, cached: Cached): Read {
    const input: ReviewQueueInput = {
      repo,
      pullRequests: cached.pullRequests,
      fetchedAt: new Date(cached.at).toISOString(),
    };
    const notes: string[] = [];
    if (cached.truncated) notes.push(`Showing the ${cached.pullRequests.length} most recently updated open pull requests`);
    if (cached.failure !== undefined) {
      notes.push(`Showing pull requests read earlier, because the latest read failed: ${cached.failure}`);
    }
    if (notes.length < 1) return { input };
    const message = notes.join(". ");
    return { input, warning: { repoId: repo.id, repo: `${repo.owner}/${repo.name}`, message } };
  }

  /**
   * The cached read when fresh, else a stale one (read again in the background), else the read already under way for
   * this key, else a new one. A refresh past REFRESH_FLOOR_MS skips the fresh and the stale answers and always waits
   * for a read, sharing one that is under way; joining a read still queued as background work moves it to the front.
   */
  private load(token: string, repo: Repo, refresh: boolean): Promise<Cached> {
    const key = this.key(token, repo);
    // Pruned here as well as after a read, so a key whose reads keep failing still leaves when its window ends.
    this.prune(this.clock().getTime());
    const cached = this.cache.get(key);
    if (cached) {
      const age = this.clock().getTime() - cached.at;
      if (age < this.ttlMs && (!refresh || age < REFRESH_FLOOR_MS)) return Promise.resolve(cached);
      if (!refresh && age < this.staleMs) {
        if (!this.inFlight.has(key)) this.readInBackground(key, token, repo);
        return Promise.resolve(cached);
      }
    }
    const running = this.inFlight.get(key);
    if (running) {
      // Someone now waits on this read, so it is no longer background work.
      this.promotions.get(key)?.();
      return running;
    }
    return this.start(key, token, repo, false);
  }

  /**
   * Starts the one read for this key, and is where its outcome is recorded for every request that shares it, awaited or
   * background. When access has gone the earlier read is dropped; any other failure is noted on it, to be served as a
   * warning until a read succeeds or the stale window ends. The error is rethrown for whoever waits.
   */
  private start(key: string, token: string, repo: Repo, background: boolean): Promise<Cached> {
    const started = this.limited(token, key, background, () =>
      this.provider.fetchOpenPullRequests(token, repo.owner, repo.name),
    ).then(
      (result) => {
        // Stamped when the read completes, not when it began, so a slow read is not already old when it lands.
        const now = this.clock().getTime();
        const fresh: Cached = { at: now, ...result };
        this.prune(now);
        this.cache.set(key, fresh);
        return fresh;
      },
      (error: unknown) => {
        this.failed(key, repo, error);
        throw error;
      },
    );
    const tracked = started.finally(() => {
      this.inFlight.delete(key);
      this.promotions.delete(key);
    });
    this.inFlight.set(key, tracked);
    return tracked;
  }

  private failed(key: string, repo: Repo, error: unknown): void {
    const gone = lostAccess(error);
    if (gone) {
      this.cache.delete(key);
    } else {
      const cached = this.cache.get(key);
      if (cached) this.cache.set(key, { ...cached, failure: shown(error) });
    }
    // The error object goes to the log whole, for its cause and stack; it never carries the token. A failure the app
    // raised on purpose is a warning, anything else was not planned for.
    const context = { err: error, repo: `${repo.owner}/${repo.name}` };
    const message = gone
      ? "Reading open pull requests failed because access has gone, so the earlier read was dropped"
      : "Reading open pull requests failed";
    if (error instanceof AppError) this.log.warn(context, message);
    else this.log.error(context, message);
  }

  /**
   * Runs `read` once fewer than CONCURRENCY reads are running for this token. A freed slot goes to the longest waiting
   * awaited read, then to the longest waiting background read, so a person's refresh is not held behind reads nobody is
   * waiting for. The state is keyed on a hash of the token and removed when the token has nothing running or waiting.
   */
  private async limited<T>(token: string, key: string, background: boolean, read: () => Promise<T>): Promise<T> {
    const id = createHash("sha256").update(token).digest("hex");
    const mine: Limit = this.limits.get(id) ?? { active: 0, awaited: [], background: [] };
    this.limits.set(id, mine);
    if (mine.active >= CONCURRENCY) {
      await new Promise<void>((resolve) => {
        if (background) {
          mine.background.push(resolve);
          this.promotions.set(key, () => {
            const at = mine.background.indexOf(resolve);
            if (at < 0) return; // already running, or already promoted
            mine.background.splice(at, 1);
            mine.awaited.push(resolve);
          });
        } else {
          mine.awaited.push(resolve);
        }
      });
    } else {
      mine.active++;
    }
    try {
      return await read();
    } finally {
      const next = mine.awaited.shift() ?? mine.background.shift();
      if (next)
        next(); // the slot passes straight to the next read
      else if (--mine.active < 1) this.limits.delete(id);
    }
  }

  /**
   * Starts a read nobody is waiting on when it begins; a later request may still share it through `inFlight`, and
   * `start` has recorded and logged any failure by then, so the catch here only stops an unhandled rejection.
   */
  private readInBackground(key: string, token: string, repo: Repo): void {
    this.start(key, token, repo, true).catch(() => undefined);
  }

  /** Drops reads past the stale window so the cache does not grow with every token and repository seen. */
  private prune(now: number): void {
    for (const [key, cached] of this.cache) if (now - cached.at >= this.staleMs) this.cache.delete(key);
  }
}

/** The host no longer lets this credential read the repository, so what it read before must not go on being served. */
function lostAccess(error: unknown): boolean {
  if (
    error instanceof UnauthorisedError ||
    error instanceof NotFoundError ||
    error instanceof ForbiddenError ||
    error instanceof AccessRefusedError
  ) {
    return true;
  }
  // GitHub answers a narrowed token with 403, which the adapter reports as an upstream error. A rate limit is not that,
  // and the adapter marks it, over HTTP or in a GraphQL reply, rather than leaving the service to read its wording. The
  // adapter also reports a GraphQL NOT_FOUND on the repository as `NotFoundError` and FORBIDDEN as `AccessRefusedError`,
  // so those arrive here as the typed errors above.
  return error instanceof UpstreamError && error.status === 403 && !error.rateLimited;
}

/** People are named only when asked for; the count of reviewers asked stays so the page can still say how many. */
function withoutNames(entry: QueueEntry): QueueEntry {
  return { ...entry, author: null, requestedReviewers: [], headRef: "" };
}
