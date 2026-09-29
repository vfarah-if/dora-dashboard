import type { DeployRun, PullRequest, Repo } from "./types.js";
import { doraSummary, productionRuns, type DoraSummary } from "./dora.js";
import { isBot, mergeDistribution, prTimings, type PrTimings } from "./pullRequests.js";
import { mean, median, summarise, weekRange, weekStart, type Summary } from "./stats.js";

export interface ReportOptions {
  from?: string;
  to?: string;
  includeBots?: boolean;
}

export interface WeekRow {
  week: string;
  /** Weeks since the repository's first pull request, so two projects can be aligned on their start. */
  weekIndex: number;
  opened: number;
  merged: number;
  activeAuthors: number;
  mergedPerAuthor: number | null;
  medianOpenToMergeHours: number | null;
  medianCodingHours: number | null;
  /** Mean hours per stage for PRs merged that week; means are used here because they add up to the bar. */
  stages: { coding: number; waitingForReview: number; inReview: number; toMerge: number } | null;
  deploys: number;
  deployFailures: number;
  /**
   * True for a week that had not finished by the end of the range, normally the current week. Charts of a
   * weekly rate leave it off, or a two-day week reads as a collapse in throughput.
   */
  partial: boolean;
  /** Additions plus deletions across PRs merged that week; includes generated and vendored code. */
  linesMerged: number;
}

export interface AuthorRow {
  author: string;
  opened: number;
  merged: number;
  medianOpenToMergeHours: number | null;
  medianCodingHours: number | null;
  reviewsGiven: number;
}

export interface RepoReport {
  repo: Pick<Repo, "id" | "owner" | "name" | "deployWorkflows" | "deployBranch" | "lastCrawledAt">;
  range: { from: string; to: string };
  projectStart: string | null;
  totals: {
    opened: number;
    merged: number;
    stillOpen: number;
    closedUnmerged: number;
    authors: number;
    reviewedShare: number | null;
    selfMergedShare: number | null;
    /** Sum over weeks of distinct people who opened or merged a PR that week. */
    authorWeeks: number;
    mergedPerAuthorWeek: number | null;
    linesMerged: number;
    linesPerAuthorWeek: number | null;
  };
  summary: {
    codingHours: Summary;
    firstReviewHours: Summary;
    openToMergeHours: Summary;
    openToMergeReviewedHours: Summary;
    openToMergeUnreviewedHours: Summary;
    cycleHours: Summary;
    size: Summary;
  };
  dora: DoraSummary;
  weekly: WeekRow[];
  distribution: ReturnType<typeof mergeDistribution>;
  authors: AuthorRow[];
  prs: PrTimings[];
}

const within = (iso: string | null, from: string, to: string) => iso !== null && iso >= from && iso <= to;

export function buildReport(repo: Repo, allPrs: PullRequest[], runs: DeployRun[], options: ReportOptions = {}): RepoReport {
  const prs = options.includeBots ? allPrs : allPrs.filter((p) => !isBot(p));
  const projectStart = prs.map((p) => p.createdAt).sort()[0] ?? null;
  const now = new Date().toISOString();
  const from = options.from ?? projectStart ?? now;
  const to = options.to ? `${options.to.slice(0, 10)}T23:59:59Z` : now;

  const opened = prs.filter((p) => within(p.createdAt, from, to));
  const merged = prs.filter((p) => within(p.mergedAt, from, to));
  const timingsByNumber = new Map(prs.map((p) => [p.number, prTimings(p)]));
  const mergedTimings = merged.map((p) => timingsByNumber.get(p.number)!);
  const production = productionRuns(runs, repo.deployBranch).filter((r) => within(r.createdAt, from, to));

  const weeks = weekRange(weekStart(from), weekStart(to));
  const projectWeek = projectStart ? weekStart(projectStart) : weeks[0]!;
  const rangeEndMs = Date.parse(to) + 1000; // `to` is the last second of the range
  const WEEK_MS = 7 * 86_400_000;
  const weekIndexOf = (week: string) => Math.round((Date.parse(week) - Date.parse(projectWeek)) / WEEK_MS);

  const weekly: WeekRow[] = weeks.map((week) => {
    const openedThisWeek = opened.filter((p) => weekStart(p.createdAt) === week);
    const mergedThisWeek = mergedTimings.filter((t) => weekStart(t.mergedAt!) === week);
    const authors = new Set([...openedThisWeek, ...merged.filter((p) => weekStart(p.mergedAt!) === week)].map((p) => p.author));
    const stageRows = mergedThisWeek.map((t) => t.stages).filter((s) => s !== null);
    const deploysThisWeek = production.filter((r) => weekStart(r.createdAt) === week);
    return {
      week,
      weekIndex: weekIndexOf(week),
      opened: openedThisWeek.length,
      merged: mergedThisWeek.length,
      activeAuthors: authors.size,
      mergedPerAuthor: authors.size ? mergedThisWeek.length / authors.size : null,
      medianOpenToMergeHours: median(mergedThisWeek.map((t) => t.openToMergeHours!)),
      medianCodingHours: median(mergedThisWeek.map((t) => t.codingHours).filter((h) => h !== null)),
      stages: stageRows.length
        ? {
            coding: mean(stageRows.map((s) => s.coding))!,
            waitingForReview: mean(stageRows.map((s) => s.waitingForReview))!,
            inReview: mean(stageRows.map((s) => s.inReview))!,
            toMerge: mean(stageRows.map((s) => s.toMerge))!,
          }
        : null,
      partial: Date.parse(week) + WEEK_MS > rangeEndMs,
      deploys: deploysThisWeek.filter((r) => r.conclusion === "success").length,
      deployFailures: deploysThisWeek.filter((r) => r.conclusion === "failure").length,
      linesMerged: mergedThisWeek.reduce((sum, t) => sum + t.size, 0),
    };
  });

  const authorNames = new Set(opened.map((p) => p.author ?? "unknown"));
  const reviewsGiven = new Map<string, number>();
  for (const pr of prs) {
    for (const r of pr.reviews) {
      if (r.author && r.author !== pr.author && within(r.submittedAt, from, to)) {
        reviewsGiven.set(r.author, (reviewsGiven.get(r.author) ?? 0) + 1);
      }
    }
  }
  const authors: AuthorRow[] = [...authorNames]
    .map((author) => {
      const theirs = mergedTimings.filter((t) => (t.author ?? "unknown") === author);
      return {
        author,
        opened: opened.filter((p) => (p.author ?? "unknown") === author).length,
        merged: theirs.length,
        medianOpenToMergeHours: median(theirs.map((t) => t.openToMergeHours!)),
        medianCodingHours: median(theirs.map((t) => t.codingHours).filter((h) => h !== null)),
        reviewsGiven: reviewsGiven.get(author) ?? 0,
      };
    })
    .sort((a, b) => b.merged - a.merged || b.opened - a.opened);

  const reviewed = mergedTimings.filter((t) => t.reviewed);
  const authorWeeks = weekly.reduce((sum, w) => sum + w.activeAuthors, 0);
  const linesMerged = mergedTimings.reduce((sum, t) => sum + t.size, 0);
  const selfMerged = merged.filter((p) => p.mergedBy !== null && p.mergedBy === p.author);

  return {
    repo: {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      deployWorkflows: repo.deployWorkflows,
      deployBranch: repo.deployBranch,
      lastCrawledAt: repo.lastCrawledAt,
    },
    range: { from, to },
    projectStart,
    totals: {
      opened: opened.length,
      merged: merged.length,
      stillOpen: opened.filter((p) => p.state === "OPEN").length,
      closedUnmerged: opened.filter((p) => p.state === "CLOSED").length,
      authors: authorNames.size,
      reviewedShare: merged.length ? reviewed.length / merged.length : null,
      selfMergedShare: merged.length ? selfMerged.length / merged.length : null,
      authorWeeks,
      mergedPerAuthorWeek: authorWeeks ? merged.length / authorWeeks : null,
      linesMerged,
      linesPerAuthorWeek: authorWeeks ? linesMerged / authorWeeks : null,
    },
    summary: {
      codingHours: summarise(mergedTimings.map((t) => t.codingHours)),
      firstReviewHours: summarise(mergedTimings.map((t) => t.firstReviewHours)),
      openToMergeHours: summarise(mergedTimings.map((t) => t.openToMergeHours)),
      openToMergeReviewedHours: summarise(reviewed.map((t) => t.openToMergeHours)),
      openToMergeUnreviewedHours: summarise(mergedTimings.filter((t) => !t.reviewed).map((t) => t.openToMergeHours)),
      cycleHours: summarise(mergedTimings.map((t) => t.cycleHours)),
      size: summarise(mergedTimings.map((t) => t.size)),
    },
    dora: doraSummary(merged, production, repo.deployBranch, weeks.length),
    weekly,
    distribution: mergeDistribution(mergedTimings.map((t) => t.openToMergeHours!)),
    authors,
    prs: [...opened.map((p) => timingsByNumber.get(p.number)!)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
