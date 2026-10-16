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

// ADR 0017: each repository's open pull requests are kept for this long, per token, in memory only.
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
/** The raw text, for the log only. */
const raw = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Cached {
  at: number;
  pullRequests: OpenPullRequest[];
  truncated: boolean;
  /** Why the latest background read failed, while this read is still being served stale. Cleared by the next success. */
  failure?: string;
}

export interface ReviewQueueOptions {
  /**
   * Read again even if the cache is fresh (ignored for a read under 5 seconds old): every repository when true, or only
   * those listed, the rest served as an ordinary request would be. A listed id that is not being read is ignored.
   */
  refresh?: boolean | readonly number[];
  /** Include author logins and reviewer names. Off by default (ADR 0008). */
  names?: boolean;
}

type Read = { input: ReviewQueueInput; warning?: ReviewQueueError } | { error: ReviewQueueError };

/**
 * Open pull requests across repositories, read live from the host. Each repository's read is kept for a minute so a
 * page left open, or several people opening it, does not hammer the host; `refresh` reads again. Past the minute a read
 * is still served, and read again in the background, until it is ten minutes old. Nothing is stored.
 * The cache is keyed on a hash of the token and the repository, so a person who cannot see a repository never receives
 * what someone else's token read from it, and no token is kept as a key.
 */
export class ReviewQueueService {
  private readonly cache = new Map<string, Cached>();
  private readonly inFlight = new Map<string, Promise<Cached>>();
  /** Per hashed token; an entry exists only while that token has a read running or waiting. */
  private readonly limits = new Map<string, { active: number; waiting: (() => void)[] }>();

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
    const reads = await this.readAll(token, repos, options.refresh ?? false);
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

  /** Every repository is started at once; the limiter holds the host reads, awaited or background, to CONCURRENCY. */
  private readAll(token: string, repos: Repo[], refresh: boolean | readonly number[]): Promise<Read[]> {
    const again = (repo: Repo) => (typeof refresh === "boolean" ? refresh : refresh.includes(repo.id));
    return Promise.all(repos.map((repo) => this.read(token, repo, again(repo))));
  }

  private key(token: string, repo: Repo): string {
    return createHash("sha256").update(`${token}\u0000${repo.id}`).digest("hex");
  }

  private async read(token: string, repo: Repo, refresh: boolean): Promise<Read> {
    try {
      const cached = await this.load(token, repo, refresh);
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
    } catch (error) {
      // A rejected credential fails every repository the same way, so say so rather than list each one.
      if (error instanceof UnauthorisedError) throw error;
      const name = `${repo.owner}/${repo.name}`;
      if (!(error instanceof AppError))
        this.log.warn({ repo: name }, `Reading open pull requests for ${name} failed: ${raw(error)}`);
      return { error: { repoId: repo.id, repo: name, message: shown(error) } };
    }
  }

  /**
   * The cached read when fresh, else a stale one (read again in the background), else the read already under way for
   * this key, else a new one.
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
    return this.inFlight.get(key) ?? this.start(key, token, repo);
  }

  private start(key: string, token: string, repo: Repo): Promise<Cached> {
    const started = this.limited(token, () => this.provider.fetchOpenPullRequests(token, repo.owner, repo.name)).then(
      (result) => {
        // Stamped when the read completes, not when it began, so a slow read is not already old when it lands.
        const now = this.clock().getTime();
        const fresh: Cached = { at: now, ...result };
        this.prune(now);
        this.cache.set(key, fresh);
        return fresh;
      },
    );
    const tracked = started.finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, tracked);
    return tracked;
  }

  /**
   * Runs `read` once fewer than CONCURRENCY reads are running for this token, in the order asked. The state is keyed on
   * a hash of the token and removed when the token has nothing running or waiting.
   */
  private async limited<T>(token: string, read: () => Promise<T>): Promise<T> {
    const id = createHash("sha256").update(token).digest("hex");
    let state = this.limits.get(id);
    if (!state) this.limits.set(id, (state = { active: 0, waiting: [] }));
    const mine = state;
    if (mine.active >= CONCURRENCY) await new Promise<void>((resolve) => mine.waiting.push(resolve));
    else mine.active++;
    try {
      return await read();
    } finally {
      const next = mine.waiting.shift();
      if (next)
        next(); // the slot passes straight to the next read
      else if (--mine.active < 1) this.limits.delete(id);
    }
  }

  /**
   * Nobody awaits this read, so a failure must not escape. When access has gone the stale read is dropped, so the next
   * request waits and surfaces the refusal. Any other failure is logged and remembered on the stale read, which goes
   * on being served with a warning until a read succeeds or the stale window ends.
   */
  private readInBackground(key: string, token: string, repo: Repo): void {
    this.start(key, token, repo).catch((error: unknown) => {
      const name = `${repo.owner}/${repo.name}`;
      if (lostAccess(error)) {
        this.cache.delete(key);
        this.log.warn({ repo: name }, `Dropped the review queue read of ${name}, because access to it has gone: ${raw(error)}`);
        return;
      }
      const cached = this.cache.get(key);
      if (cached) this.cache.set(key, { ...cached, failure: shown(error) });
      this.log.warn({ repo: name }, `The background read of open pull requests for ${name} failed: ${raw(error)}`);
    });
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
  // GitHub answers a narrowed token with 403, which the adapter reports as an upstream error; a rate limit is not that,
  // and the adapter marks it rather than leaving the service to read its wording.
  return error instanceof UpstreamError && error.status === 403 && !error.rateLimited;
}

/** People are named only when asked for; the count of reviewers asked stays so the page can still say how many. */
function withoutNames(entry: QueueEntry): QueueEntry {
  return { ...entry, author: null, requestedReviewers: [], headRef: "" };
}
