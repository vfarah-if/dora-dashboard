import { instant } from "./delivery.js";
import { isBot, isBotLogin } from "./pullRequests.js";
import { REVIEW_MIN_MERGED, type ReviewControls } from "./securityTypes.js";
import type { PullRequest, Review } from "./types.js";

/**
 * How much of what reached the deploy branch was approved by someone other than its author (ADR 0033). It counts
 * merges and never names a person, so it can sit in a security report without breaking ADR 0008.
 */

/** The most unapproved merges listed; `unapproved` still counts them all. */
export const REVIEW_LIST_LIMIT = 50;

const sameLogin = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/** A reviewer is a bot when the host said so, or when it said nothing and the login looks like one. */
const reviewedByBot = (review: Review) => review.authorIsBot ?? isBotLogin(review.author);

/** An approval counts when it was given by another person before the merge. A dismissed approval is not an approval. */
function isApproved(pr: PullRequest, mergedAt: number): boolean {
  return pr.reviews.some(
    (review) =>
      review.state === "APPROVED" &&
      review.submittedAt !== null &&
      instant(review.submittedAt) <= mergedAt &&
      review.author !== null &&
      !sameLogin(review.author, pr.author) &&
      !reviewedByBot(review),
  );
}

export interface ReviewWindow {
  /** Instants, ISO; both ends are included. */
  from: string;
  to: string;
  deployBranch: string;
  /** The instant the report is built at; a window never reaches past it. */
  now: string;
}

/**
 * Merged pull requests whose merge fell in the window, onto the deploy branch, by a person. Approved means a review
 * by someone other than the author, who is not a bot, submitted at or before the merge. It is graded only with at
 * least `REVIEW_MIN_MERGED` merges by more than one author, because a single maintainer cannot approve their own work.
 *
 * Known limit: the crawl stores when a review was submitted but not which commit it covered, so an approval given
 * before later commits were pushed still counts, and a pull request changed after approval reads as approved.
 */
export function reviewControls(prs: readonly PullRequest[], window: ReviewWindow): ReviewControls {
  const start = instant(window.from);
  const end = Math.min(instant(window.to), instant(window.now));
  const merged = prs.filter(
    (pr) =>
      pr.mergedAt !== null &&
      instant(pr.mergedAt) >= start &&
      instant(pr.mergedAt) <= end &&
      pr.baseRef === window.deployBranch &&
      !isBot(pr),
  );
  const authors = new Set(merged.flatMap((pr) => (pr.author === null ? [] : [pr.author.toLowerCase()])));
  const unapproved = merged.filter((pr) => !isApproved(pr, instant(pr.mergedAt!)));
  const listed = [...unapproved]
    .sort((a, b) => instant(b.mergedAt!) - instant(a.mergedAt!) || b.number - a.number)
    .slice(0, REVIEW_LIST_LIMIT)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      mergedAt: pr.mergedAt!,
      selfMerged: sameLogin(pr.mergedBy, pr.author),
    }));
  const tooFew = merged.length < REVIEW_MIN_MERGED;
  const single = authors.size <= 1;
  return {
    from: window.from,
    to: window.to,
    merged: merged.length,
    authors: authors.size,
    unapproved: unapproved.length,
    selfMergedUnapproved: unapproved.filter((pr) => sameLogin(pr.mergedBy, pr.author)).length,
    share: merged.length === 0 ? null : unapproved.length / merged.length,
    graded: !tooFew && !single,
    notGradedBecause: tooFew ? "too_few" : single ? "single_author" : null,
    pullRequests: listed,
  };
}
