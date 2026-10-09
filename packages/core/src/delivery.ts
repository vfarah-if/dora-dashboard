import { hoursBetween } from "./stats.js";
import type { PullRequest } from "./types.js";

/**
 * Helpers shared by the reports that measure delivery from a tracker, the Jira space report and the GitHub issue
 * report (ADR 0021, ADR 0028). Each works on anything with a creation time, so neither report depends on the other.
 */

/** Jira writes `.000Z` and GitHub does not, so instants are always compared as numbers, never as text. */
export const instant = (iso: string) => Date.parse(iso);
export const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The range a report covers, as dates and as milliseconds. */
export interface Range {
  from: string;
  to: string;
  start: number;
  /** The last millisecond of the `to` date, or now when that is earlier. */
  end: number;
  now: number;
}

export interface RangeOptions {
  /** YYYY-MM-DD; defaults to the earliest item's creation. */
  from?: string;
  /** YYYY-MM-DD, inclusive; defaults to `now`. */
  to?: string;
  /** The instant the report is built at, ISO. */
  now: string;
}

export function rangeOf(items: readonly { createdAt: string }[], options: RangeOptions): Range {
  const now = instant(options.now);
  const earliest = items.reduce((min, item) => Math.min(min, instant(item.createdAt)), Infinity);
  const from = options.from?.slice(0, 10) ?? dateOf(items.length ? earliest : now);
  const end = Math.min(instant(`${options.to?.slice(0, 10) ?? dateOf(now)}T23:59:59.999Z`), now);
  return { from, to: dateOf(end), start: instant(`${from}T00:00:00Z`), end, now };
}

/** Hours from an item's creation, never below zero: a ticket raised after the work started waited no time (ADR 0021). */
export function sinceCreated(item: { createdAt: string }, iso: string): number {
  return Math.max(0, hoursBetween(item.createdAt, iso)!);
}

/** A pull request linked to an item, with when it reached production. */
export interface DeliveredPr {
  pr: Pick<PullRequest, "createdAt" | "mergedAt">;
  /** Completion of the deploy that shipped it, paired as DORA lead time pairs it (ADR 0007); null when not shipped. */
  deployedAt: string | null;
}

/** Created to the first linked pull request opened, in hours; null without one. */
export function toFirstPr(item: { createdAt: string }, prs: readonly DeliveredPr[]): number | null {
  if (prs.length === 0) return null;
  const first = prs.reduce((a, b) => (instant(b.pr.createdAt) < instant(a.pr.createdAt) ? b : a));
  return sinceCreated(item, first.pr.createdAt);
}

/** Created to the deploy that shipped the last merged linked pull request; null unless every merged one shipped. */
export function toProduction(item: { createdAt: string }, prs: readonly DeliveredPr[]): number | null {
  const merged = prs.filter((p) => p.pr.mergedAt !== null);
  if (merged.length === 0 || merged.some((p) => p.deployedAt === null)) return null;
  const last = merged.map((p) => p.deployedAt!).sort((a, b) => instant(b) - instant(a))[0]!;
  return sinceCreated(item, last);
}
