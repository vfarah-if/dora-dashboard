import type { PullRequest } from "./types.js";
import { hoursBetween } from "./stats.js";

export interface PrTimings {
  number: number;
  title: string;
  url: string;
  author: string | null;
  createdAt: string;
  mergedAt: string | null;
  /** First commit to PR opened: how quickly work became a pull request. */
  codingHours: number | null;
  /** Ready for review to the first review by someone other than the author. */
  firstReviewHours: number | null;
  /** Ready for review to the first approval by someone other than the author. */
  approvalHours: number | null;
  /** PR opened to merged. */
  openToMergeHours: number | null;
  /** First commit to merged. */
  cycleHours: number | null;
  /** Split of cycle time into consecutive stages, each clamped at zero. */
  stages: { coding: number; waitingForReview: number; inReview: number; toMerge: number } | null;
  reviewed: boolean;
  reviewerCount: number;
  /** Reviews requesting changes, plus one for the final pass. */
  reviewRounds: number;
  size: number;
}

const BOT_LOGIN = /\[bot\]$|^dependabot|^renovate/i;

export function isBot(pr: Pick<PullRequest, "author" | "authorIsBot">): boolean {
  return pr.authorIsBot || (pr.author !== null && BOT_LOGIN.test(pr.author));
}

const clamp = (h: number | null) => (h === null ? 0 : Math.max(0, h));

function earliest(values: (string | null)[]): string | null {
  const present = values.filter((v): v is string => v !== null).sort();
  return present[0] ?? null;
}

export function prTimings(pr: PullRequest): PrTimings {
  // A review the author leaves on their own PR is a comment, not a review.
  const external = pr.reviews.filter(
    (r) => r.submittedAt !== null && r.author !== null && r.author !== pr.author && r.state !== "PENDING",
  );
  const readyAt = pr.publishedAt ?? pr.createdAt;
  const firstReviewAt = earliest(external.map((r) => r.submittedAt));
  const firstApprovalAt = earliest(external.filter((r) => r.state === "APPROVED").map((r) => r.submittedAt));

  // A rebased branch can carry a first commit dated after the PR opened; treat that as no coding time.
  const firstCommitAt = pr.firstCommitAt && pr.firstCommitAt < pr.createdAt ? pr.firstCommitAt : pr.createdAt;

  let stages: PrTimings["stages"] = null;
  if (pr.mergedAt) {
    const reviewStart = firstReviewAt && firstReviewAt < pr.mergedAt ? firstReviewAt : null;
    const reviewEnd = firstApprovalAt && firstApprovalAt < pr.mergedAt ? firstApprovalAt : reviewStart;
    stages = {
      coding: clamp(hoursBetween(firstCommitAt, pr.createdAt)),
      waitingForReview: clamp(hoursBetween(pr.createdAt, reviewStart ?? pr.mergedAt)),
      inReview: reviewStart ? clamp(hoursBetween(reviewStart, reviewEnd)) : 0,
      toMerge: reviewEnd ? clamp(hoursBetween(reviewEnd, pr.mergedAt)) : 0,
    };
  }

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    codingHours: hoursBetween(firstCommitAt, pr.createdAt),
    firstReviewHours: firstReviewAt ? clamp(hoursBetween(readyAt, firstReviewAt)) : null,
    approvalHours: firstApprovalAt ? clamp(hoursBetween(readyAt, firstApprovalAt)) : null,
    openToMergeHours: hoursBetween(pr.createdAt, pr.mergedAt),
    cycleHours: hoursBetween(firstCommitAt, pr.mergedAt),
    stages,
    reviewed: external.length > 0,
    reviewerCount: new Set(external.map((r) => r.author)).size,
    reviewRounds: external.filter((r) => r.state === "CHANGES_REQUESTED").length + (external.length > 0 ? 1 : 0),
    size: pr.additions + pr.deletions,
  };
}

/** Buckets for the time-to-merge distribution, in hours. `short` fits under a narrow chart axis. */
export const MERGE_BUCKETS = [
  { key: "lt1h", label: "< 1 hour", short: "< 1h", max: 1 },
  { key: "1to4h", label: "1 to 4 hours", short: "1 to 4h", max: 4 },
  { key: "4to24h", label: "4 to 24 hours", short: "4 to 24h", max: 24 },
  { key: "1to3d", label: "1 to 3 days", short: "1 to 3d", max: 72 },
  { key: "3to7d", label: "3 to 7 days", short: "3 to 7d", max: 168 },
  { key: "1to4w", label: "1 to 4 weeks", short: "1 to 4w", max: 672 },
  { key: "gt4w", label: "> 4 weeks", short: "> 4w", max: Number.POSITIVE_INFINITY },
] as const;

export function mergeDistribution(hours: readonly number[]) {
  return MERGE_BUCKETS.map((bucket, i) => {
    const min = i === 0 ? Number.NEGATIVE_INFINITY : MERGE_BUCKETS[i - 1]!.max;
    const count = hours.filter((h) => h >= min && h < bucket.max).length;
    return { key: bucket.key, label: bucket.label, short: bucket.short, count, share: hours.length ? count / hours.length : 0 };
  });
}
