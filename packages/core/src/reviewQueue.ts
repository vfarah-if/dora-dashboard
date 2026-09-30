import { groupFeatures, ticketKeysOf } from "./features.js";
import { externalReviews, isBot } from "./pullRequests.js";
import { hoursBetween, weekdayHoursBetween } from "./stats.js";
import type {
  OpenPullRequest,
  QueueEntry,
  Repo,
  RepoQueueSummary,
  ReviewLane,
  ReviewQueue,
  ReviewQueueTiles,
  WaitBand,
} from "./types.js";

export const FRESH_BELOW_HOURS = 4;
export const OVERDUE_ABOVE_HOURS = 24;
/** Five weekdays. */
export const STALE_FROM_HOURS = 120;
export const FAST_LANE_LINES_BELOW = 400;
export const FAST_LANE_FILES_BELOW = 10;
export const IDLE_FROM_DAYS = 14;

const ON_HOLD = /^on[\s_-]?hold$/i;
const DAY_HOURS = 24;

export const REVIEW_LANES: readonly ReviewLane[] = ["held", "with_author", "approved", "awaiting_review", "no_reviewer"];
export const WAIT_BANDS: readonly WaitBand[] = ["fresh", "ageing", "overdue", "stale"];

/** Reviews by people other than the author and other than bots, which approve or comment without anyone having looked. */
function humanReviews(pr: OpenPullRequest) {
  return externalReviews(pr).filter((r) => !isBot({ author: r.author, authorIsBot: r.authorIsBot ?? false }));
}

/** What each reviewer currently stands for: their latest approval or request for changes, unless it was dismissed. */
function standing(pr: OpenPullRequest): { approvals: number; changesRequested: number } {
  const byReviewer = new Map<string, "APPROVED" | "CHANGES_REQUESTED">();
  const ordered = [...humanReviews(pr)].sort((a, b) => a.submittedAt!.localeCompare(b.submittedAt!));
  for (const review of ordered) {
    if (review.state === "DISMISSED") byReviewer.delete(review.author!);
    else if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") byReviewer.set(review.author!, review.state);
  }
  // A reviewer asked to look again has the ball, whatever they said before.
  for (const asked of pr.requestedReviewers) byReviewer.delete(asked.name);
  const states = [...byReviewer.values()];
  return {
    approvals: states.filter((s) => s === "APPROVED").length,
    changesRequested: states.filter((s) => s === "CHANGES_REQUESTED").length,
  };
}

/**
 * Who has to act next, first match wins: held (a draft, or labelled on hold), with the author (failing checks, changes
 * requested, or comments and nobody asked to look again), approved, awaiting review (someone is asked), otherwise
 * no reviewer.
 */
export function reviewLane(pr: OpenPullRequest): ReviewLane {
  if (pr.isDraft || (pr.labels ?? []).some((label) => ON_HOLD.test(label.trim()))) return "held";
  const { approvals, changesRequested } = standing(pr);
  const commented = humanReviews(pr).some((r) => r.state === "COMMENTED");
  const noOneAsked = pr.requestedReviewers.length === 0;
  if (pr.checks === "failing" || changesRequested > 0 || (commented && noOneAsked && approvals === 0)) return "with_author";
  if (approvals > 0) return "approved";
  return noOneAsked ? "no_reviewer" : "awaiting_review";
}

/** The later of the moment the pull request was published and the last review by someone else. */
export function waitingSince(pr: OpenPullRequest): string {
  const reviews = humanReviews(pr).map((r) => r.submittedAt!);
  return [pr.publishedAt ?? pr.createdAt, ...reviews].sort().at(-1)!;
}

/** Fresh under 4 weekday hours, ageing up to and including 24, overdue beyond 24, stale from 120. */
export function waitBand(waitHours: number): WaitBand {
  if (waitHours >= STALE_FROM_HOURS) return "stale";
  if (waitHours > OVERDUE_ABOVE_HOURS) return "overdue";
  if (waitHours >= FRESH_BELOW_HOURS) return "ageing";
  return "fresh";
}

export const isWaiting = (lane: ReviewLane) => lane === "awaiting_review" || lane === "no_reviewer";

const emptyLanes = (): Record<ReviewLane, number> => ({
  held: 0,
  with_author: 0,
  approved: 0,
  awaiting_review: 0,
  no_reviewer: 0,
});
const emptyBands = (): Record<WaitBand, number> => ({ fresh: 0, ageing: 0, overdue: 0, stale: 0 });

export interface ReviewQueueInput {
  repo: Pick<Repo, "id" | "owner" | "name">;
  pullRequests: OpenPullRequest[];
  /** When these were read from the host; the queue reports the oldest. Defaults to `now`. */
  fetchedAt?: string;
}

function entryOf(repo: ReviewQueueInput["repo"], pr: OpenPullRequest, now: string): QueueEntry {
  const since = waitingSince(pr);
  const waitHours = weekdayHoursBetween(since, now);
  return {
    key: `${repo.id}#${pr.number}`,
    repoId: repo.id,
    repo: `${repo.owner}/${repo.name}`,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    authorIsBot: pr.authorIsBot,
    lane: reviewLane(pr),
    band: waitBand(waitHours),
    waitHours,
    waitingSince: since,
    requestedReviewers: pr.requestedReviewers,
    requestedReviewerCount: pr.requestedReviewers.length,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    checks: pr.checks,
    isDraft: pr.isDraft,
    labels: pr.labels ?? [],
    ticketKeys: ticketKeysOf(pr),
    headRef: pr.headRef,
    updatedAt: pr.updatedAt,
    idleDays: Math.max(0, Math.floor((hoursBetween(pr.updatedAt, now) ?? 0) / DAY_HOURS)),
  };
}

/** Stale and unowned, stale, then overdue and unowned; anything else does not need attention. */
function attentionRank(entry: QueueEntry): number | null {
  if (!isWaiting(entry.lane)) return null;
  if (entry.band === "stale") return entry.lane === "no_reviewer" ? 0 : 1;
  if (entry.band === "overdue" && entry.lane === "no_reviewer") return 2;
  return null;
}

const longest = (entries: QueueEntry[]) => (entries.length ? Math.max(...entries.map((e) => e.waitHours)) : null);

function tilesOf(entries: QueueEntry[]): ReviewQueueTiles {
  const waiting = entries.filter((e) => isWaiting(e.lane));
  const pastDay = waiting.filter((e) => e.band === "overdue" || e.band === "stale");
  const noReviewer = waiting.filter((e) => e.lane === "no_reviewer");
  const stale = waiting.filter((e) => e.band === "stale");
  return {
    waiting: {
      count: waiting.length,
      repos: new Set(waiting.map((e) => e.repoId)).size,
      heldForRedChecks: entries.filter((e) => e.lane === "with_author" && e.checks === "failing").length,
    },
    pastDay: { count: pastDay.length, longestHours: longest(pastDay) },
    noReviewer: { count: noReviewer.length, oldestHours: longest(noReviewer) },
    stale: { count: stale.length, longestHours: longest(stale) },
    fastLane: {
      count: waiting.filter((e) => e.additions + e.deletions < FAST_LANE_LINES_BELOW && e.changedFiles < FAST_LANE_FILES_BELOW)
        .length,
    },
    idle: { count: entries.filter((e) => e.idleDays >= IDLE_FROM_DAYS).length },
  };
}

function summaryOf(input: ReviewQueueInput, entries: QueueEntry[]): RepoQueueSummary {
  const mine = entries.filter((e) => e.repoId === input.repo.id);
  const bands = emptyBands();
  const lanes = emptyLanes();
  for (const entry of mine) {
    lanes[entry.lane]++;
    if (isWaiting(entry.lane)) bands[entry.band]++;
  }
  return { repoId: input.repo.id, repo: `${input.repo.owner}/${input.repo.name}`, open: mine.length, bands, lanes };
}

/**
 * The review queue across repositories. Pure: `now` is passed in as an ISO timestamp, and waits are weekday hours in UTC.
 * The caller fills `errors` for repositories it could not read.
 */
export function buildReviewQueue(inputs: ReviewQueueInput[], options: { now: string }): ReviewQueue {
  const { now } = options;
  const pairs = inputs.flatMap((input) => input.pullRequests.map((pr) => ({ input, pr, entry: entryOf(input.repo, pr, now) })));
  const byWait = (a: QueueEntry, b: QueueEntry) => b.waitHours - a.waitHours || a.key.localeCompare(b.key);
  const entries = pairs.map((p) => p.entry).sort(byWait);
  const needsAttention = entries
    .flatMap((entry) => {
      const rank = attentionRank(entry);
      return rank === null ? [] : [{ entry, rank }];
    })
    .sort((a, b) => a.rank - b.rank || byWait(a.entry, b.entry))
    .map((x) => x.entry.key);
  const fetched = inputs.map((i) => i.fetchedAt ?? now).sort();
  return {
    now,
    fetchedAt: fetched[0] ?? now,
    entries,
    tiles: tilesOf(entries),
    repos: inputs.map((input) => summaryOf(input, entries)),
    needsAttention,
    features: groupFeatures(pairs.map((p) => ({ repo: p.input.repo, pr: p.pr, entry: p.entry }))),
    errors: [],
    warnings: [],
  };
}
