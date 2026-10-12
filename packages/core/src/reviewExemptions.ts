import { isBotLogin } from "./pullRequests.js";
import type { PullRequest, ReviewExemptionDefaults, ReviewExemptionRules } from "./types.js";

/**
 * Which merged pull requests the "merged with no review" figure leaves out because their code was reviewed somewhere
 * else, such as a sync of a shared library that a team already reviewed in its own repository (ADR 0036). A pull request
 * is left out when its title holds one of the repository's words, whole and without case, or when it carries one of
 * the repository's labels. No pattern supplied by a user is ever run, so a rule cannot cause a slow match.
 */

type Frozen<T> = { readonly [K in keyof T]: T[K] extends (infer E)[] ? readonly E[] : Readonly<T[K]> };

/** The title words and the label that apply until a repository overrides them. Frozen, as every caller shares it. */
export const DEFAULT_REVIEW_EXEMPTIONS: Frozen<ReviewExemptionRules> = Object.freeze({
  titleWords: Object.freeze([
    "sync",
    "synced",
    "syncing",
    "synchronise",
    "synchronised",
    "synchronize",
    "synchronized",
    "syncronise",
    "syncronize",
  ]),
  labels: Object.freeze(["reviewed-elsewhere"]),
});

/** The most entries each list may hold, and the most characters one entry may have. */
export const REVIEW_EXEMPTION_LIMITS = Object.freeze({ titleWords: 30, labels: 30, length: 100 } as const);

/**
 * The defaults and the limits in the shape the web reads, as `IssueLabelDefaults` does for issue labels. Frozen, so a
 * caller that wants to change it copies it first.
 */
export const REVIEW_EXEMPTION_DEFAULTS: Frozen<ReviewExemptionDefaults> = Object.freeze({
  titleWords: DEFAULT_REVIEW_EXEMPTIONS.titleWords,
  labels: DEFAULT_REVIEW_EXEMPTIONS.labels,
  limits: REVIEW_EXEMPTION_LIMITS,
});

/** Lower case words made of letters and digits; any other character, punctuation included, ends a word. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

const normaliseLabel = (label: string) => label.trim().toLowerCase();

function holdsPhrase(words: readonly string[], phrase: readonly string[]): boolean {
  for (let start = 0; start + phrase.length <= words.length; start++) {
    if (phrase.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

/**
 * A repository's rules ready to test pull requests against. It can only be built from rules, which it reduces to
 * lower case words and labels itself, and its parts are private, so no caller can hand it labels in another case that
 * would then never match.
 */
export class ExemptionMatcher {
  readonly #phrases: readonly (readonly string[])[];
  readonly #labels: ReadonlySet<string>;

  /** A saved override replaces both default lists, so a list left empty exempts nothing of that kind. */
  constructor(rules: Frozen<ReviewExemptionRules>) {
    this.#phrases = rules.titleWords.map(wordsOf).filter((phrase) => phrase.length > 0);
    this.#labels = new Set(rules.labels.map(normaliseLabel).filter((label) => label !== ""));
  }

  /** True when the title holds one of the words as a whole word, or the pull request has one of the labels. */
  exempts(pr: Pick<PullRequest, "title" | "labels">): boolean {
    const words = wordsOf(pr.title);
    if (this.#phrases.some((phrase) => holdsPhrase(words, phrase))) return true;
    return (pr.labels ?? []).some((label) => this.#labels.has(normaliseLabel(label)));
  }
}

/** The matcher for a repository's rules; `null` or no rules at all means the defaults. */
export function exemptionMatcher(rules?: ReviewExemptionRules | null): ExemptionMatcher {
  return new ExemptionMatcher(rules ?? DEFAULT_REVIEW_EXEMPTIONS);
}

/** True when the title holds one of the words as a whole word, or the pull request has one of the labels. */
export function isReviewExempt(pr: Pick<PullRequest, "title" | "labels">, matcher: ExemptionMatcher): boolean {
  return matcher.exempts(pr);
}

/**
 * True when any account that is not a bot, the author included, submitted a review at or before the merge. A review
 * the author leaves on their own pull request counts, because GitHub holds a review posted by a tool under the author's
 * account exactly as it holds a self-comment. Pending reviews and reviews without a time do not count. A reviewer whose
 * account was deleted counts, since nothing says it was a bot.
 */
export function hasAnyReview(pr: Pick<PullRequest, "reviews" | "mergedAt">): boolean {
  if (pr.mergedAt === null) return false;
  const mergedAt = Date.parse(pr.mergedAt);
  return pr.reviews.some(
    (review) =>
      review.state !== "PENDING" &&
      review.submittedAt !== null &&
      Date.parse(review.submittedAt) <= mergedAt &&
      !(review.authorIsBot ?? isBotLogin(review.author)),
  );
}

/** Merged pull requests with no review at all, how many were left out, and the share of the rest. */
export function unreviewedFigures(
  merged: readonly PullRequest[],
  rules?: ReviewExemptionRules | null,
): { unreviewedCount: number; unreviewedShare: number | null; exemptCount: number } {
  const matcher = exemptionMatcher(rules);
  const counted = merged.filter((pr) => !isReviewExempt(pr, matcher));
  const unreviewedCount = counted.filter((pr) => !hasAnyReview(pr)).length;
  return {
    unreviewedCount,
    unreviewedShare: counted.length === 0 ? null : unreviewedCount / counted.length,
    exemptCount: merged.length - counted.length,
  };
}
