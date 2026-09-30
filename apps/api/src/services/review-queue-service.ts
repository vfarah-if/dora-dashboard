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
import { NotFoundError, UnauthorisedError, ValidationError } from "../core/errors.js";
import type { RepoStore } from "../interfaces/repo-store.js";
import type { SourceProvider } from "../interfaces/source-provider.js";

// ADR 0017: each repository's open pull requests are kept for this long, per token, in memory only.
export const REVIEW_QUEUE_TTL_MS = 60_000;
/** A refresh of something read more recently than this is ignored, so a held-down button cannot hammer the host. */
export const REFRESH_FLOOR_MS = 5_000;
const CONCURRENCY = 4;

interface Cached {
  at: number;
  pullRequests: OpenPullRequest[];
  truncated: boolean;
}

export interface ReviewQueueOptions {
  /** Read again even if the cache is fresh (ignored for a read under 5 seconds old). */
  refresh?: boolean;
  /** Include author logins and reviewer names. Off by default (ADR 0008). */
  names?: boolean;
}

type Read = { input: ReviewQueueInput; warning?: ReviewQueueError } | { error: ReviewQueueError };

/**
 * Open pull requests across repositories, read live from the host. Each repository's read is kept for a minute so a
 * page left open, or several people opening it, does not hammer the host; `refresh` reads again. Nothing is stored.
 * The cache is keyed on a hash of the token and the repository, so a person who cannot see a repository never receives
 * what someone else's token read from it, and no token is kept as a key.
 */
export class ReviewQueueService {
  private readonly cache = new Map<string, Cached>();
  private readonly inFlight = new Map<string, Promise<Cached>>();

  constructor(
    private readonly store: RepoStore,
    private readonly provider: SourceProvider,
    private readonly clock: () => Date = () => new Date(),
    private readonly ttlMs = REVIEW_QUEUE_TTL_MS,
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

  /** Reads in repository order with at most CONCURRENCY in flight. */
  private async readAll(token: string, repos: Repo[], refresh: boolean): Promise<Read[]> {
    const results: Read[] = new Array<Read>(repos.length);
    let next = 0;
    const worker = async () => {
      while (next < repos.length) {
        const index = next++;
        results[index] = await this.read(token, repos[index]!, refresh);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, repos.length) }, worker));
    return results;
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
      if (!cached.truncated) return { input };
      const message = `Showing the ${cached.pullRequests.length} most recently updated open pull requests`;
      return { input, warning: { repoId: repo.id, repo: `${repo.owner}/${repo.name}`, message } };
    } catch (error) {
      // A rejected credential fails every repository the same way, so say so rather than list each one.
      if (error instanceof UnauthorisedError) throw error;
      const message = error instanceof Error ? error.message : "The repository could not be read";
      return { error: { repoId: repo.id, repo: `${repo.owner}/${repo.name}`, message } };
    }
  }

  /** The cached read when fresh, else the read already under way for this key, else a new one. */
  private load(token: string, repo: Repo, refresh: boolean): Promise<Cached> {
    const key = this.key(token, repo);
    const now = this.clock().getTime();
    const cached = this.cache.get(key);
    if (cached) {
      const age = now - cached.at;
      if (age < this.ttlMs && (!refresh || age < REFRESH_FLOOR_MS)) return Promise.resolve(cached);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const started = this.provider.fetchOpenPullRequests(token, repo.owner, repo.name).then((result) => {
      const fresh: Cached = { at: now, ...result };
      this.prune(now);
      this.cache.set(key, fresh);
      return fresh;
    });
    const tracked = started.finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, tracked);
    return tracked;
  }

  /** Drops reads past their time to live so the cache does not grow with every token and repository seen. */
  private prune(now: number): void {
    for (const [key, cached] of this.cache) if (now - cached.at >= this.ttlMs) this.cache.delete(key);
  }
}

/** People are named only when asked for; the count of reviewers asked stays so the page can still say how many. */
function withoutNames(entry: QueueEntry): QueueEntry {
  return { ...entry, author: null, requestedReviewers: [], headRef: "" };
}
