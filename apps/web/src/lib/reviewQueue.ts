import type {
  FeatureGroup,
  QueueEntry,
  RepoQueueSummary,
  ReviewLane,
  ReviewQueue,
  ReviewQueueTiles,
  WaitBand,
} from "@dora-dashboard/core";
import { copy } from "../copy";

const text = copy.reviewQueue;

/** Lane columns in the order they are shown. The held lane only appears when drafts are switched on. */
export const LANE_ORDER: readonly ReviewLane[] = ["no_reviewer", "awaiting_review", "with_author", "approved", "held"];

/** Band order for bars and legends, worst first. */
export const BAND_ORDER: readonly WaitBand[] = ["stale", "overdue", "ageing", "fresh"];

/** Open pull requests untouched for this many days count as idle. Matches the API's definition. */
export const IDLE_FROM_DAYS = 14;

export const isIdle = (entry: Pick<QueueEntry, "idleDays">): boolean => entry.idleDays >= IDLE_FROM_DAYS;

const FAST_LANE_LINES_BELOW = 400;
const FAST_LANE_FILES_BELOW = 10;

const WAITING_LANES: readonly ReviewLane[] = ["no_reviewer", "awaiting_review"];

export const isWaitingLane = (lane: ReviewLane) => WAITING_LANES.includes(lane);

/** A wait in weekday hours. Over 24 hours it is whole weekdays, under that it is whole hours. */
export function formatWait(hours: number): string {
  if (hours >= 24) return text.wait.weekdays(Math.floor(hours / 24));
  if (hours < 1) return text.wait.underHour;
  return text.wait.hours(Math.floor(hours));
}

/** Up to two capital letters from a login, split on dots, dashes, underscores and spaces. "ada-lovelace" gives "AL". */
export function initialsOf(login: string): string {
  const words = login.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]!) : [...(words[0] ?? "")].slice(0, 2);
  return letters.join("").toUpperCase() || "?";
}

/** The parts of a card's single meta line, in order. The wait is left out when a flag pill already states it. */
export function metaParts(entry: QueueEntry, showNames: boolean): string[] {
  const reviewers = entry.requestedReviewers;
  const parts: string[] = [];
  if (!flagFor(entry)) parts.push(text.card.waitingSince(formatWait(entry.waitHours)));
  if (entry.requestedReviewerCount > 0) {
    parts.push(
      showNames && reviewers.length
        ? text.card.waitingOn(reviewers.map((r) => r.name).join(", "))
        : text.card.reviewersRequested(entry.requestedReviewerCount),
    );
  }
  parts.push(text.card.lines(entry.additions, entry.deletions), text.card.files(entry.changedFiles));
  parts.push(text.card.checks[entry.checks].toLowerCase());
  if (isIdle(entry)) parts.push(text.card.idle(entry.idleDays));
  return parts;
}

export interface Flag {
  band: "stale" | "overdue";
  /** For example "Stale, 12 weekdays, no reviewer". */
  label: string;
}

/** The flag for a waiting pull request that is overdue or stale. Others, and every non-waiting lane, have none. */
export function flagFor(entry: Pick<QueueEntry, "lane" | "band" | "waitHours">): Flag | null {
  if (!isWaitingLane(entry.lane)) return null;
  if (entry.band !== "stale" && entry.band !== "overdue") return null;
  const heading = entry.band === "stale" ? text.flag.stale : text.flag.overdue;
  const reason = entry.lane === "no_reviewer" ? text.flag.noReviewer : text.flag.awaitingReview;
  return { band: entry.band, label: `${heading}, ${formatWait(entry.waitHours)}, ${reason}` };
}

export interface QueueFilters {
  /** A reviewer's name, or empty for anyone. */
  waitingOn: string;
  search: string;
  showDrafts: boolean;
  showBots: boolean;
  /** Repository ids to keep. Empty keeps every repository. */
  repoIds: readonly number[];
}

export function matchesSearch(entry: QueueEntry, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const plain = needle.replace(/^#/, "");
  return (
    entry.title.toLowerCase().includes(needle) ||
    entry.repo.toLowerCase().includes(needle) ||
    String(entry.number) === plain ||
    entry.ticketKeys.some((key) => key.toLowerCase().includes(needle))
  );
}

export function filterEntries(entries: readonly QueueEntry[], filters: QueueFilters): QueueEntry[] {
  return entries.filter((entry) => {
    if (!filters.showDrafts && entry.lane === "held") return false;
    if (!filters.showBots && entry.authorIsBot) return false;
    if (filters.repoIds.length && !filters.repoIds.includes(entry.repoId)) return false;
    if (filters.waitingOn && !entry.requestedReviewers.some((r) => r.name === filters.waitingOn)) return false;
    return matchesSearch(entry, filters.search);
  });
}

/** Every reviewer asked on any pull request, sorted, for the "waiting on" choices. */
export function reviewerNames(entries: readonly QueueEntry[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) for (const reviewer of entry.requestedReviewers) names.add(reviewer.name);
  return [...names].sort((a, b) => a.localeCompare(b, "en-GB"));
}

/** Entries grouped into lanes, keeping their order. Lanes not in `lanes` are dropped. */
export function groupByLane(entries: readonly QueueEntry[], lanes: readonly ReviewLane[]): Record<ReviewLane, QueueEntry[]> {
  const groups: Record<ReviewLane, QueueEntry[]> = {
    held: [],
    with_author: [],
    approved: [],
    awaiting_review: [],
    no_reviewer: [],
  };
  for (const entry of entries) if (lanes.includes(entry.lane)) groups[entry.lane].push(entry);
  return groups;
}

export const visibleLanes = (showDrafts: boolean): ReviewLane[] => LANE_ORDER.filter((lane) => showDrafts || lane !== "held");

/** The entries named by `needsAttention`, in its order, that are still in `visible`. Non-waiting entries are ignored. */
export function attentionEntries(
  queue: Pick<ReviewQueue, "needsAttention" | "entries">,
  visible: readonly QueueEntry[],
): QueueEntry[] {
  const byKey = new Map(visible.map((entry) => [entry.key, entry]));
  return queue.needsAttention
    .map((key) => byKey.get(key))
    .filter((entry): entry is QueueEntry => entry !== undefined && isWaitingLane(entry.lane));
}

export interface BandSegment {
  band: WaitBand;
  count: number;
}

/** The non-empty bands of one repository, worst first, for its stacked bar. */
export function bandSegments(summary: Pick<RepoQueueSummary, "bands">): BandSegment[] {
  return BAND_ORDER.map((band) => ({ band, count: summary.bands[band] })).filter((segment) => segment.count > 0);
}

export const waitingCount = (summary: Pick<RepoQueueSummary, "bands">): number =>
  BAND_ORDER.reduce((sum, band) => sum + summary.bands[band], 0);

/** A one-line breakdown of a repository's open pull requests by lane, such as "2 no reviewer, 1 approved". */
export function lanesLine(summary: Pick<RepoQueueSummary, "lanes">): string {
  return LANE_ORDER.filter((lane) => summary.lanes[lane] > 0)
    .map((lane) => `${summary.lanes[lane]} ${text.lanes[lane].title.toLowerCase()}`)
    .join(", ");
}

/** The feature groups that still have at least two members in the visible entries, trimmed to those members. */
export function visibleFeatures(features: readonly FeatureGroup[], visible: readonly QueueEntry[]): FeatureGroup[] {
  const keys = new Set(visible.map((entry) => entry.key));
  return features
    .map((feature) => ({ ...feature, members: feature.members.filter((m) => keys.has(m.key)) }))
    .filter((feature) => feature.members.length >= 2);
}

/**
 * The plain text copied by "Copy summary". With names hidden it carries no author and no reviewer.
 * `entries` are the ones currently shown, so the copy matches the page.
 */
export function summaryText(queue: ReviewQueue, entries: readonly QueueEntry[], showNames: boolean): string {
  const { tiles } = queue;
  const lines = [
    text.summary.heading(tiles.waiting.count, tiles.waiting.repos),
    [
      text.summary.stale(tiles.stale.count),
      text.summary.pastDay(tiles.pastDay.count),
      text.summary.noReviewer(tiles.noReviewer.count),
    ].join(", "),
    "",
    `${text.summary.attention}`,
  ];
  const urgent = attentionEntries(queue, entries);
  if (!urgent.length) lines.push(text.summary.none);
  for (const entry of urgent) {
    const parts = [`${entry.repo}#${entry.number} ${entry.title}`, flagFor(entry)?.label ?? ""];
    if (showNames) {
      if (entry.author) parts.push(text.summary.by(entry.author));
      if (entry.requestedReviewers.length) {
        parts.push(text.summary.waitingOn(entry.requestedReviewers.map((r) => r.name).join(", ")));
      }
    }
    lines.push(`- ${parts.filter(Boolean).join(", ")} ${entry.url}`);
  }
  lines.push("", text.summary.footer);
  return lines.join("\n");
}

const longest = (entries: readonly QueueEntry[]) => (entries.length ? Math.max(...entries.map((e) => e.waitHours)) : null);

/** The headline tiles worked out from the entries shown, so they agree with the filters. Mirrors core's definitions. */
export function tilesFor(entries: readonly QueueEntry[]): ReviewQueueTiles {
  const waiting = entries.filter((e) => isWaitingLane(e.lane));
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
    idle: { count: entries.filter(isIdle).length },
  };
}
